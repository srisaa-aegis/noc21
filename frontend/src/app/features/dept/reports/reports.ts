import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  LEVEL_NAMES,
  REPORT_LEVELS,
  REPORT_STATUSES,
  REPORT_TYPES,
  TYPE_NAMES,
  type ApplicationListRow,
  type ChallanValues,
  type DistrictRow,
  type FeedbackReportRow,
  type LevelParticulars,
  type OutcomeCounts,
  type OverdueReport,
  type PendencyReport,
  type ReportFilter,
  type ReportType,
  type SmsRow,
  type StatisticsReport,
  type TypeCounts,
} from '@srisaa/noc-domain';
import { AuthService } from '../../../core/auth/auth.service';
import { LookupService } from '../../../core/lookups/lookup.service';
import { DelegationLevel, District, StatusId } from '../../../core/models';
import { statusPresentation } from '../../../shared/status.util';
import { BarChart, ChartSeries } from '../../../shared/charts/bar-chart';
import { IconComponent } from '../../../shared/ui/icon';
import { StarRating } from '../../../shared/ui/star-rating';
import { StatusBadge } from '../../../shared/ui/status-badge';
import { DeptWorkflowService } from '../dept-workflow.service';

type FilterKey = 'level' | 'type' | 'region' | 'status' | 'host' | 'from' | 'to';

export interface ReportDef {
  id: string;
  title: string;
  description: string;
  icon: string;
  filters: FilterKey[];
  legacy: string;
}

export const REPORTS: ReportDef[] = [
  { id: 'pendency', title: 'Pendency', description: 'Files in process by level and type, with whom they are pending and for how long (DG dashboard).', icon: 'bar-chart', filters: ['level', 'region'], legacy: 'dgDashboardReport (Rpt_type 1)' },
  { id: 'statistics', title: 'Statistics', description: 'Applications by type and status, and by approval level.', icon: 'layers', filters: ['level', 'region', 'from', 'to'], legacy: 'statistics_report (Rpt_type 2)' },
  { id: 'consolidated', title: 'Consolidated status', description: 'Approved, returned, rejected and in process per district.', icon: 'list', filters: ['level', 'type', 'region', 'from', 'to'], legacy: 'consolidated_report (Rpt_type 3)' },
  { id: 'applications', title: 'Applications list', description: 'Every block of every application with plot, built-up area, height and fee.', icon: 'file', filters: ['type', 'level', 'region', 'from', 'to'], legacy: 'applications_report (Rpt_type 6)' },
  { id: 'overdue', title: 'Overdue', description: 'Files past the processing SLA per district and type.', icon: 'alert-triangle', filters: ['level', 'region'], legacy: 'applications_overdue (Rpt_type 7)' },
  { id: 'sms', title: 'SMS', description: 'Text messages sent to applicants.', icon: 'bell', filters: ['level', 'from', 'to'], legacy: 'sms_report (Rpt_type 4)' },
  { id: 'feedback', title: 'Feedback rating', description: 'Ratings and remarks given by applicants.', icon: 'star', filters: ['level', 'from', 'to'], legacy: 'feedback_rating (Rpt_type 5)' },
  { id: 'challan', title: 'Challan amount', description: 'NOCs issued, applications received and fees collected per district and type.', icon: 'credit-card', filters: ['level', 'region', 'from', 'to'], legacy: 'reports/rpt_challan' },
  { id: 'district', title: 'District-wise', description: 'Applications per district and type by level, region, status and portal.', icon: 'building', filters: ['level', 'region', 'status', 'host', 'from', 'to'], legacy: 'reports/rpt_district_approved' },
  { id: 'levels', title: 'Level-wise particulars', description: 'Received, approved, rejected, returned and under process per type for each approval level.', icon: 'sliders', filters: ['from', 'to'], legacy: 'reports/rpt_height' },
];

export const TYPE_COLORS: Record<ReportType, string> = { P: '#e8491d', O: '#1a4fb4', R: '#0f8a47', D: '#7421b8' };

/**
 * Department reports (Reports menu). One page per legacy report with its filters, print and CSV
 * export. Computed by the server (SQL over every submitted application) — the page only renders.
 */
@Component({
  selector: 'app-dept-reports',
  imports: [RouterLink, DecimalPipe, BarChart, IconComponent, StatusBadge, StarRating],
  templateUrl: './reports.html',
  styleUrl: './reports.scss',
})
export class Reports {
  private readonly dept = inject(DeptWorkflowService);
  private readonly lookups = inject(LookupService);
  private readonly router = inject(Router);

  /** Route param (withComponentInputBinding). */
  readonly report = input<string>('pendency');

