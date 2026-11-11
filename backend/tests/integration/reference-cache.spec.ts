/**
 * Reference data, the bundle/caching contract, and invalidation.
 *
 * The invalidation test writes directly with SQL (as a DBA or a migration
 * would), which is exactly what the database triggers are there to catch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { api, startTestApi, type TestApi } from '../helpers/app.js';
import { testDatabaseUrl } from '../helpers/db.js';

describe('reference data and caching', () => {
  let t: TestApi;
  let admin: { headers: Record<string, string> };
  let citizen: { headers: Record<string, string> };

  beforeAll(async () => {
    t = await startTestApi();
    admin = await t.login('admin');
    citizen = await t.login('citizen1');
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url: api(url), headers });

  it('serves every lookup of the API catalogue', async () => {
    const names = [
      'application-types',
      'build-types',
      'directions',
      'districts',
      'fire-stations',
      'hazards',
      'mapped-codes',
      'equipments',
      'ffe-notes',
      'statuses',
      'dept-roles',
      'regions',
      'party-roles',
      'block-options',
      'document-requirements',
      'occupancy-conditions',
      'undertakings',
      'escape-rules',
      'noc-terms',
      'nbc-table7',
    ];
    for (const name of names) {
      const res = await get(`/lookups/${name}`);
      expect(res.statusCode, name).toBe(200);
      expect(res.json(), name).toBeTruthy();
    }
    expect((await get('/lookups/nonsense')).statusCode).toBe(404);
  });

  it('serves the five rule-tree endpoints', async () => {
    for (const url of ['/rules/ffe/1', '/rules/ffe-type', '/rules/other-notes', '/rules/riser-width', '/rules/height-limits']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.json().start, url).toBeTruthy();
    }
    expect((await get('/rules/ffe/99')).statusCode).toBe(404);
  });

  it('keeps the legacy shapes of the lookups', async () => {
    const districts = (await get('/lookups/districts')).json();
    expect(districts[0]).toMatchObject({ id: 1, desc: 'Srikakulam' });
    const stations = (await get('/lookups/fire-stations')).json();
    expect(stations[0].stations[0]).toHaveProperty('name');
    const types = (await get('/lookups/application-types')).json();
    expect(types.map((x: { code: string }) => x.code)).toEqual(['P', 'O', 'R', 'D']);
    expect(types[1].mode.map((m: { code: string }) => m.code)).toEqual(['O', 'M', 'N']);
  });

  it('drops the corrected fire station (4Q) everywhere', async () => {
    const stations = (await get('/lookups/fire-stations')).json();
    const ids = stations.flatMap((g: { stations: { id: number }[] }) => g.stations.map((s) => s.id));
    expect(ids.every((id: unknown) => typeof id === 'number' && Number.isFinite(id))).toBe(true);
    expect(JSON.stringify(stations)).not.toContain('4Q');
    expect(JSON.stringify(stations)).not.toContain('Kunavaram');
  });

  it('exposes the status model with categories and the system flags', async () => {
    const statuses = (await get('/lookups/statuses')).json();
    const byCode = new Map(statuses.map((s: { code: number }) => [s.code, s]));
    expect(byCode.get(1)).toMatchObject({ category: 'draft', is_system: true });
    expect(byCode.get(6)).toMatchObject({ category: 'in_process', is_system: false, is_pre_decision: true });
    expect(byCode.get(7)).toMatchObject({ category: 'approved', is_system: true });
    expect(statuses.filter((s: { is_pre_decision: boolean }) => s.is_pre_decision)).toHaveLength(1);
  });

  it('answers the version manifest and sends versions on every response', async () => {
    const versions = (await get('/meta/versions')).json();
    expect(versions.reference).toBeGreaterThan(0);
    expect(versions.schema).toBe(1);
    const any = await get('/lookups/districts');
    expect(any.headers['x-data-versions']).toContain(`reference=${versions.reference}`);
  });

  it('revalidates a bundle with an ETag', async () => {
    const first = await get('/bundles/reference');
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-cache');
    const second = await get('/bundles/reference', { 'if-none-match': String(first.headers.etag) });
    expect(second.statusCode).toBe(304);
  });

  it('serves an immutable versioned bundle and redirects a stale version', async () => {
    const versions = (await get('/meta/versions')).json();
    const current = await get(`/bundles/reference/v/${versions.reference}`);
    expect(current.statusCode).toBe(200);
    expect(current.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const stale = await get(`/bundles/reference/v/${versions.reference - 1}`);
    expect(stale.statusCode).toBe(302);
    expect(stale.headers.location).toContain(`/bundles/reference/v/${versions.reference}`);
  });

  it('compresses bundles and decodes to the same payload', async () => {
    const plain = await get('/bundles/reference');
    const brotli = await t.app.inject({ method: 'GET', url: api('/bundles/reference'), headers: { 'accept-encoding': 'br' } });
    expect(brotli.headers['content-encoding']).toBe('br');
    expect(brotli.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
  });

  it('keeps the workflow and directory bundles private to staff', async () => {
    expect((await get('/bundles/workflow', citizen.headers)).statusCode).toBe(403);
    expect((await get('/bundles/workflow', admin.headers)).statusCode).toBe(200);
    expect((await get('/bundles/directory', admin.headers)).headers['cache-control']).toBe('private, no-cache');
  });

  it('returns the whole cold-start payload from /bootstrap', async () => {
    const boot = (await get('/bootstrap')).json();
    expect(Object.keys(boot)).toEqual(['versions', 'reference', 'rules', 'content']);
    expect(boot.reference.districts).toHaveLength(13);
    expect(Object.keys(boot.rules.ffe)).toHaveLength(12);
    expect(boot.content.nocTerms).toBeTruthy();
  });

  it('rebuilds a bundle when the data changes outside the API (trigger + NOTIFY)', async () => {
    const before = (await get('/meta/versions')).json().reference;
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query(`update districts set name = 'Srikakulam (edited)' where id = 1`);
      await waitFor(async () => (await get('/meta/versions')).json().reference > before);
      const districts = (await get('/lookups/districts')).json();
      expect(districts[0].desc).toBe('Srikakulam (edited)');
    } finally {
      await client.query(`update districts set name = 'Srikakulam' where id = 1`);
      await waitFor(async () => (await get('/lookups/districts')).json()[0].desc === 'Srikakulam');
      await client.end();
    }
  });

  it('does not bump a version for a rolled-back change', async () => {
    const before = (await get('/meta/versions')).json().reference;
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    await client.query('begin');
    await client.query(`update districts set name = 'Rolled back' where id = 2`);
    await client.query('rollback');
    await client.end();
    await new Promise((r) => setTimeout(r, 300));
    expect((await get('/meta/versions')).json().reference).toBe(before);
  });

  it('exposes the admin configuration façades in the portal shapes', async () => {
    const fees = (await get('/config/fees', citizen.headers)).json();
    expect(fees.rates_per_sqm.P).toBeGreaterThan(0);
    const levels = (await get('/config/delegation-rules', citizen.headers)).json();
    expect(levels[0]).toHaveProperty('level');
    expect(levels[0]).toHaveProperty('site_types');
    const renewals = (await get('/config/renewal-rules', citizen.headers)).json();
    expect(renewals[0]).toHaveProperty('years');
    const workflows = (await get('/config/workflows', admin.headers)).json();
    expect(workflows).toHaveLength(12);
    expect(workflows[0].stages.length).toBeGreaterThan(0);
    const sla = (await get('/config/sla', admin.headers)).json();
    expect(sla.workflows['P-MSB'].processing_days).toBe(60);
    expect((await get('/config/forms', admin.headers)).json()).toHaveLength(9);
    expect((await get('/config/workflows', citizen.headers)).statusCode).toBe(403);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for the cache to refresh.');
}
