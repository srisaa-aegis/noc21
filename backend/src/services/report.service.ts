/**
 * The ten department reports (phase B3), computed in SQL.
 *
 * Each report returns exactly the shape of its reference implementation in
 * @srisaa/noc-domain (`pendencyReport`, `statisticsReport`, …) — the functions
 * the portal used to run in the browser over every application. The parity
 * tests compare the two over the demo data. Only submitted applications are
 * reported.
 *
 * `format=csv` streams the same rows the portal's CSV export produced.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  isProcessingOverdue,
  processingDays,
  REPORT_LEVELS,
  REPORT_STATUSES,
  REPORT_TYPES,
  slaFor,
  TYPE_NAMES,
  toCsv,
  type ApplicationListRow,
  type ChallanValues,
  type DelegationLevel,
  type DistrictRow,
  type FeedbackReportRow,
  type LevelParticulars,
  type OutcomeCounts,
  type OverdueReport,
  type PendencyReport,
  type PendencyRow,
  type ReportType,
  type SlaConfig,
  type SmsRow,
  type StatisticsReport,
  type StatusId,
  type TypeCounts,
  type WorkflowRun,
} from '@srisaa/noc-domain';
import type { ReferenceBundle, WorkflowBundle } from '../cache/bundles.js';
import type { ReferenceCache } from '../cache/reference-cache.js';

import type { Database } from '../db/client.js';
import { notFound } from '../errors/app-error.js';
import { fromDateColumn, timestampToApiDate } from '../lib/dates.js';

export const REPORT_IDS = ['pendency', 'statistics', 'consolidated', 'applications', 'overdue', 'sms', 'feedback', 'challan', 'district', 'levels'] as const;
export type ReportId = (typeof REPORT_IDS)[number];

export interface ReportQuery {
  level?: DelegationLevel | '';
  type?: ReportType | '';
  region?: string;
  status?: number;
  /** '' = Fire portal, 'SDP', 'MAUD'; undefined = all. */
  host?: string;
  from?: string;
  to?: string;
  /** applications list only */
  page?: number;
  pageSize?: number;
  /**
   * The officer's jurisdiction: only files of these fire stations (district and
   * station officers). Undefined = every file (Head Office, monitoring, admin).
   */
  stationIds?: number[];
}

interface Ctx {
  db: Database;
  cache: ReferenceCache;
  now: Date;
}

const typeExpr = sql`(case when at.code = 'RO' then 'R' else at.code end)`;
const IN_PROCESS = sql`s.category in ('submitted', 'in_process')`;

function emptyCounts(): TypeCounts {
  return { P: 0, O: 0, R: 0, D: 0, total: 0 };
}

/** The common filters of every report, over `a` (applications), `at` (types), `s` (statuses), `d` (districts), `rg` (regions). */
function baseWhere(f: ReportQuery, opts: { dates?: boolean; status?: boolean; level?: boolean } = {}): SQL {
  const where: SQL[] = [sql`a.deleted_at is null`, sql`s.category <> 'draft'`];
  if (opts.level !== false && f.level) where.push(sql`a.delegation_level = ${f.level}`);
  if (f.type) where.push(sql`${typeExpr} = ${f.type}`);
  if (opts.status !== false && f.status) where.push(sql`a.status_id = ${f.status}`);
  if (f.host !== undefined) where.push(f.host === '' ? sql`a.host_name is null` : sql`a.host_name = ${f.host}`);
  if (f.region) where.push(sql`rg.code = ${f.region}`);
  if (f.stationIds) where.push(f.stationIds.length ? sql`a.fire_station_id in ${f.stationIds}` : sql`false`);
  if (opts.dates !== false) {
    if (f.from) where.push(sql`a.applied_date >= ${f.from}`);
    if (f.to) where.push(sql`a.applied_date <= ${f.to}`);
    if (f.from || f.to) where.push(sql`a.applied_date is not null`);
  }
  return sql.join(where, sql` and `);
}

const FROM = sql`
  from applications a
  join application_types at on at.id = a.application_type_id
  join statuses s on s.id = a.status_id
  left join districts d on d.id = a.district_id
  left join regions rg on rg.id = d.region_id`;

function districtsOf(c: Ctx, region?: string): { id: number; desc: string }[] {
  const ref = c.cache.data<ReferenceBundle>('reference');
  const districts = ref.districts as { id: number; desc: string }[];
  if (!region) return districts;
  const r = (ref.regions as { code: string; districts: number[] }[]).find((x) => x.code === region);
  return districts.filter((d) => r?.districts.includes(d.id));
}