  /**
   * Reports are jurisdictional: a district or station officer sees the files of his fire stations
   * (the server filters); Head Office officers and the monitoring role see every file.
   */
  private readonly account = toSignal(inject(AuthService).currentAccount(), { initialValue: undefined });
  private readonly roles = toSignal(inject(LookupService).deptRoles$, { initialValue: [] });
  protected readonly jurisdictional = computed(() => {
    const me = this.account();
    if (!me || me.portal !== 'dept' || me.all_stations) return false;
    return this.roles().find((r) => r.id === me.role_id)?.code !== 'VIEW';
  });

  protected readonly reports = REPORTS;
  protected readonly types = REPORT_TYPES;
  protected readonly levels = REPORT_LEVELS;
  protected readonly statuses = REPORT_STATUSES;
  protected readonly typeNames = TYPE_NAMES;
  protected readonly levelNames = LEVEL_NAMES;
  protected readonly typeColors = TYPE_COLORS;
  protected readonly now = new Date();

  /** The current report as the server returned it (null while loading). */
  private readonly data = signal<unknown>(null);
  protected readonly loading = signal(true);
  protected readonly exporting = signal(false);
  protected readonly districts = toSignal(this.lookups.districts$, { initialValue: [] as District[] });
  protected readonly regions = toSignal(this.lookups.regions$, { initialValue: [] });

  // filters
  protected readonly level = signal<DelegationLevel | ''>('');
  protected readonly type = signal<ReportType | ''>('');
  protected readonly region = signal('');
  protected readonly status = signal<StatusId | 0>(0);
  protected readonly host = signal<string | undefined>(undefined);
  protected readonly from = signal('');
  protected readonly to = signal('');

  /** District tables: hide the districts without any application (legacy note "missing districts have zero"). */
  protected readonly hideEmpty = signal(true);
  protected readonly districtReport = computed(() => ['consolidated', 'overdue', 'challan', 'district'].includes(this.def().id));

  protected visible<T extends { values: { total: number } | { applied: { total: number } } }>(rows: T[]): T[] {
    if (!this.hideEmpty()) return rows;
    return rows.filter((r) => ('applied' in r.values ? r.values.applied.total : r.values.total) > 0);
  }

  protected readonly def = computed(() => REPORTS.find((r) => r.id === this.report()) ?? REPORTS[0]);
  protected has(f: FilterKey): boolean {
    return this.def().filters.includes(f);
  }

  protected readonly filter = computed<ReportFilter>(() => {
    const d = this.def();
    const on = (k: FilterKey) => d.filters.includes(k);
    return {
      level: on('level') ? this.level() : '',
      type: on('type') ? this.type() : '',
      region: on('region') ? this.region() : '',
      status: on('status') ? this.status() : 0,
      host: on('host') ? this.host() : undefined,
      from: on('from') ? this.from() : '',
      to: on('to') ? this.to() : '',
    };
  });

  protected readonly filterText = computed(() => {
    const f = this.filter();
    const parts: string[] = [];
    if (f.level) parts.push(LEVEL_NAMES[f.level]);
    if (f.type) parts.push(TYPE_NAMES[f.type]);
    if (f.region) parts.push(this.regions().find((r) => r.code === f.region)?.name ?? f.region);
    if (f.status) parts.push(statusPresentation(f.status).label);
    if (f.host !== undefined) parts.push(f.host || 'Fire portal');
    if (f.from || f.to) parts.push(`applied ${f.from || '…'} to ${f.to || '…'}`);
    return parts.length ? parts.join(' · ') : 'All submitted applications';
  });

  // --- report data (from the server) ---------------------------------------------

  private of<T>(id: string): T | null {
    return this.def().id === id ? (this.data() as T | null) : null;
  }

  protected readonly pendency = computed(() => this.of<PendencyReport>('pendency'));
  protected readonly statistics = computed(() => this.of<StatisticsReport>('statistics') ?? EMPTY_STATS);
  protected readonly consolidated = computed(() => this.of<{ rows: DistrictRow<OutcomeCounts>[]; totals: OutcomeCounts }>('consolidated') ?? { rows: [], totals: { approved: 0, returned: 0, rejected: 0, in_process: 0, total: 0 } });
  protected readonly applicationList = computed(() => this.of<{ rows: ApplicationListRow[]; total: number }>('applications')?.rows ?? []);
  protected readonly overdue = computed(() => this.of<OverdueReport>('overdue'));
  protected readonly smsRows = computed(() => this.of<SmsRow[]>('sms') ?? []);
  protected readonly feedback = computed(() => this.of<{ rows: FeedbackReportRow[]; average: number; count: number }>('feedback') ?? { rows: [], average: 0, count: 0 });
  /** Rows of the message / rating lists the server sends for the screen (the CSV has all). */
  protected readonly screenRows = 5000;
  protected readonly challan = computed(() => this.of<{ rows: DistrictRow<ChallanValues>[]; totals: ChallanValues }>('challan') ?? { rows: [], totals: EMPTY_CHALLAN });
  protected readonly districtWise = computed(() => this.of<{ rows: DistrictRow<TypeCounts>[]; totals: TypeCounts }>('district') ?? { rows: [], totals: counts() });
  protected readonly particulars = computed(() => this.of<LevelParticulars[]>('levels') ?? []);

