import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startTestApi, type TestApi } from '../helpers/app.js';
import { reseed } from '../helpers/reseed.js';

describe('applications (read)', () => {
  let t: TestApi;
  let citizen1: { headers: Record<string, string> };
  let citizen2: { headers: Record<string, string> };
  let dfo: { headers: Record<string, string> };
  let monitor: { headers: Record<string, string> };
  let admin: { headers: Record<string, string> };

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    citizen1 = await t.login('citizen1');
    citizen2 = await t.login('citizen2');
    dfo = await t.login('dfo.visakhapatnam');
    monitor = await t.login('monitor.hq');
    admin = await t.login('admin');
  });
  afterAll(async () => {
    await t.close();
  });

  const get = (url: string, who: { headers: Record<string, string> }) => t.app.inject({ method: 'GET', url: api(url), headers: who.headers });

  it('lists only the signed-in citizen’s applications', async () => {
    const res = await get('/applications?scope=mine&pageSize=all', citizen1);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((a: { owner: string }) => a.owner === 'citizen1')).toBe(true);
    expect(body.total).toBe(body.items.length);
  });

  it('returns the flat summary fields the dashboard needs', async () => {
    const body = (await get('/applications?scope=mine', citizen1)).json();
    const row = body.items.find((a: { appl_id: number }) => a.appl_id === 101);
    // Numbers follow the (re-dated) submission month: yyyymm + sequence.
    expect(row.appl_number).toMatch(/^\d{6}0001$/);
    expect(row).toMatchObject({
      appl_id: 101,
      appl_type: 'P',
      status_id: 7,
      dist_name: 'Visakhapatnam',
      delegation_level: 'MSB',
      challan_paid: true,
    });
    expect(row.built_area).toBeGreaterThan(0);
    expect(row.flr_count).toBeGreaterThan(0);
    expect(row.height).toBeGreaterThan(0);
  });

  it('filters by type, status and free text', async () => {
    expect((await get('/applications?scope=mine&type=O', citizen1)).json().items.every((a: { appl_type: string }) => a.appl_type === 'O')).toBe(true);
    expect((await get('/applications?scope=mine&statusId=7', citizen1)).json().items.every((a: { status_id: number }) => a.status_id === 7)).toBe(true);
    const search = (await get('/applications?scope=mine&q=Padma', citizen1)).json();
    // The Provisional and the Occupancy NOC of the same site both match.
    expect(search.items.map((a: { appl_id: number }) => a.appl_id).sort()).toEqual([101, 102]);
    expect(search.items.every((a: { site_name: string }) => a.site_name.includes('Padma'))).toBe(true);
  });

  it('paginates', async () => {
    const page1 = (await get('/applications?scope=mine&page=1&pageSize=2', citizen1)).json();
    const page2 = (await get('/applications?scope=mine&page=2&pageSize=2', citizen1)).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThan(2);
    expect(page1.items[0].appl_id).not.toBe(page2.items[0].appl_id);
  });

  it('returns the full aggregate to its owner', async () => {
    const res = await get('/applications/101', citizen1);
    expect(res.statusCode).toBe(200);
    const app = res.json();
    expect(app.appl_number).toMatch(/^\d{6}0001$/);
    expect(app.blocks).toHaveLength(2);
    expect(app.blocks[0].floors.length).toBeGreaterThan(0);
    expect(app.blocks[0].ffe.items.length).toBeGreaterThan(0);
    expect(app.parties).toHaveLength(5);
    expect(app.workflow.definition_code).toBe('P-MSB');
    expect(app.payment.status).toBe('paid');
    expect(res.headers.etag).toMatch(/^"r\d+"$/);
  });

  it('hides the officers’ note content from the citizen but keeps the stages', async () => {
    const citizenView = (await get('/applications/101', citizen1)).json();
    const deptView = (await get('/applications/101', admin)).json();
    expect(citizenView.workflow.stages.length).toBeGreaterThan(0);
    expect(citizenView.workflow.tasks[0].remarks).toBe('');
    expect(citizenView.workflow.tasks[0].data).toEqual({});
    expect(deptView.workflow.tasks[0].remarks.length).toBeGreaterThan(0);
  });

  it('does not let a citizen read another citizen’s application', async () => {
    const res = await get('/applications/101', citizen2);
    expect(res.statusCode).toBe(404);
    expect(res.json().detail).toBe('Application not found.');
  });

  it('does not expose drafts to the department queue', async () => {
    const queue = (await get('/applications?scope=dept&pageSize=all', dfo)).json();
    expect(queue.items.every((a: { status_id: number }) => a.status_id > 1)).toBe(true);
  });

  it('scopes the department queue to the officer’s fire stations', async () => {
    const queue = (await get('/applications?scope=dept&pageSize=all', dfo)).json();
    expect(queue.items.length).toBeGreaterThan(0);
    // The Visakhapatnam DFO must not see the Krishna/Guntur files.
    expect(queue.items.every((a: { dist_name: string }) => a.dist_name === 'Visakhapatnam')).toBe(true);
  });

  it('lets the monitoring role see every submitted application', async () => {
    const all = (await get('/applications?scope=dept&pageSize=all', monitor)).json();
    const districts = new Set(all.items.map((a: { dist_name: string }) => a.dist_name));
    expect(districts.size).toBeGreaterThan(1);
  });

  it('refuses the admin search to non-admins and includes drafts for admins', async () => {
    expect((await get('/applications?scope=all', citizen1)).statusCode).toBe(403);
    expect((await get('/applications?scope=all', dfo)).statusCode).toBe(403);
    const all = (await get('/applications?scope=all&pageSize=all', admin)).json();
    expect(all.items.some((a: { status_id: number }) => a.status_id === 1)).toBe(true);
    expect(all.items[0].days_idle).toBeGreaterThanOrEqual(0);
  });

  it('supports the admin drafts-only and idle filters', async () => {
    const drafts = (await get('/applications?scope=all&draftsOnly=true&pageSize=all', admin)).json();
    expect(drafts.items.every((a: { status_id: number }) => a.status_id === 1)).toBe(true);
    const stale = (await get('/applications?scope=all&idleDays=180&pageSize=all', admin)).json();
    expect(stale.items.length).toBeGreaterThan(0);
  });

  it('computes the assessment on the server (fee, level, renewal period, issues)', async () => {
    const res = await get('/applications/101/assessment', citizen1);
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.fee.total).toBeGreaterThan(0);
    expect(a.approvalLevel).toBe('MSB');
    expect(a.renewalYears).toBeGreaterThan(0);
    expect(a.errorCount).toBe(0);
    expect(Object.keys(a.ruleVersions).length).toBeGreaterThan(10);
  });

  it('reports the deliberate open-space shortfall of the rejected application', async () => {
    const res = await get('/applications/103/validation', citizen1);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.issues.filter((i: { severity: string }) => i.severity === 'error')).toHaveLength(4);
  });

  it('serves the certificate facts for an issued NOC', async () => {
    const res = await get('/applications/101/certificate/certificate', citizen1);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.application.appl_id).toBe(101);
    expect(body.nocTerms).toBeTruthy();
    expect(body.renewalYears).toBeGreaterThan(0);
  });

  it('returns the process log and revisions', async () => {
    const log = (await get('/applications/101/process-log', citizen1)).json();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]).toHaveProperty('action');
    expect((await get('/applications/101/revisions', citizen1)).statusCode).toBe(200);
  });

  it('answers 404 for an unknown application and 401 without a token', async () => {
    expect((await get('/applications/999999', admin)).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: api('/applications/101') })).statusCode).toBe(401);
  });

  it('refuses writes from the wrong portal', async () => {
    const res = await t.app.inject({ method: 'POST', url: api('/applications'), headers: dfo.headers, payload: { appl_type: 'P', site_name: 'x', site_addr: 'y' } });
    expect(res.statusCode).toBe(403);
  });
});