function slaConfig(c: Ctx): SlaConfig {
  return c.cache.data<WorkflowBundle>('workflow').sla as unknown as SlaConfig;
}

// ---------------------------------------------------------------------------
// 1. Pendency · 5. Overdue
// ---------------------------------------------------------------------------

async function pendencyRows(c: Ctx, f: ReportQuery): Promise<(PendencyRow & { district: number })[]> {
  const rows = await c.db.execute<{
    appl_id: number; appl_number: string | null; revision: number; type: ReportType; level: DelegationLevel; dist_name: string | null; district: number | null;
    site_name: string; build_name: string; site_addr: string; reviewer: string; status_id: number; stage_label: string; since: string | null; applied_date: string | null;
    wf_code: string | null; started_at: Date | null; completed_at: Date | null;
  }>(sql`
    select a.id as appl_id, a.appl_number, a.revision, ${typeExpr} as type, a.delegation_level as level, d.name as dist_name, a.district_id as district,
           a.site_name, a.build_name, a.site_addr, a.reviewer, a.status_id, a.stage_label, a.applied_date::text,
           (select p.at_date::text from process_log p where p.application_id = a.id order by p.step_no desc limit 1) as since,
           wd.code as wf_code, wi.started_at, wi.completed_at
    ${FROM}
    left join wf_instances wi on wi.id = a.current_wf_instance_id
    left join wf_definitions wd on wd.id = wi.definition_id
    where ${baseWhere({ ...f, status: 0 })} and ${IN_PROCESS}
    order by a.id`);
  const sla = slaConfig(c);
  return rows.rows.map((r) => {
    const app = {
      workflow: r.wf_code
        ? ({ definition_code: r.wf_code, started_on: timestampToApiDate(r.started_at), ...(r.completed_at ? { completed_on: timestampToApiDate(r.completed_at) } : {}) } as WorkflowRun)
        : undefined,
    };
    return {
      appl_id: r.appl_id,
      appl_number: r.appl_number ?? '',
      revision: r.revision,
      type: r.type,
      level: r.level,
      dist_name: r.dist_name ?? '',
      district: r.district ?? 0,
      site_name: r.site_name,
      build_name: r.build_name,
      site_addr: r.site_addr,
      pending_with: r.reviewer,
      status_id: r.status_id as StatusId,
      stage_label: r.stage_label ?? '',
      since: fromDateColumn(r.since ?? r.applied_date),
      days: processingDays(app, c.now),
      sla: slaFor(app, sla)?.processing_days ?? null,
      overdue: isProcessingOverdue(app, sla, c.now),
    };
  });
}

/** On screen each type lists its longest-pending files; the counts and the CSV cover all of them. */
export const PENDENCY_SCREEN_ROWS = 500;

export async function pendency(c: Ctx, f: ReportQuery, all = false): Promise<PendencyReport> {
  const rows = await pendencyRows(c, f);
  const matrix = { MSB: emptyCounts(), RFO: emptyCounts(), DFO: emptyCounts() };
  for (const r of rows) {
    matrix[r.level][r.type]++;
    matrix[r.level].total++;
  }
  const plain = rows.map(({ district: _d, ...r }) => r);
  return {
    matrix,
    byType: REPORT_TYPES.map((type) => ({
      type,
      rows: plain
        .filter((r) => r.type === type)
        .sort((x, y) => y.days - x.days)
        .slice(0, all ? undefined : PENDENCY_SCREEN_ROWS),
    })),
    total: rows.length,
    overdue: rows.filter((r) => r.overdue).length,
  };
}

export async function overdue(c: Ctx, f: ReportQuery, all = false): Promise<OverdueReport> {
  const list = (await pendencyRows(c, f)).filter((r) => r.overdue);
  const totals = emptyCounts();
  const rows = districtsOf(c, f.region).map((d) => {
    const v = emptyCounts();
    for (const r of list.filter((x) => x.district === d.id)) {
      v[r.type]++;
      v.total++;
      totals[r.type]++;
      totals.total++;
    }
    return { district: d.id, name: d.desc, values: v };
  });
  const longest = list.map(({ district: _d, ...r }) => r).sort((x, y) => y.days - x.days);
  return { rows, totals, list: all ? longest : longest.slice(0, PENDENCY_SCREEN_ROWS) };
}

