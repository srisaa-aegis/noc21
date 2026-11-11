/**
 * Escalations (B3): the SQL detection against the reference implementation,
 * sending, the reminder interval and the log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { asc } from 'drizzle-orm';
import { dueEscalations, overdueItems, type Application, type FormDef, type SlaConfig } from '@srisaa/noc-domain';
import { createDb, type Database } from '../../src/db/client.js';
import * as s from '../../src/db/schema/index.js';
import { loadAggregate } from '../../src/repositories/application.repo.js';
import { toApplication } from '../../src/serializers/application.serializer.js';
import { overdueNotices, preview, send } from '../../src/services/escalation.service.js';
import { api, startTestApi, type TestApi } from '../helpers/app.js';
import { testDatabaseUrl } from '../helpers/db.js';
import { reseed } from '../helpers/reseed.js';

describe('escalations', () => {
  let t: TestApi;
  let db: Database;
  let close: () => Promise<void>;
  const apps: Application[] = [];
  let users: { username: string; displayName: string }[];
  let sla: SlaConfig;
  let forms: FormDef[];
  const now = new Date();

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    ({ db, close } = createDb(testDatabaseUrl(), 4));
    const ids = await db.select({ id: s.applications.id }).from(s.applications).orderBy(asc(s.applications.id));
    for (const { id } of ids) apps.push(toApplication((await loadAggregate(db, id))!));
    users = await db.select({ username: s.users.username, displayName: s.users.displayName }).from(s.users);
    sla = t.app.ctx.cache.data<{ sla: SlaConfig }>('workflow').sla;
    forms = t.app.ctx.cache.data<{ forms: FormDef[] }>('workflow').forms;
  }, 60_000);

  afterAll(async () => {
    await close();
    await t.close();
  });

  it('finds exactly what the reference implementation finds', async () => {
    const expected = overdueItems(apps, sla, forms, users as never, now);
    const actual = (await overdueNotices(db, t.app.ctx.cache, now)).map(({ instance_id: _i, ...n }) => n);
    const key = (n: { appl_id: number; kind: string; task_id: number }) => `${n.appl_id}/${n.kind}/${n.task_id}`;
    expect(actual.map(key).sort()).toEqual(expected.map(key).sort());
    expect(expected.length).toBeGreaterThan(0);
    for (const e of expected) {
      const a = actual.find((x) => key(x) === key(e))!;
      expect({ ...a, officers: [...a.officers].sort(), officer_names: [...a.officer_names].sort(), recipients: [...a.recipients].sort() }).toEqual({
        ...e,
        officers: [...e.officers].sort(),
        officer_names: [...e.officer_names].sort(),
        recipients: [...e.recipients].sort(),
      });
    }
  });

  it('previews, sends once, and does not repeat a reminder inside the interval', async () => {
    const before = await preview(db, t.app.ctx.cache, now);
    expect(before.due.length).toBe(dueEscalations(before.overdue, [], sla, now).length);
    const entry = await send(db, t.app.ctx.cache, 'test', now);
    expect(entry.notices.length).toBe(before.due.length);
    expect(entry.recipients).toBeGreaterThan(0);
    const again = await preview(db, t.app.ctx.cache, new Date(now.getTime() + 60_000));
    expect(again.due).toEqual([]);
    expect(again.last?.notices.length).toBe(entry.notices.length);
    // after the reminder interval everything is due again
    const later = new Date(now.getTime() + (sla.escalation.remind_every_days + 1) * 86_400_000);
    expect((await preview(db, t.app.ctx.cache, later)).due.length).toBeGreaterThan(0);
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const mails = await client.query(`select count(*)::int as n from notification_outbox where template_key = 'escalation'`);
    await client.end();
    expect(mails.rows[0].n).toBe(entry.recipients);
  });

  it('is available to the admin through the API', async () => {
    const admin = await t.login('admin');
    const res = await t.app.inject({ method: 'GET', url: api('/admin/escalations/log'), headers: admin.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
    const officer = await t.login('dg.officer');
    expect((await t.app.inject({ method: 'POST', url: api('/admin/escalations/send'), headers: officer.headers })).statusCode).toBe(403);
  });
});