  /** The filter as query parameters (dates ISO). */
  private query(): Record<string, string | number | undefined> {
    const f = this.filter();
    return {
      level: f.level || undefined,
      type: f.type || undefined,
      region: f.region || undefined,
      status: f.status || undefined,
      host: f.host === undefined ? undefined : f.host === '' ? '' : f.host,
      from: f.from || undefined,
      to: f.to || undefined,
    };
  }

  // --- charts -----------------------------------------------------------------

  protected readonly levelCategories = ['Head Office', 'Regional', 'District'];

  protected readonly pendencySeries = computed<ChartSeries[]>(() => {
    const p = this.pendency();
    if (!p) return [];
    return REPORT_TYPES.map((t) => ({ label: TYPE_NAMES[t], color: TYPE_COLORS[t], values: REPORT_LEVELS.map((l) => p.matrix[l][t]) }));
  });

  /** Short status names for the chart axis. */
  protected readonly statusCategories = ['Submitted', 'Inspected', 'ADFS', 'DFS-CD', 'Final appr.', 'Approved', 'Returned', 'Rejected'];
  protected readonly statusSeries = computed<ChartSeries[]>(() => {
    const s = this.statistics();
    return [{ label: 'Applications', color: '#404759', values: REPORT_STATUSES.map((id) => s.totals[id]) }];
  });

  protected readonly statisticsLevelSeries = computed<ChartSeries[]>(() => {
    const s = this.statistics();
    return REPORT_TYPES.map((t) => ({ label: TYPE_NAMES[t], color: TYPE_COLORS[t], values: REPORT_LEVELS.map((l) => s.byLevel[l][t]) }));
  });

  protected readonly consolidatedSeries = computed<ChartSeries[]>(() => {
    const c = this.consolidated().totals;
    return [{ label: 'Applications', color: '#404759', values: [c.approved, c.returned, c.rejected, c.in_process] }];
  });

  constructor() {
    effect(() => {
      const id = this.def().id;
      this.filter();
      untracked(() => this.load(id));
    });
  }

  private load(id: string): void {
    this.loading.set(true);
    this.data.set(null);
    this.dept.report<unknown>(id, this.query()).subscribe({
      next: (d) => {
        if (this.def().id !== id) return;
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /** Files in process of one type (all levels) — the list itself may show only the longest pending. */
  protected typeTotal(p: PendencyReport, type: ReportType): number {
    return REPORT_LEVELS.reduce((n, l) => n + p.matrix[l][type], 0);
  }

  protected statusLabel(id: number): string {
    return statusPresentation(id as StatusId).label;
  }

  protected go(id: string): void {
    this.router.navigate(['/dept/reports', id]);
  }

  protected clear(): void {
    this.level.set('');
    this.type.set('');
    this.region.set('');
    this.status.set(0);
    this.host.set(undefined);
    this.from.set('');
    this.to.set('');
  }

  protected onStatus(v: string): void {
    this.status.set((Number(v) || 0) as StatusId | 0);
  }

  protected onHost(v: string): void {
    this.host.set(v === '*' ? undefined : v);
  }

  protected print(): void {
    window.print();
  }

  /** The server produces the CSV (every row, not only what is on screen). */
  protected exportCsv(): void {
    const id = this.def().id;
    this.exporting.set(true);
    this.dept.reportCsv(id, this.query()).subscribe({
      next: (blob) => {
        this.exporting.set(false);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `noc-${id}-report.csv`;
        a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.exporting.set(false),
    });
  }
}

function counts(): TypeCounts {
  return { P: 0, O: 0, R: 0, D: 0, total: 0 };
}

const EMPTY_STATS: StatisticsReport = {
  rows: [],
  totals: Object.assign({ total: 0 }, ...REPORT_STATUSES.map((s) => ({ [s]: 0 }))),
  byLevel: { MSB: counts(), RFO: counts(), DFO: counts() },
};

const EMPTY_CHALLAN: ChallanValues = { issued: counts(), applied: counts(), amount: counts() };
