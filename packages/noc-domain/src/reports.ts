/**
 * Department reports (legacy modules/dept/reports.aspx Rpt_type 1-7, partials/dgDashboardReport,
 * consolidated_report, applications_report, applications_overdue, feedback_rating, sms_report and
 * reports/rpt_challan, rpt_district_approved, rpt_height) — pure aggregations over the single
 * application store. Only submitted applications (status > 1) are reported.
 *
 * The server computes the reports in SQL (backend/src/services/report.service.ts);
 * these functions are the reference implementation its parity tests compare against.
 */
import type { Application, DelegationLevel, District, Region, SlaConfig, StatusId } from './models/index.js';
import { blockArea } from './application-rules.js';
import { parseLegacyDate } from './dates.js';
import { isProcessingOverdue, processingDays, slaFor } from './workflow-view.js';

export const REPORT_TYPES = ['P', 'O', 'R', 'D'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_LEVELS: DelegationLevel[] = ['MSB', 'RFO', 'DFO'];

export const TYPE_NAMES: Record<ReportType, string> = { P: 'Provisional', O: 'Occupancy', R: 'Renewal', D: 'Declaration' };
export const LEVEL_NAMES: Record<DelegationLevel, string> = { MSB: 'Head Office (DG / DFS)', RFO: 'Regional (RFO)', DFO: 'District (DFO)' };

export interface ReportFilter {
  level?: DelegationLevel | '';
  type?: ReportType | '';
  /** Region code (ER / SR). */
  region?: string;
  status?: StatusId | 0;
  /** '' = Fire portal, 'SDP', 'MAUD'; undefined = all. */
  host?: string;
  /** Inclusive, on the applied date (ISO yyyy-mm-dd). */
  from?: string;
  to?: string;
}

export type TypeCounts = Record<ReportType, number> & { total: number };

const IN_PROCESS = new Set([2, 3, 4, 5, 6]);

function typeOf(a: Application): ReportType {
  return (a.appl_type === 'RO' ? 'R' : a.appl_type) as ReportType;
}

function emptyCounts(): TypeCounts {
  return { P: 0, O: 0, R: 0, D: 0, total: 0 };
}

function add(c: TypeCounts, a: Application, n = 1): void {
  c[typeOf(a)] += n;
  c.total += n;
}

function isoDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

export function inRegion(a: Pick<Application, 'district'>, region: string | undefined, regions: Region[]): boolean {
  if (!region) return true;
  return !!regions.find((r) => r.code === region)?.districts.includes(Number(a.district));
}

/** Submitted applications matching the common filters. */
export function reportBase(apps: Application[], f: ReportFilter, regions: Region[] = []): Application[] {
  const from = isoDate(f.from);
  const to = isoDate(f.to);
  return apps.filter((a) => {
    if (a.status_id < 2) return false;
    if (f.level && a.delegation_level !== f.level) return false;
    if (f.type && typeOf(a) !== f.type) return false;
    if (f.status && a.status_id !== f.status) return false;
    if (f.host !== undefined && (a.host_name ?? '') !== f.host) return false;
    if (!inRegion(a, f.region, regions)) return false;
    if (from || to) {
      const d = parseLegacyDate(a.applied_date);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
    }
    return true;
  });
}

function lastActionDate(a: Application): string {
  return a.processLog[a.processLog.length - 1]?.at_date ?? a.applied_date;
}

// ---------------------------------------------------------------------------
// 1. Pendency (DG dashboard)
// ---------------------------------------------------------------------------

export interface PendencyRow {
  appl_id: number;
  appl_number: string;
  revision: number;
  type: ReportType;
  level: DelegationLevel;
  dist_name: string;
  site_name: string;
  build_name: string;
  site_addr: string;
  pending_with: string;
  status_id: StatusId;
  stage_label: string;
  since: string;
  days: number;
  sla: number | null;
  overdue: boolean;
}

export interface PendencyReport {
  /** Pending files per level × type (chart). */
  matrix: Record<DelegationLevel, TypeCounts>;
  byType: { type: ReportType; rows: PendencyRow[] }[];
  total: number;
  overdue: number;
}

export function pendencyReport(apps: Application[], f: ReportFilter, sla: SlaConfig, now: Date, regions: Region[] = []): PendencyReport {
  const base = reportBase(apps, { ...f, status: 0 }, regions).filter((a) => IN_PROCESS.has(a.status_id));
  const matrix = { MSB: emptyCounts(), RFO: emptyCounts(), DFO: emptyCounts() };
  const rows: PendencyRow[] = base.map((a) => {
    add(matrix[a.delegation_level], a);
    return {
      appl_id: a.appl_id,
      appl_number: a.appl_number,
      revision: a.revision,
      type: typeOf(a),
      level: a.delegation_level,
      dist_name: a.dist_name,
      site_name: a.site_name,
      build_name: a.build_name,
      site_addr: a.site_addr,
      pending_with: a.reviewer,
      status_id: a.status_id,
      stage_label: a.stage_label ?? '',
      since: lastActionDate(a),
      days: processingDays(a, now),
      sla: slaFor(a, sla)?.processing_days ?? null,
      overdue: isProcessingOverdue(a, sla, now),
    };
  });
  return {
    matrix,
    byType: REPORT_TYPES.map((type) => ({ type, rows: rows.filter((r) => r.type === type).sort((x, y) => y.days - x.days) })),
    total: rows.length,
    overdue: rows.filter((r) => r.overdue).length,
  };
}

// ---------------------------------------------------------------------------
// 2. Statistics (type × status)
// ---------------------------------------------------------------------------

export const REPORT_STATUSES: StatusId[] = [2, 3, 4, 5, 6, 7, 8, 9];

export interface StatisticsReport {
  rows: { type: ReportType; byStatus: Record<number, number>; total: number }[];
  totals: Record<number, number> & { total: number };
  byLevel: Record<DelegationLevel, TypeCounts>;
}

export function statisticsReport(apps: Application[], f: ReportFilter, regions: Region[] = []): StatisticsReport {
  const base = reportBase(apps, f, regions);
  const totals = { total: 0 } as Record<number, number> & { total: number };
  REPORT_STATUSES.forEach((s) => (totals[s] = 0));
  const byLevel = { MSB: emptyCounts(), RFO: emptyCounts(), DFO: emptyCounts() };
  const rows = REPORT_TYPES.map((type) => {
    const byStatus: Record<number, number> = {};
    REPORT_STATUSES.forEach((s) => (byStatus[s] = 0));
    const mine = base.filter((a) => typeOf(a) === type);
    for (const a of mine) {
      byStatus[a.status_id]++;
      totals[a.status_id]++;
      totals.total++;
      add(byLevel[a.delegation_level], a);
    }
    return { type, byStatus, total: mine.length };
  });
  return { rows, totals, byLevel };
}

// ---------------------------------------------------------------------------
// 3. Consolidated status (per district)
// ---------------------------------------------------------------------------

export interface OutcomeCounts {
  approved: number;
  returned: number;
  rejected: number;
  in_process: number;
  total: number;
}

export interface DistrictRow<T> {
  district: number;
  name: string;
  values: T;
}

function outcomeOf(a: Application): keyof Omit<OutcomeCounts, 'total'> {
  return a.status_id === 7 ? 'approved' : a.status_id === 8 ? 'returned' : a.status_id === 9 ? 'rejected' : 'in_process';
}

export function consolidatedReport(apps: Application[], f: ReportFilter, districts: District[], regions: Region[] = []): { rows: DistrictRow<OutcomeCounts>[]; totals: OutcomeCounts } {
  const base = reportBase(apps, f, regions);
  const totals: OutcomeCounts = { approved: 0, returned: 0, rejected: 0, in_process: 0, total: 0 };
  const rows = districts
    .filter((d) => inRegion({ district: d.id }, f.region, regions))
    .map((d) => {
      const v: OutcomeCounts = { approved: 0, returned: 0, rejected: 0, in_process: 0, total: 0 };
      for (const a of base.filter((x) => Number(x.district) === d.id)) {
        v[outcomeOf(a)]++;
        v.total++;
        totals[outcomeOf(a)]++;
        totals.total++;
      }
      return { district: d.id, name: d.desc, values: v };
    });
  return { rows, totals };
}

// ---------------------------------------------------------------------------
// 4. Applications list (one row per block)
// ---------------------------------------------------------------------------

export interface ApplicationListRow {
  appl_id: number;
  appl_number: string;
  block_name: string;
  builder: string;
  address: string;
  type: ReportType;
  level: DelegationLevel;
  plot_area: number;
  built_area: number;
  height: number | null;
  challan: number;
  status_id: StatusId;
}

export function applicationsReport(apps: Application[], f: ReportFilter, regions: Region[] = []): ApplicationListRow[] {
  return reportBase(apps, f, regions).flatMap((a): ApplicationListRow[] => {
    const common = {
      appl_id: a.appl_id,
      appl_number: a.appl_number,
      builder: a.build_name,
      address: a.site_addr,
      type: typeOf(a),
      level: a.delegation_level,
      plot_area: Number(a.plot_area) || 0,
      challan: a.payment.amount,
      status_id: a.status_id,
    };
    if (!a.blocks.length) return [{ ...common, block_name: '—', built_area: 0, height: null }];
    return a.blocks.map((b, i) => ({
      ...common,
      block_name: b.block_name,
      built_area: Math.round(blockArea(b) * 100) / 100,
      height: Number(b.height) || 0,
      // the fee is reported once per application
      challan: i === 0 ? a.payment.amount : 0,
    }));
  });
}

// ---------------------------------------------------------------------------
// 5. Overdue (processing SLA), per district × type
// ---------------------------------------------------------------------------

export interface OverdueReport {
  rows: DistrictRow<TypeCounts>[];
  totals: TypeCounts;
  list: PendencyRow[];
}

export function overdueReport(apps: Application[], f: ReportFilter, sla: SlaConfig, districts: District[], now: Date, regions: Region[] = []): OverdueReport {
  const pend = pendencyReport(apps, f, sla, now, regions);
  const list = pend.byType.flatMap((g) => g.rows).filter((r) => r.overdue);
  const overdueApps = apps.filter((a) => list.some((r) => r.appl_id === a.appl_id));
  const totals = emptyCounts();
  const rows = districts
    .filter((d) => inRegion({ district: d.id }, f.region, regions))
    .map((d) => {
      const v = emptyCounts();
      for (const a of overdueApps.filter((x) => Number(x.district) === d.id)) {
        add(v, a);
        add(totals, a);
      }
      return { district: d.id, name: d.desc, values: v };
    });
  return { rows, totals, list: list.sort((x, y) => y.days - x.days) };
}

// ---------------------------------------------------------------------------
// 6. SMS report
// ---------------------------------------------------------------------------

export interface SmsRow {
  appl_id: number;
  appl_number: string;
  site_name: string;
  mobile: string;
  message: string;
  sent_by: string;
  sent_on: string;
}

export function smsReport(apps: Application[], f: Omit<ReportFilter, 'from' | 'to'>, range: { from?: string; to?: string } = {}, regions: Region[] = []): SmsRow[] {
  const from = isoDate(range.from);
  const to = isoDate(range.to);
  return reportBase(apps, f, regions)
    .flatMap((a) =>
      (a.sms ?? []).map((m) => ({
        appl_id: a.appl_id,
        appl_number: a.appl_number,
        site_name: a.site_name,
        mobile: a.build_mobile,
        message: m.message,
        sent_by: m.sent_by,
        sent_on: m.sent_on,
      })),
    )
    .filter((r) => {
      const d = parseLegacyDate(r.sent_on);
      return (!from || (!!d && d >= from)) && (!to || (!!d && d <= to));
    })
    .sort((x, y) => (parseLegacyDate(y.sent_on)?.getTime() ?? 0) - (parseLegacyDate(x.sent_on)?.getTime() ?? 0));
}

// ---------------------------------------------------------------------------
// 7. Feedback rating report
// ---------------------------------------------------------------------------

export interface FeedbackReportRow {
  appl_id: number;
  appl_number: string;
  applicant: string;
  description: string;
  rating: number;
  submitted_on: string;
  level: DelegationLevel;
}

/**
 * The ratings given by applicants. `count` and `average` cover every rating in
 * the filter; a server may list only the most recent ones in `rows` (the CSV
 * export has all of them).
 */
export function feedbackReport(apps: Application[], f: ReportFilter, regions: Region[] = []): { rows: FeedbackReportRow[]; average: number; count: number } {
  const from = isoDate(f.from);
  const to = isoDate(f.to);
  const rows = reportBase(apps, { ...f, from: undefined, to: undefined }, regions)
    .filter((a) => a.feedback && a.feedback.rating >= 1)
    .filter((a) => {
      const d = parseLegacyDate(a.feedback!.rated_on);
      return (!from || (!!d && d >= from)) && (!to || (!!d && d <= to));
    })
    .map((a) => ({
      appl_id: a.appl_id,
      appl_number: a.appl_number,
      applicant: a.build_name,
      description: a.feedback!.remarks,
      rating: a.feedback!.rating,
      submitted_on: a.feedback!.rated_on,
      level: a.delegation_level,
    }));
  const average = rows.length ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 100) / 100 : 0;
  return { rows, average, count: rows.length };
}