// ---------------------------------------------------------------------------
// 2. Statistics · 3. Consolidated · 9. District-wise · 10. Level-wise particulars · 8. Challan
// ---------------------------------------------------------------------------

async function counts(c: Ctx, f: ReportQuery, opts: { status?: boolean; level?: boolean } = {}) {
  const rows = await c.db.execute<{ type: ReportType; level: DelegationLevel; status_id: number; district: number | null; n: string; paid: string; paid_amount: string }>(sql`
    select ${typeExpr} as type, a.delegation_level as level, a.status_id, a.district_id as district,
           count(*)::text as n,
           count(*) filter (where p.status = 'paid')::text as paid,
           coalesce(sum(p.amount) filter (where p.status = 'paid'), 0)::text as paid_amount
    ${FROM}
    left join payments p on p.application_id = a.id
    where ${baseWhere(f, opts)}
    group by 1, 2, 3, 4`);
  return rows.rows.map((r) => ({ ...r, n: Number(r.n), paid: Number(r.paid), paid_amount: Number(r.paid_amount) }));
}

export async function statistics(c: Ctx, f: ReportQuery): Promise<StatisticsReport> {
  const rows = await counts(c, f);
  const totals = { total: 0 } as Record<number, number> & { total: number };
  REPORT_STATUSES.forEach((s) => (totals[s] = 0));
  const byLevel = { MSB: emptyCounts(), RFO: emptyCounts(), DFO: emptyCounts() };
  const out = REPORT_TYPES.map((type) => {
    const byStatus: Record<number, number> = {};
    REPORT_STATUSES.forEach((s) => (byStatus[s] = 0));
    let total = 0;
    for (const r of rows.filter((x) => x.type === type)) {
      byStatus[r.status_id] = (byStatus[r.status_id] ?? 0) + r.n;
      totals[r.status_id] = (totals[r.status_id] ?? 0) + r.n;
      totals.total += r.n;
      byLevel[r.level][type] += r.n;
      byLevel[r.level].total += r.n;
      total += r.n;
    }
    return { type, byStatus, total };
  });
  return { rows: out, totals, byLevel };
}

function outcomeOf(statusId: number): keyof Omit<OutcomeCounts, 'total'> {
  return statusId === 7 ? 'approved' : statusId === 8 ? 'returned' : statusId === 9 ? 'rejected' : 'in_process';
}

export async function consolidated(c: Ctx, f: ReportQuery): Promise<{ rows: DistrictRow<OutcomeCounts>[]; totals: OutcomeCounts }> {
  const rows = await counts(c, f);
  const totals: OutcomeCounts = { approved: 0, returned: 0, rejected: 0, in_process: 0, total: 0 };
  const out = districtsOf(c, f.region).map((d) => {
    const v: OutcomeCounts = { approved: 0, returned: 0, rejected: 0, in_process: 0, total: 0 };
    for (const r of rows.filter((x) => x.district === d.id)) {
      v[outcomeOf(r.status_id)] += r.n;
      v.total += r.n;
      totals[outcomeOf(r.status_id)] += r.n;
      totals.total += r.n;
    }
    return { district: d.id, name: d.desc, values: v };
  });
  return { rows: out, totals };
}

export async function district(c: Ctx, f: ReportQuery): Promise<{ rows: DistrictRow<TypeCounts>[]; totals: TypeCounts }> {
  const rows = await counts(c, f);
  const totals = emptyCounts();
  const out = districtsOf(c, f.region).map((d) => {
    const v = emptyCounts();
    for (const r of rows.filter((x) => x.district === d.id)) {
      v[r.type] += r.n;
      v.total += r.n;
      totals[r.type] += r.n;
      totals.total += r.n;
    }
    return { district: d.id, name: d.desc, values: v };
  });
  return { rows: out, totals };
}

export async function challan(c: Ctx, f: ReportQuery): Promise<{ rows: DistrictRow<ChallanValues>[]; totals: ChallanValues }> {
  const rows = await counts(c, f);
  const totals: ChallanValues = { issued: emptyCounts(), applied: emptyCounts(), amount: emptyCounts() };
  const out = districtsOf(c, f.region).map((d) => {
    const v: ChallanValues = { issued: emptyCounts(), applied: emptyCounts(), amount: emptyCounts() };
    for (const r of rows.filter((x) => x.district === d.id)) {
      for (const target of [v, totals]) {
        target.applied[r.type] += r.n;
        target.applied.total += r.n;
        if (r.status_id === 7) {
          target.issued[r.type] += r.n;
          target.issued.total += r.n;
        }
        target.amount[r.type] += r.paid_amount;
        target.amount.total += r.paid_amount;
      }
    }
    return { district: d.id, name: d.desc, values: v };
  });
  return { rows: out, totals };
}

