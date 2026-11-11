/**
 * The server's SQL reports against their reference implementation — the
 * functions the portal used to run in the browser over every application
 * (@srisaa/noc-domain reports.ts) — over the demo data, for every filter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applicationsReport,
  challanReport,
  consolidatedReport,
  districtReport,
  feedbackReport,
  levelParticularsReport,
  overdueReport,
  pendencyReport,
  smsReport,
  statisticsReport,
  type Application,
  type District,
  type Region,
  type ReportFilter,
  type SlaConfig,
} from '@srisaa/noc-domain';
import { asc } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/client.js';
import * as s from '../../src/db/schema/index.js';
import { loadAggregate } from '../../src/repositories/application.repo.js';
import { toApplication } from '../../src/serializers/application.serializer.js';
import { runReport } from '../../src/services/report.service.js';
import { startTestApi, type TestApi } from '../helpers/app.js';
import { testDatabaseUrl } from '../helpers/db.js';
import { reseed } from '../helpers/reseed.js';

describe('reports: SQL vs the reference implementation', () => {
  let t: TestApi;
  let db: Database;
  let close: () => Promise<void>;
  const apps: Application[] = [];
  let districts: District[];
  let regions: Region[];
  let sla: SlaConfig;
  const now = new Date();

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    ({ db, close } = createDb(testDatabaseUrl(), 4));
    const ids = await db.select({ id: s.applications.id }).from(s.applications).orderBy(asc(s.applications.id));
    for (const { id } of ids) apps.push(toApplication((await loadAggregate(db, id))!));
    const ref = t.app.ctx.cache.data<{ districts: District[]; regions: Region[] }>('reference');
    districts = ref.districts;
    regions = ref.regions;
    sla = t.app.ctx.cache.data<{ sla: SlaConfig }>('workflow').sla;
  }, 60_000);

  afterAll(async () => {
    await close();
    await t.close();
  });

  const run = (id: string, f: ReportFilter) => runReport(db, t.app.ctx.cache, id, { ...f, from: iso(f.from), to: iso(f.to) } as never, now);
  const iso = (d?: string) => d || undefined;
  const filters: ReportFilter[] = [
    {},
    { level: 'MSB' },
    { level: 'RFO' },
    { type: 'O' },
    { region: 'ER' },
    { region: 'SR' },
    { status: 7 },
    { host: '' },
    { from: '2024-01-01' },
    { level: 'DFO', type: 'D' },
  ];

  for (const f of filters) {
    const label = JSON.stringify(f);
    it(`pendency ${label}`, async () => expect(await run('pendency', f)).toEqual(pendencyReport(apps, f, sla, now, regions)));
    it(`statistics ${label}`, async () => expect(await run('statistics', f)).toEqual(statisticsReport(apps, f, regions)));
    it(`consolidated ${label}`, async () => expect(await run('consolidated', f)).toEqual(consolidatedReport(apps, f, districts, regions)));
    it(`overdue ${label}`, async () => expect(await run('overdue', f)).toEqual(overdueReport(apps, f, sla, districts, now, regions)));
    it(`challan ${label}`, async () => expect(await run('challan', f)).toEqual(challanReport(apps, f, districts, regions)));
    it(`district ${label}`, async () => expect(await run('district', f)).toEqual(districtReport(apps, f, districts, regions)));
    it(`levels ${label}`, async () => expect(await run('levels', f)).toEqual(levelParticularsReport(apps, f, regions)));
    it(`applications ${label}`, async () => expect(((await run('applications', f)) as { rows: unknown[] }).rows).toEqual(applicationsReport(apps, f, regions)));
    it(`feedback ${label}`, async () => expect(await run('feedback', f)).toEqual(feedbackReport(apps, f, regions)));
    it(`sms ${label}`, async () => expect(await run('sms', f)).toEqual(smsReport(apps, { level: f.level }, { from: f.from, to: f.to }, regions)));
  }

  it('serves CSV with the portal export columns', async () => {
    const login = await t.login('monitor.hq');
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/dept/reports/statistics?format=csv', headers: login.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.split('\r\n')[0]).toBe('\ufeffType,Submitted,Inspected,Reviewed (ADFS),Reviewed (DFS-CD),Pending Final Approval,Approved / Issued,Returned with Comments,Rejected,Total');
  });

  it('computes a report at most once a minute per filter (N-16), unless asked for a fresh one', async () => {
    const login = await t.login('monitor.hq');
    const get = (q = '') => t.app.inject({ method: 'GET', url: `/api/v1/dept/reports/consolidated${q}`, headers: login.headers });
    const first = await get('?level=MSB');
    const again = await get('?level=MSB');
    expect(again.headers['x-report-computed-at']).toBe(first.headers['x-report-computed-at']);
    expect(again.json()).toEqual(first.json());
    const other = await get('?level=RFO');
    expect(other.json()).not.toEqual(first.json());
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await get('?level=MSB&fresh=true');
    expect(fresh.headers['x-report-computed-at']).not.toBe(first.headers['x-report-computed-at']);
  });

  it('limits a district or station officer to the files of his fire stations; Head Office and monitoring see all', async () => {
    const ids = async (username: string) => {
      const who = await t.login(username);
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/dept/reports/applications?pageSize=5000&fresh=true', headers: who.headers });
      return [...new Set((res.json().rows as { appl_id: number }[]).map((r) => r.appl_id))].filter((id) => id < 200).sort();
    };
    const all = await ids('monitor.hq');
    expect(all.length).toBeGreaterThan(5);
    expect(await ids('dfs.officer')).toEqual(all);
    expect(await ids('dfo.guntur')).toEqual([107]);
    const visakhapatnam = await ids('dfo.visakhapatnam');
    expect(visakhapatnam).toEqual(expect.arrayContaining([101, 102, 106, 110]));
    expect(visakhapatnam).not.toContain(107);
    // the same for the ratings panel of the dashboard
    const guntur = await t.login('dfo.guntur');
    const panel = (await t.app.inject({ method: 'GET', url: '/api/v1/dept/feedback-summary', headers: guntur.headers })).json();
    expect(panel.rows.every((r: { appl_id: number }) => r.appl_id === 107 || r.appl_id >= 200)).toBe(true);
  });

  it('keeps the reports to department users and admins', async () => {
    const citizen = await t.login('citizen1');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/dept/reports/pendency', headers: citizen.headers })).statusCode).toBe(403);
  });
});