// ---------------------------------------------------------------------------
// 8. Challan amount (per district: NOCs issued, applications applied, fee amount — per type)
// ---------------------------------------------------------------------------

export interface ChallanValues {
  issued: TypeCounts;
  applied: TypeCounts;
  amount: TypeCounts;
}

export function challanReport(apps: Application[], f: ReportFilter, districts: District[], regions: Region[] = []): { rows: DistrictRow<ChallanValues>[]; totals: ChallanValues } {
  const base = reportBase(apps, f, regions);
  const totals: ChallanValues = { issued: emptyCounts(), applied: emptyCounts(), amount: emptyCounts() };
  const rows = districts
    .filter((d) => inRegion({ district: d.id }, f.region, regions))
    .map((d) => {
      const v: ChallanValues = { issued: emptyCounts(), applied: emptyCounts(), amount: emptyCounts() };
      for (const a of base.filter((x) => Number(x.district) === d.id)) {
        add(v.applied, a);
        add(totals.applied, a);
        if (a.status_id === 7) {
          add(v.issued, a);
          add(totals.issued, a);
        }
        if (a.payment.status === 'paid') {
          add(v.amount, a, a.payment.amount);
          add(totals.amount, a, a.payment.amount);
        }
      }
      return { district: d.id, name: d.desc, values: v };
    });
  return { rows, totals };
}