const LEVEL_TITLES: Record<DelegationLevel, string> = {
  MSB: 'Above 15 m (Head Office)',
  RFO: 'Above 10 m and below 15 m (Regional Fire Officer level)',
  DFO: 'Below 10 m (District Fire Officer level)',
};

export async function levels(c: Ctx, f: ReportQuery): Promise<LevelParticulars[]> {
  const rows = await counts(c, f, { level: false });
  return REPORT_LEVELS.filter((l) => !f.level || l === f.level).map((level) => {
    const mine = rows.filter((r) => r.level === level);
    const out = REPORT_TYPES.map((type) => {
      const t = mine.filter((r) => r.type === type);
      const sum = (pred: (s: number) => boolean) => t.filter((r) => pred(r.status_id)).reduce((n, r) => n + r.n, 0);
      return {
        type,
        received: sum(() => true),
        approved: sum((s) => s === 7),
        rejected: sum((s) => s === 9),
        returned: sum((s) => s === 8),
        under_process: sum((s) => ![1, 7, 8, 9].includes(s)),
      };
    });
    const totals = out.reduce(
      (s, r) => ({
        received: s.received + r.received,
        approved: s.approved + r.approved,
        rejected: s.rejected + r.rejected,
        returned: s.returned + r.returned,
        under_process: s.under_process + r.under_process,
      }),
      { received: 0, approved: 0, rejected: 0, returned: 0, under_process: 0 },
    );
    return { level, title: LEVEL_TITLES[level], rows: out, totals };
  });
}

// ---------------------------------------------------------------------------
// 4. Applications list · 6. SMS · 7. Feedback
// ---------------------------------------------------------------------------

export async function applications(c: Ctx, f: ReportQuery, all = false): Promise<{ rows: ApplicationListRow[]; total: number }> {
  const pageSize = all ? 1_000_000 : Math.min(f.pageSize ?? 1000, 5000);
  const offset = all ? 0 : ((f.page ?? 1) - 1) * pageSize;
  const [rows, total] = await Promise.all([
    c.db.execute<{
      appl_id: number; appl_number: string | null; build_name: string; site_addr: string; type: ReportType; level: DelegationLevel; plot_area: string;
      challan: string | null; status_id: number; block_no: number | null; block_name: string | null; height: string | null; built_area: string | null;
    }>(sql`
      select a.id as appl_id, a.appl_number, a.build_name, a.site_addr, ${typeExpr} as type, a.delegation_level as level, a.plot_area,
             p.amount as challan, a.status_id, b.block_no, b.block_name, b.height,
             (select coalesce(sum(fl.built_area), 0) from block_floors fl where fl.block_id = b.id) as built_area
      ${FROM}
      left join payments p on p.application_id = a.id
      left join blocks b on b.application_id = a.id
      where ${baseWhere(f)}
      order by a.id, b.block_no
      limit ${pageSize} offset ${offset}`),
    c.db.execute<{ n: string }>(sql`select count(*)::text as n ${FROM} left join blocks b on b.application_id = a.id where ${baseWhere(f)}`),
  ]);
  const firstBlock = new Set<number>();
  return {
    total: Number(total.rows[0]?.n ?? 0),
    rows: rows.rows.map((r) => {
      const first = !firstBlock.has(r.appl_id);
      firstBlock.add(r.appl_id);
      const amount = Number(r.challan ?? 0);
      return {
        appl_id: r.appl_id,
        appl_number: r.appl_number ?? '',
        block_name: r.block_no === null ? '—' : (r.block_name ?? ''),
        builder: r.build_name,
        address: r.site_addr,
        type: r.type,
        level: r.level,
        plot_area: Number(r.plot_area) || 0,
        built_area: r.block_no === null ? 0 : Math.round(Number(r.built_area ?? 0) * 100) / 100,
        height: r.block_no === null ? null : Number(r.height) || 0,
        // the fee is reported once per application
        challan: r.block_no === null || first ? amount : 0,
        status_id: r.status_id as StatusId,
      };
    }),
  };
}

/** The lists of messages and ratings show the most recent rows on screen; the CSV has every row. */
export const REPORT_SCREEN_ROWS = 5000;

