import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { map } from 'rxjs';
import type { FeedbackSummary } from '@srisaa/noc-domain';
import { AuthService } from '../../core/auth/auth.service';
import { roleCode } from '../../core/domain/application-rules';
import { LookupService } from '../../core/lookups/lookup.service';
import { DelegationLevel, DeptRole, UserAccount } from '../../core/models';
import { ApplTypeBadge } from '../../shared/ui/appl-type-badge';
import { IconComponent } from '../../shared/ui/icon';
import { StarRating } from '../../shared/ui/star-rating';
import { StatusBadge } from '../../shared/ui/status-badge';
import { ToastService } from '../../shared/ui/toast.service';
import { DeptWorkflowService, MonitorPage, TaskList, TaskRow } from './dept-workflow.service';

/**
 * Department dashboard (legacy modules/dept/applications.aspx + RoleStatuses.txt, now derived from the
 * workflow runs): "My tasks" — the open tasks assigned to the officer, oldest first — and "Monitoring"
 * — every application whose workflow involves the officer, grouped by the stage reached. Both lists
 * are filtered, counted and limited / paged by the server.
 */
@Component({
  selector: 'app-dept-dashboard',
  imports: [ApplTypeBadge, IconComponent, StarRating, StatusBadge, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly auth = inject(AuthService);
  private readonly lookups = inject(LookupService);
  private readonly dept = inject(DeptWorkflowService);
  private readonly toast = inject(ToastService);

  protected readonly session = this.auth.session;
  protected readonly loading = signal(true);

  private readonly me = signal<UserAccount | undefined>(undefined);
  private readonly roles = toSignal(this.lookups.deptRoles$, { initialValue: [] as DeptRole[] });
  /** Rows of "My tasks" the server sends (the oldest; the counts cover every matching task). */
  protected readonly taskLimit = 200;
  protected readonly taskList = signal<TaskList | null>(null);
  protected readonly taskRowsAll = computed<TaskRow[]>(() => this.taskList()?.items ?? []);
  protected readonly taskTotal = computed(() => this.taskList()?.total ?? 0);
  protected readonly monitorPage = signal<MonitorPage | null>(null);

  private readonly stationNames = toSignal(
    this.lookups.fireStations$.pipe(map((d) => new Map(d.flatMap((x) => x.stations.map((s) => [s.id, s.name] as const))))),
    { initialValue: new Map<number, string>() },
  );

  // Filters (both lists; Monitoring is filtered on the server)
  protected readonly text = signal('');
  protected readonly type = signal('');
  protected readonly level = signal<DelegationLevel | ''>('');
  protected readonly stage = signal<string>('');
  protected readonly showCompleted = signal(false);
  /** Decided files of every year (by default the last 12 months when there are many). */
  protected readonly decidedAll = signal(false);
  protected readonly decidedWindow = computed(() => this.monitorPage()?.decided ?? null);
  protected readonly page = signal(1);
  protected readonly pageSize = 50;

  protected readonly roleLabel = computed(() => {
    const me = this.me();
    const role = this.roles().find((r) => r.id === me?.role_id);
    return role ? `${role.code} · ${role.name}` : '';
  });

  protected readonly jurisdiction = computed(() => {
    const me = this.me();
    if (!me) return '';
    if (me.all_stations) return 'All fire stations';
    const names = (me.fire_station_ids ?? []).map((s) => this.stationNames().get(s) ?? String(s));
    return names.length ? `Fire stations: ${names.join(', ')}` : 'No fire station associated';
  });

  /** The rows are filtered by the server. */
  protected readonly taskRows = this.taskRowsAll;

  /** My tasks grouped by the task (one card per kind of work), with the server's count of each. */
  protected readonly taskGroups = computed(() => {
    const counts = new Map((this.taskList()?.groups ?? []).map((g) => [g.name, g.count] as const));
    const groups = new Map<string, TaskRow[]>();
    for (const r of this.taskRows()) groups.set(r.task.name, [...(groups.get(r.task.name) ?? []), r]);
    return [...groups.entries()].map(([name, rows]) => ({ name, rows, count: counts.get(name) ?? rows.length }));
  });

  protected readonly overdueTasks = computed(() => this.taskList()?.overdue ?? 0);

  /** Stage chips (legacy role-status queues) with counts. */
  protected readonly stages = computed(() => this.monitorPage()?.stages ?? []);
  protected readonly monitorRows = computed(() => this.monitorPage()?.items ?? []);
  protected readonly monitorTotal = computed(() => this.monitorPage()?.total ?? 0);
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.monitorTotal() / this.pageSize)));
  protected readonly inProcess = computed(() => this.monitorPage()?.kpis.in_process ?? 0);
  protected readonly processingOverdue = computed(() => this.monitorPage()?.kpis.processing_overdue ?? 0);

  /** Citizen feedback panel (legacy GetAvgRating(months)). */
  protected readonly feedbackMonths = signal<number | null>(null);
  protected readonly feedback = signal<FeedbackSummary | null>(null);
  protected readonly periods: { label: string; months: number | null }[] = [
    { label: 'Last month', months: 1 },
    { label: '3 months', months: 3 },
    { label: '6 months', months: 6 },
    { label: '12 months', months: 12 },
    { label: 'Overall', months: null },
  ];
  protected readonly round = Math.round;

  constructor() {
    this.auth.currentAccount().subscribe((me) => this.me.set(me));
    this.loadFeedback(this.feedbackMonths());
    // My tasks reload whenever a filter changes.
    effect(() => {
      const q = { text: this.text(), type: this.type(), level: this.level(), limit: this.taskLimit };
      untracked(() => this.loadTasks(q));
    });
    // Monitoring reloads whenever a filter or the page changes.
    effect(() => {
      const q = {
        text: this.text(),
        type: this.type(),
        level: this.level(),
        stage: this.stage(),
        includeDecided: this.showCompleted(),
        decidedAll: this.decidedAll(),
        page: this.page(),
        pageSize: this.pageSize,
      };
      untracked(() => this.loadMonitoring(q));
    });
  }

  private loadTasks(q: Parameters<DeptWorkflowService['tasks']>[0]): void {
    this.dept.tasks(q).subscribe({
      next: (list) => {
        this.taskList.set(list);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Could not load the department queues.');
      },
    });
  }

  private loadMonitoring(q: Parameters<DeptWorkflowService['monitoring']>[0]): void {
    this.dept.monitoring(q).subscribe({
      next: (p) => this.monitorPage.set(p),
      error: () => this.toast.error('Could not load the monitoring list.'),
    });
  }

  protected loadFeedback(months: number | null): void {
    this.feedbackMonths.set(months);
    this.dept.feedback(months).subscribe((f) => this.feedback.set(f));
  }

  protected setFilter(which: 'text' | 'type' | 'level' | 'stage', value: string): void {
    this.page.set(1);
    (this[which] as ReturnType<typeof signal<string>>).set(value);
  }

  protected showAllDecided(): void {
    this.page.set(1);
    this.decidedAll.set(true);
  }

  protected toggleCompleted(value: boolean): void {
    this.page.set(1);
    this.decidedAll.set(false);
    this.showCompleted.set(value);
  }

  protected roleOf(roleId: number): string {
    return roleCode(roleId, this.roles());
  }

  protected clearFilters(): void {
    this.page.set(1);
    this.text.set('');
    this.type.set('');
    this.level.set('');
    this.stage.set('');
  }
}