// ---------------------------------------------------------------------------
// 9. District-wise (rpt_district_approved)
// ---------------------------------------------------------------------------

export function districtReport(apps: Application[], f: ReportFilter, districts: District[], regions: Region[] = []): { rows: DistrictRow<TypeCounts>[]; totals: TypeCounts } {
  const base = reportBase(apps, f, regions);
  const totals = emptyCounts();
  const rows = districts
    .filter((d) => inRegion({ district: d.id }, f.region, regions))
    .map((d) => {
      const v = emptyCounts();
      for (const a of base.filter((x) => Number(x.district) === d.id)) {
        add(v, a);
        add(totals, a);
      }
      return { district: d.id, name: d.desc, values: v };
    });
  return { rows, totals };
}

// ---------------------------------------------------------------------------
// 10. Level-wise particulars (rpt_height: Head Office above 15 m, Regional 10-15 m, District below 10 m)
// ---------------------------------------------------------------------------

export interface ParticularsRow {
  type: ReportType;
  received: number;
  approved: number;
  rejected: number;
  returned: number;
  under_process: number;
}

export interface LevelParticulars {
  level: DelegationLevel;
  title: string;
  rows: ParticularsRow[];
  totals: Omit<ParticularsRow, 'type'>;
}

const LEVEL_TITLES: Record<DelegationLevel, string> = {
  MSB: 'Above 15 m (Head Office)',
  RFO: 'Above 10 m and below 15 m (Regional Fire Officer level)',
  DFO: 'Below 10 m (District Fire Officer level)',
};

export function levelParticularsReport(apps: Application[], f: ReportFilter, regions: Region[] = []): LevelParticulars[] {
  const base = reportBase(apps, { ...f, level: '' }, regions);
  return REPORT_LEVELS.filter((l) => !f.level || l === f.level).map((level) => {
    const mine = base.filter((a) => a.delegation_level === level);
    const rows = REPORT_TYPES.map((type) => {
      const t = mine.filter((a) => typeOf(a) === type);
      return {
        type,
        received: t.length,
        approved: t.filter((a) => a.status_id === 7).length,
        rejected: t.filter((a) => a.status_id === 9).length,
        returned: t.filter((a) => a.status_id === 8).length,
        under_process: t.filter((a) => IN_PROCESS.has(a.status_id)).length,
      };
    });
    const totals = rows.reduce(
      (s, r) => ({
        received: s.received + r.received,
        approved: s.approved + r.approved,
        rejected: s.rejected + r.rejected,
        returned: s.returned + r.returned,
        under_process: s.under_process + r.under_process,
      }),
      { received: 0, approved: 0, rejected: 0, returned: 0, under_process: 0 },
    );
    return { level, title: LEVEL_TITLES[level], rows, totals };
  });
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
