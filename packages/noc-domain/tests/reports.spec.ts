import { fixture } from './fixtures.js';
import { Application, District, Region, SlaConfig } from '../src/models/index.js';
import {
  applicationsReport,
  challanReport,
  consolidatedReport,
  districtReport,
  feedbackReport,
  levelParticularsReport,
  overdueReport,
  pendencyReport,
  reportBase,
  smsReport,
  statisticsReport,
  toCsv,
} from '../src/reports.js';

/** Totals reconcile with the seeded application store (11 submitted applications). */
describe('department reports (aggregations over the application store)', () => {
  const apps = fixture<Application[]>('assets/data/applications/applications.json');
  const districts = fixture<District[]>('assets/data/lookups/districts.json');
  const regions = fixture<Region[]>('assets/data/lookups/regions.json');
  const sla = fixture<SlaConfig>('assets/data/config/sla.json');
  const now = new Date(2026, 10, 7);
  const submitted = apps.filter((a) => a.status_id > 1);

  it('reports only submitted applications and applies level, type, status, region, portal and date filters', () => {
    expect(reportBase(apps, {}).length).toBe(submitted.length);
    expect(submitted.length).toBe(11);
    expect(reportBase(apps, { level: 'MSB' }).map((a) => a.appl_id).sort()).toEqual([101, 102, 103, 106, 109, 110]);
    expect(reportBase(apps, { type: 'R' }).map((a) => a.appl_id).sort()).toEqual([106, 114]);
    expect(reportBase(apps, { status: 7 }).length).toBe(4);
    // Eastern Region = districts 1-6: only the Guntur declaration (district 7) is outside it
    expect(reportBase(apps, { region: 'ER' }, regions).length).toBe(10);
    expect(reportBase(apps, { region: 'SR' }, regions).map((a) => a.appl_id)).toEqual([107]);
    expect(reportBase(apps, { host: 'SDP' }).map((a) => a.appl_id)).toEqual([111]);
    expect(reportBase(apps, { host: '' }).length).toBe(9);
    expect(reportBase(apps, { from: '2022-01-01' }).map((a) => a.appl_id).sort()).toEqual([107, 108, 109, 110, 114]);
    expect(reportBase(apps, { from: '2016-01-01', to: '2016-12-31' }).map((a) => a.appl_id).sort()).toEqual([101, 103]);
  });

  it('pendency (DG dashboard): files in process per level × type, with the processing SLA', () => {
    const p = pendencyReport(apps, {}, sla, now, regions);
    expect(p.total).toBe(5);
    expect(p.matrix.MSB).toEqual({ P: 1, O: 2, R: 1, D: 0, total: 4 });
    expect(p.matrix.RFO).toEqual({ P: 1, O: 0, R: 0, D: 0, total: 1 });
    expect(p.matrix.DFO.total).toBe(0);
    expect(p.overdue).toBe(4); // everything except 110 (applied Oct 2026)
    const occupancy = p.byType.find((g) => g.type === 'O')!.rows;
    expect(occupancy.map((r) => r.appl_id)).toEqual([102, 110]); // longest pending first
    expect(occupancy.find((r) => r.appl_id === 110)).toMatchObject({ pending_with: 'Director of Fire Services (HQ)', overdue: false, sla: 60 });
  });

  it('statistics: type × status and level × type', () => {
    const s = statisticsReport(apps, {});
    expect(s.totals.total).toBe(11);
    expect(s.rows.map((r) => [r.type, r.total])).toEqual([['P', 4], ['O', 4], ['R', 2], ['D', 1]]);
    expect(s.totals[7]).toBe(4);
    expect(s.rows.find((r) => r.type === 'P')!.byStatus).toMatchObject({ 3: 1, 4: 1, 7: 1, 9: 1 });
    expect(s.byLevel.RFO).toEqual({ P: 1, O: 2, R: 1, D: 0, total: 4 });
  });

  it('consolidated status per district', () => {
    const c = consolidatedReport(apps, {}, districts, regions);
    expect(c.rows.length).toBe(13);
    expect(c.rows.find((r) => r.name === 'Visakhapatnam')!.values).toEqual({ approved: 1, returned: 0, rejected: 0, in_process: 4, total: 5 });
    expect(c.rows.find((r) => r.name === 'Krishna')!.values).toEqual({ approved: 2, returned: 1, rejected: 1, in_process: 0, total: 4 });
    expect(c.totals).toEqual({ approved: 4, returned: 1, rejected: 1, in_process: 5, total: 11 });
    expect(consolidatedReport(apps, { level: 'MSB' }, districts).totals.total).toBe(6);
    expect(consolidatedReport(apps, { region: 'SR' }, districts, regions).rows.map((r) => r.district)).toEqual([7, 8, 9, 10, 11, 12, 13]);
  });

  it('applications list: one row per block, the fee counted once per application', () => {
    const rows = applicationsReport(apps, {});
    expect(rows.length).toBe(13); // 101 and 102 have two blocks; the declaration has none
    expect(rows.filter((r) => r.appl_id === 101).map((r) => r.block_name)).toEqual(['Block A', 'Club House']);
    expect(rows.find((r) => r.appl_id === 107)!.block_name).toBe('—');
    expect(rows.reduce((s, r) => s + r.challan, 0)).toBe(submitted.reduce((s, a) => s + a.payment.amount, 0));
  });

  it('overdue: files past the processing SLA per district × type', () => {
    const o = overdueReport(apps, {}, sla, districts, now, regions);
    expect(o.list.map((r) => r.appl_id).sort()).toEqual([102, 106, 108, 109]);
    expect(o.rows.find((r) => r.name === 'Visakhapatnam')!.values).toEqual({ P: 1, O: 1, R: 1, D: 0, total: 3 });
    expect(o.rows.find((r) => r.name === 'Srikakulam')!.values.total).toBe(1);
    expect(o.totals.total).toBe(4);
    expect(overdueReport(apps, { level: 'RFO' }, sla, districts, now).totals.total).toBe(1);
  });

  it('SMS and feedback reports', () => {
    const sms = smsReport(apps, {});
    expect(sms.length).toBe(4);
    expect(sms[0]).toMatchObject({ appl_id: 109, sent_on: '08-Feb-2024' });
    expect(smsReport(apps, {}, { from: '2024-01-01' }).length).toBe(2);
    const fb = feedbackReport(apps, {});
    expect(fb.rows.map((r) => r.rating).sort()).toEqual([2, 4, 5]);
    expect(fb.average).toBe(3.67);
    expect(fb.count).toBe(3); // every rating in the filter (a server may list only the most recent)
    expect(feedbackReport(apps, { level: 'RFO' }).rows.map((r) => r.appl_id)).toEqual([114]);
  });

  it('challan amount: issued / applied / fee per district and type', () => {
    const c = challanReport(apps, {}, districts);
    expect(c.totals.applied.total).toBe(11);
    expect(c.totals.issued.total).toBe(4);
    expect(c.totals.amount).toEqual({ P: 514500, O: 389827, R: 46300, D: 2000, total: 952627 });
    expect(c.rows.find((r) => r.name === 'Krishna')!.values.issued).toEqual({ P: 0, O: 1, R: 1, D: 0, total: 2 });
  });

  it('district-wise by status and portal', () => {
    expect(districtReport(apps, { status: 7 }, districts).totals).toEqual({ P: 1, O: 1, R: 1, D: 1, total: 4 });
    expect(districtReport(apps, { host: 'MAUD' }, districts).rows.find((r) => r.values.total)!.name).toBe('Srikakulam');
  });

  it('level-wise particulars (Head Office / Regional / District)', () => {
    const [msb, rfo, dfo] = levelParticularsReport(apps, {});
    expect(msb.rows.find((r) => r.type === 'P')).toEqual({ type: 'P', received: 3, approved: 1, rejected: 1, returned: 0, under_process: 1 });
    expect(msb.totals).toEqual({ received: 6, approved: 1, rejected: 1, returned: 0, under_process: 4 });
    expect(rfo.rows.find((r) => r.type === 'O')).toEqual({ type: 'O', received: 2, approved: 1, rejected: 0, returned: 1, under_process: 0 });
    expect(dfo.totals.received).toBe(1);
    expect(levelParticularsReport(apps, { level: 'RFO' }).map((p) => p.level)).toEqual(['RFO']);
  });

  it('exports CSV with quoting', () => {
    expect(toCsv(['a', 'b'], [[1, 'x, y'], ['say "hi"', null]])).toBe('a,b\r\n1,"x, y"\r\n"say ""hi""",');
  });
});