export async function sms(c: Ctx, f: ReportQuery, all = false): Promise<SmsRow[]> {
  const range: SQL[] = [];
  if (f.from) range.push(sql`m.sent_on >= ${f.from}`);
  if (f.to) range.push(sql`m.sent_on <= ${f.to}`);
  const rows = await c.db.execute<{ appl_id: number; appl_number: string | null; site_name: string; mobile: string; message: string; sent_by: string; sent_on: string | null }>(sql`
    select a.id as appl_id, a.appl_number, a.site_name, a.build_mobile as mobile, m.message, m.sent_by_name as sent_by, m.sent_on::text
    ${FROM}
    join sms_messages m on m.application_id = a.id
    where ${baseWhere({ level: f.level, stationIds: f.stationIds }, { dates: false })} ${range.length ? sql`and ${sql.join(range, sql` and `)}` : sql``}
    order by m.sent_on desc nulls last, a.id, m.sms_no
    ${all ? sql`` : sql`limit ${REPORT_SCREEN_ROWS}`}`);
  return rows.rows.map((r) => ({ ...r, appl_number: r.appl_number ?? '', sent_on: fromDateColumn(r.sent_on) }));
}

export async function feedback(c: Ctx, f: ReportQuery, all = false): Promise<{ rows: FeedbackReportRow[]; average: number; count: number }> {
  const range: SQL[] = [];
  if (f.from) range.push(sql`fb.rated_on >= ${f.from}`);
  if (f.to) range.push(sql`fb.rated_on <= ${f.to}`);
  const where = sql`${baseWhere(f, { dates: false })} and fb.rating >= 1 ${range.length ? sql`and ${sql.join(range, sql` and `)}` : sql``}`;
  // On screen: the most recent ratings (listed by application); the average is over all of them.
  const [rows, avg] = await Promise.all([
    c.db.execute<{ appl_id: number; appl_number: string | null; applicant: string; description: string; rating: number; submitted_on: string | null; level: DelegationLevel }>(sql`
      select * from (
        select a.id as appl_id, a.appl_number, a.build_name as applicant, fb.remarks as description, fb.rating, fb.rated_on::text as submitted_on, a.delegation_level as level
        ${FROM}
        join application_feedback fb on fb.application_id = a.id
        where ${where}
        order by fb.rated_on desc nulls last, a.id desc
        ${all ? sql`` : sql`limit ${REPORT_SCREEN_ROWS}`}
      ) recent order by appl_id`),
    c.db.execute<{ n: string; total: string | null }>(sql`
      select count(*)::text as n, sum(fb.rating)::text as total ${FROM} join application_feedback fb on fb.application_id = a.id where ${where}`),
  ]);
  const out = rows.rows.map((r) => ({ ...r, appl_number: r.appl_number ?? '', submitted_on: fromDateColumn(r.submitted_on) }));
  const n = Number(avg.rows[0]?.n ?? 0);
  const average = n ? Math.round((Number(avg.rows[0]?.total ?? 0) / n) * 100) / 100 : 0;
  return { rows: out, average, count: n };
}

// ---------------------------------------------------------------------------
// Dispatch and CSV
// ---------------------------------------------------------------------------

export async function runReport(db: Database, cache: ReferenceCache, id: string, f: ReportQuery, now = new Date()): Promise<unknown> {
  const c: Ctx = { db, cache, now };
  switch (id as ReportId) {
    case 'pendency':
      return pendency(c, f);
    case 'statistics':
      return statistics(c, f);
    case 'consolidated':
      return consolidated(c, f);
    case 'applications':
      return applications(c, f);
    case 'overdue':
      return overdue(c, f);
    case 'sms':
      return sms(c, f);
    case 'feedback':
      return feedback(c, f);
    case 'challan':
      return challan(c, f);
    case 'district':
      return district(c, f);
    case 'levels':
      return levels(c, f);
    default:
      throw notFound('Report not found.');
  }
}

