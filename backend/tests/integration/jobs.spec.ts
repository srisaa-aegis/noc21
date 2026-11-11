/**
 * Housekeeping jobs (B3): file retention (B2-9), token cleanup, and the
 * scheduler's "once a day at the configured hour" logic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../../src/config/env.js';
import { createDb, type Database } from '../../src/db/client.js';
import { cleanupTokens, purgeAudit, purgeFiles } from '../../src/jobs/maintenance.js';
import { jobs, tick } from '../../src/jobs/scheduler.js';
import { startTestApi, type TestApi } from '../helpers/app.js';
import { testDatabaseUrl } from '../helpers/db.js';
import { caller, uploader } from '../helpers/journey.js';
import { reseed } from '../helpers/reseed.js';

describe('jobs', () => {
  let t: TestApi;
  let db: Database;
  let close: () => Promise<void>;
  let client: pg.Client;

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    ({ db, close } = createDb(testDatabaseUrl(), 4));
    client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await close();
    await t.close();
  });

  it('purges a replaced draft document 30 days after it stopped being used, and keeps the live one', async () => {
    const call = caller(t);
    const upload = uploader(t);
    const citizen = await t.login('citizen1');
    const draft = (await call('POST', '/applications', citizen, { appl_type: 'P', site_name: 'Purge Towers', site_addr: 'Old Files Road' })).json().application;
    const first = (await upload(`/applications/${draft.appl_id}/documents`, citizen, { code: 'SelfDeclaration' }, 'first.pdf')).json().application;
    const firstId = first.documents.find((d: { code: string }) => d.code === 'SelfDeclaration').file_id;
    const second = (await upload(`/applications/${draft.appl_id}/documents`, citizen, { code: 'SelfDeclaration' }, 'second.pdf')).json().application;
    const secondId = second.documents.find((d: { code: string }) => d.code === 'SelfDeclaration').file_id;
    const keyOf = async (id: string) => (await client.query(`select storage_key from files where id = $1`, [id])).rows[0].storage_key as string;
    const firstPath = join(config().FS_STORAGE_ROOT, await keyOf(firstId));
    expect(existsSync(firstPath)).toBe(true);

    // not yet: it was replaced just now
    expect((await purgeFiles(db)).purged).toBe(0);
    await client.query(`update files set created_at = now() - interval '40 days' where id in ($1, $2)`, [firstId, secondId]);
    await client.query(`update application_documents set deleted_at = now() - interval '31 days' where file_id = $1`, [firstId]);
    const result = await purgeFiles(db);
    expect(result.purged).toBe(1);
    expect(existsSync(firstPath)).toBe(false);
    expect((await client.query(`select deleted_at from files where id = $1`, [firstId])).rows[0].deleted_at).not.toBeNull();
    expect(existsSync(join(config().FS_STORAGE_ROOT, await keyOf(secondId)))).toBe(true);
  });

  it('deletes expired tokens', async () => {
    await t.login('citizen2');
    await client.query(`update refresh_tokens set expires_at = now() - interval '10 days' where user_id = (select id from users where username = 'citizen2')`);
    const r = await cleanupTokens(db);
    expect(r.refresh).toBeGreaterThan(0);
  });

  it('keeps the audit trail for 3 months (decided after B3); otherwise it cannot be changed', async () => {
    await client.query(`insert into audit_log (at, action, entity_type, entity_id, summary) values
      (now() - interval '4 months', 'test.old', 'test', '1', 'old'), (now() - interval '2 months', 'test.recent', 'test', '2', 'recent')`);
    await expect(client.query(`delete from audit_log where action = 'test.old'`)).rejects.toThrow(/append-only/);
    const r = await purgeAudit(db);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const left = await client.query(`select action from audit_log where action like 'test.%'`);
    expect(left.rows.map((x) => x.action)).toEqual(['test.recent']);
  });

  it('runs each daily job once a day, from its hour on', async () => {
    const cache = t.app.ctx.cache;
    const escalations = jobs(db, cache).find((j) => j.name === 'escalations')!;
    const at = (iso: string) => new Date(iso);
    // 09:00 IST = 03:30 UTC
    expect(escalations.due(at('2026-03-10T03:00:00Z'), null)).toBe(false);
    expect(escalations.due(at('2026-03-10T03:31:00Z'), null)).toBe(true);
    expect(escalations.due(at('2026-03-10T10:00:00Z'), at('2026-03-10T03:31:00Z'))).toBe(false);
    expect(escalations.due(at('2026-03-11T03:31:00Z'), at('2026-03-10T03:31:00Z'))).toBe(true);

    const log = { info: () => undefined, error: () => undefined, warn: () => undefined } as never;
    await client.query('delete from job_runs');
    const now = at('2026-12-01T06:00:00Z');
    const ran = await tick(db, cache, log, now);
    expect(ran).toEqual(expect.arrayContaining(['escalations', 'purge-files', 'cleanup-tokens', 'purge-audit']));
    expect(await tick(db, cache, log, new Date(now.getTime() + 60_000))).toEqual([]);
    const runs = await client.query(`select job_name, status from job_runs order by id`);
    expect(runs.rows.every((r) => r.status === 'succeeded')).toBe(true);
  });
});