/** The report as CSV — the same columns the portal's export produced. */
export async function reportCsv(db: Database, cache: ReferenceCache, id: string, f: ReportQuery, now = new Date()): Promise<string> {
  const c: Ctx = { db, cache, now };
  const statusNames = new Map((cache.data<ReferenceBundle>('reference').statuses as { code: number; desc: string }[]).map((s) => [s.code, s.desc]));
  const st = (n: number) => statusNames.get(n) ?? String(n);
  const tn = (t: string) => TYPE_NAMES[t as ReportType] ?? t;
  switch (id as ReportId) {
    case 'pendency': {
      const p = await pendency(c, f, true);
      return toCsv(
        ['Type', 'Level', 'Appl. No.', 'Revision', 'District', 'Building', 'Builder', 'Address', 'Pending with', 'Status', 'Since', 'Days', 'SLA days', 'Overdue'],
        p.byType.flatMap((g) => g.rows.map((r) => [tn(r.type), r.level, r.appl_number, r.revision, r.dist_name, r.site_name, r.build_name, r.site_addr, r.pending_with, st(r.status_id), r.since, r.days, r.sla ?? '', r.overdue ? 'Yes' : 'No'])),
      );
    }
    case 'statistics': {
      const s = await statistics(c, f);
      return toCsv(['Type', ...REPORT_STATUSES.map(st), 'Total'], [...s.rows.map((r) => [tn(r.type), ...REPORT_STATUSES.map((x) => r.byStatus[x]), r.total]), ['Total', ...REPORT_STATUSES.map((x) => s.totals[x]), s.totals.total]]);
    }
    case 'consolidated': {
      const r = await consolidated(c, f);
      return toCsv(
        ['District', 'Approved', 'Returned', 'Rejected', 'In process', 'Total'],
        [...r.rows.map((x) => [x.name, x.values.approved, x.values.returned, x.values.rejected, x.values.in_process, x.values.total]), ['Total', r.totals.approved, r.totals.returned, r.totals.rejected, r.totals.in_process, r.totals.total]],
      );
    }
    case 'applications': {
      const r = await applications(c, f, true);
      return toCsv(
        ['Appl. No.', 'Block', 'Builder', 'Address', 'Type', 'Level', 'Plot area (sq.m)', 'Built-up area (sq.m)', 'Height (m)', 'Challan amount (Rs.)', 'Status'],
        r.rows.map((x) => [x.appl_number, x.block_name, x.builder, x.address, tn(x.type), x.level, x.plot_area, x.built_area, x.height ?? '', x.challan, st(x.status_id)]),
      );
    }
    case 'overdue': {
      const o = await overdue(c, f);
      return toCsv(['District', ...REPORT_TYPES.map(tn), 'Total'], [...o.rows.map((r) => [r.name, ...REPORT_TYPES.map((t) => r.values[t]), r.values.total]), ['Total', ...REPORT_TYPES.map((t) => o.totals[t]), o.totals.total]]);
    }
    case 'sms':
      return toCsv(['Appl. No.', 'Building', 'Mobile', 'Message', 'Sent by', 'Sent on'], (await sms(c, f, true)).map((r) => [r.appl_number, r.site_name, r.mobile, r.message, r.sent_by, r.sent_on]));
    case 'feedback':
      return toCsv(['Appl. No.', 'Applicant', 'Description', 'Rating', 'Submitted on', 'Level'], (await feedback(c, f, true)).rows.map((r) => [r.appl_number, r.applicant, r.description, r.rating, r.submitted_on, r.level]));
    case 'challan': {
      const r = await challan(c, f);
      return toCsv(
        ['District', 'Row', ...REPORT_TYPES.map(tn), 'Total'],
        r.rows.flatMap((x) => [
          [x.name, 'Issued', ...REPORT_TYPES.map((t) => x.values.issued[t]), x.values.issued.total],
          [x.name, 'Applied', ...REPORT_TYPES.map((t) => x.values.applied[t]), x.values.applied.total],
          [x.name, 'Challan (Rs.)', ...REPORT_TYPES.map((t) => x.values.amount[t]), x.values.amount.total],
        ]),
      );
    }
    case 'district': {
      const r = await district(c, f);
      return toCsv(['District', ...REPORT_TYPES.map(tn), 'Total'], [...r.rows.map((x) => [x.name, ...REPORT_TYPES.map((t) => x.values[t]), x.values.total]), ['Total', ...REPORT_TYPES.map((t) => r.totals[t]), r.totals.total]]);
    }
    case 'levels':
      return toCsv(
        ['Level', 'Type', 'Received', 'Approved', 'Rejected', 'Returned (addl. information)', 'Under process'],
        (await levels(c, f)).flatMap((p) => p.rows.map((r) => [p.title, tn(r.type), r.received, r.approved, r.rejected, r.returned, r.under_process])),
      );
    default:
      throw notFound('Report not found.');
  }
}


