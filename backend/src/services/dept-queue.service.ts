/**
 * The department dashboard (phase B3): "My tasks" and "Monitoring", computed
 * in SQL so they stay fast at 100 000 applications a year.
 *
 *   GET /dept/tasks        the officer's open tasks (bounded: tens to hundreds)
 *   GET /dept/monitoring   files the officer may follow — paginated and filtered
 *                          on the server, with the stage chips and the KPIs
 *
 * Days and SLA are computed with the same domain helpers the portal used
 * (`taskDaysPending`, `taskSlaDays`, `processingDays`), so the numbers match.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  isProcessingOverdue,
  processingDays,
  slaFor,
  taskDaysPending,
  taskSlaDays,
  type FeedbackSummary,
  type FormDef,
  type SlaConfig,
  type WorkflowRun,
  type WorkflowStageDef,
  type WorkflowTask,
} from '@srisaa/noc-domain';
import type { ReferenceBundle, WorkflowBundle } from '../cache/bundles.js';
import { config } from '../config/env.js';
import type { Database } from '../db/client.js';
import { forbidden } from '../errors/app-error.js';
import { fromDateColumn, isoDate, timestampToApiDate } from '../lib/dates.js';
import { applicationTextFilter, officerScope, summariesByIds, type SummaryRow } from '../repositories/application.repo.js';
import { toSummaryDto } from '../serializers/application.serializer.js';
import type { ServiceContext } from './shared.js';

type Summary = ReturnType<typeof toSummaryDto> & { stage_label: string };

export interface TaskRow {
  app: Summary;
  task: Pick<WorkflowTask, 'task_id' | 'name' | 'stage_key' | 'task_key' | 'role_id' | 'form' | 'start_date' | 'state'>;
  action: string;
  days: number;
  sla: number;
  overdue: boolean;
  station: string;
}

export interface MonitorRow {
  app: Summary;
  station: string;
  days: number;
  sla: number | null;
  overdue: boolean;
  complete: boolean;
}

export interface MonitorQuery {
  text?: string;
  type?: string;
  level?: string;
  stage?: string;
  includeDecided?: boolean;
  /** With decided files: 'recent' (default) = decided in the last 12 months when there are many; 'all'. */
  decided?: 'recent' | 'all';
  overdueOnly?: boolean;
  page: number;
  pageSize: number;
}

/** Decided files shown by default: the last 12 months, or all of them when there are at most this many (decided after B3). */
export const DECIDED_WINDOW_MONTHS = 12;
export const DECIDED_ALL_UP_TO = 1000;

function slaConfig(c: Pick<ServiceContext, 'cache'>): SlaConfig {
  return c.cache.data<WorkflowBundle>('workflow').sla as unknown as SlaConfig;
}

function forms(c: Pick<ServiceContext, 'cache'>): FormDef[] {
  return c.cache.data<WorkflowBundle>('workflow').forms as FormDef[];
}

function stationNames(c: Pick<ServiceContext, 'cache'>): Map<number, string> {
  const groups = c.cache.data<ReferenceBundle>('reference').fireStations as { stations: { id: number; name: string }[] }[];
  return new Map(groups.flatMap((g) => g.stations.map((st) => [st.id, st.name] as const)));
}

const summary = (row: SummaryRow & { stage_label?: string }): Summary => ({ ...toSummaryDto(row), stage_label: row.stage_label ?? '' });

export interface TaskQuery {
  type?: string;
  level?: string;
  text?: string;
  /** Rows returned (oldest first); the counts cover every matching task. */
  limit: number;
}

export interface TaskList {
  items: TaskRow[];
  /** Matching open tasks (may exceed `items`). */
  total: number;
  /** Matching open tasks past their step SLA. */
  overdue: number;
  /** Matching open tasks per task name (the dashboard groups). */
  groups: { name: string; count: number }[];
}

/**
 * The officer's open tasks, oldest first. Every matching task is read from a
 * lean join (to count and to compute days / SLA); only the returned rows are
 * decorated with the list summary.
 */
export async function myTasks(c: ServiceContext, q: TaskQuery = { limit: 500 }): Promise<TaskList> {
  if (c.user.portal !== 'dept') throw forbidden('Only department officers have tasks.');
  const now = c.now ?? new Date();
  const filters: SQL[] = [];
  if (q.type) filters.push(sql`a.application_type_id in (select id from application_types where code = ${q.type})`);
  if (q.level) filters.push(sql`a.delegation_level = ${q.level}`);
  if (q.text?.trim()) filters.push(await applicationTextFilter(c.db, q.text));
  const rows = await c.db.execute<{
    appl_id: number;
    stage_label: string;
    fire_station_id: number | null;
    task_no: number;
    task_name: string;
    stage_key: string;
    task_key: string;
    role_id: number;
    activated_at: Date | null;
    form_code: string | null;
    wf_code: string;
    version_id: number;
  }>(sql`
    select a.id as appl_id, a.stage_label, a.fire_station_id, t.task_no, t.name as task_name, t.stage_key, t.task_key, t.role_id,
           t.activated_at, f.code as form_code, d.code as wf_code, i.definition_version_id as version_id
      from wf_tasks t
      join wf_instances i on i.id = t.instance_id and i.status = 'running'
      join wf_definitions d on d.id = i.definition_id
      left join wf_forms f on f.id = t.form_id
      join applications a on a.id = i.subject_id and a.current_wf_instance_id = i.id and a.deleted_at is null
     where t.assignee_user_id = ${c.user.id} and t.state = 'active' ${filters.length ? sql`and ${sql.join(filters, sql` and `)}` : sql``}
     order by t.activated_at asc nulls last, t.id asc`);
  const sla = slaConfig(c);
  const fs = forms(c);
  const names = stationNames(c);
  const versionIds = [...new Set(rows.rows.map((r) => Number(r.version_id)))];
  const definitions = new Map<number, { stages: WorkflowStageDef[] }>();
  if (versionIds.length) {
    const defs = await c.db.execute<{ id: number; definition: { stages: WorkflowStageDef[] } }>(
      sql`select id, definition from wf_definition_versions where id in ${versionIds}`,
    );
    for (const d of defs.rows) definitions.set(Number(d.id), d.definition);
  }
  const all = rows.rows.map((r) => {
    const task: TaskRow['task'] = {
      task_id: r.task_no,
      name: r.task_name,
      stage_key: r.stage_key,
      task_key: r.task_key,
      role_id: r.role_id,
      form: r.form_code ?? '',
      start_date: r.activated_at ? timestampToApiDate(r.activated_at) : undefined,
      state: 'active',
    };
    const run = { definition_code: r.wf_code } as WorkflowRun;
    const days = taskDaysPending(task as WorkflowTask, now);
    const limit = taskSlaDays(run, task as WorkflowTask, sla, fs);
    const action =
      definitions.get(Number(r.version_id))?.stages.find((st) => st.key === r.stage_key)?.tasks.find((t) => t.key === r.task_key)?.action_label ?? 'Open';
    return { r, task, action, days, sla: limit, overdue: days > limit };
  });
  const page = all.slice(0, q.limit);
  const summaries = new Map((await summariesByIds(c.db, page.map((x) => Number(x.r.appl_id)))).map((x) => [Number(x.appl_id), x]));
  const groups = new Map<string, number>();
  for (const x of all) groups.set(x.task.name, (groups.get(x.task.name) ?? 0) + 1);
  return {
    items: page
      .filter((x) => summaries.has(Number(x.r.appl_id)))
      .map((x) => ({
        app: summary({ ...summaries.get(Number(x.r.appl_id))!, stage_label: x.r.stage_label }),
        task: x.task,
        action: x.action,
        days: x.days,
        sla: x.sla,
        overdue: x.overdue,
        station: names.get(Number(x.r.fire_station_id)) ?? String(x.r.fire_station_id ?? ''),
      })),
    total: all.length,
    overdue: all.filter((x) => x.overdue).length,
    groups: [...groups.entries()].map(([name, count]) => ({ name, count })),
  };
}

/** The visibility rule of the Monitoring list, as SQL over `a` (applications) and `i` (its current run). */
async function monitoringScope(c: ServiceContext): Promise<SQL> {
  if (c.user.portal === 'admin') return sql`true`;
  if (c.user.portal !== 'dept') throw forbidden('Only department officers can see the department queue.');
  const scope = await officerScope(c.db, c.user.id);
  if (!scope) throw forbidden('Your account is not configured as a department officer.');
  if (scope.monitoring) return sql`true`;
  const stations = scope.allStations ? sql`true` : scope.stationIds.length ? sql`a.fire_station_id in ${scope.stationIds}` : sql`false`;
  // Uncorrelated IN-subqueries: PostgreSQL hashes each once (the officer's
  // instances, his role's workflow versions) instead of probing per row.
  return sql`(i.id in (select t.instance_id from wf_tasks t where t.assignee_user_id = ${c.user.id})
              or (i.definition_version_id in (select r.version_id from wf_version_roles r where r.role_id = ${scope.roleId}) and ${stations}))`;
}

/** Days since the run started, in calendar days of the portal's time zone (legacy `daysSince`). */
const processingDaysSql = (now: Date) => {
  const tz = config().APP_TIMEZONE;
  return sql`((coalesce(i.completed_at, ${now.toISOString()}::timestamptz) at time zone ${tz})::date - (i.started_at at time zone ${tz})::date)`;
};

export async function monitoring(
  c: ServiceContext,
  q: MonitorQuery,
): Promise<{
  items: MonitorRow[];
  total: number;
  page: number;
  pageSize: number;
  stages: { label: string; count: number }[];
  kpis: { in_process: number; processing_overdue: number };
  /** When decided files are included: the months they go back (null = all of them) and how many there are in all. */
  decided: { window_months: number | null; total: number } | null;
}> {
  const now = c.now ?? new Date();
  const PROCESSING_DAYS = processingDaysSql(now);
  const scope = await monitoringScope(c);
  const base: SQL[] = [sql`a.deleted_at is null`, sql`a.status_id > 1`, scope];
  const filters: SQL[] = [];
  if (q.type) filters.push(sql`a.application_type_id in (select id from application_types where code in ${q.type === 'R' ? ['R', 'RO'] : [q.type]})`);
  if (q.level) filters.push(sql`a.delegation_level = ${q.level}`);
  if (!q.includeDecided) filters.push(sql`i.completed_at is null`);
  if (q.overdueOnly) filters.push(sql`i.completed_at is null and ${PROCESSING_DAYS} > coalesce(p.total_days, 100000)`);
  if (q.text?.trim()) filters.push(await applicationTextFilter(c.db, q.text));
  const stageExpr = sql`coalesce(nullif(a.stage_label, ''), 'Submitted')`;
  // Filter, count and sort on the lean join; the summary view decorates one page only.
  const from = sql`
      from wf_instances i
      join applications a on a.id = i.subject_id and a.current_wf_instance_id = i.id
      left join wf_sla_policies p on p.definition_id = i.definition_id`;
  const where = (extra: SQL[]) => sql.join([...base, ...extra], sql` and `);

  // Decided files: those of the last 12 months, unless there are few (or all were asked for).
  let decided: { window_months: number | null; total: number } | null = null;
  if (q.includeDecided) {
    const n = await c.db.execute<{ n: string }>(sql`select count(*)::text as n ${from} where ${where([...filters, sql`i.completed_at is not null`])}`);
    const total = Number(n.rows[0]?.n ?? 0);
    const windowed = q.decided !== 'all' && total > DECIDED_ALL_UP_TO;
    if (windowed) {
      const since = new Date(now);
      since.setMonth(since.getMonth() - DECIDED_WINDOW_MONTHS);
      filters.push(sql`(i.completed_at is null or i.completed_at >= ${since.toISOString()}::timestamptz)`);
    }
    decided = { window_months: windowed ? DECIDED_WINDOW_MONTHS : null, total };
  }
  const listFilters = q.stage ? [...filters, sql`${stageExpr} = ${q.stage}`] : filters;
  const matches = filters.length ? sql.join(filters, sql` and `) : sql`true`;
  const open = sql`i.completed_at is null`;

  // Files in process: longest pending first. Decided files (on request): most recently decided first.
  const order = q.includeDecided
    ? sql`(i.completed_at is not null), case when i.completed_at is null then i.started_at end asc, i.completed_at desc, a.id desc`
    : sql`i.started_at asc, a.id desc`;
  // Two statements: the page, and one pass that yields the stage chips (the
  // filtered files per stage), the list total and the KPIs (every file in process).
  const [page, agg] = await Promise.all([
    c.db.execute<{ id: number; wf_code: string; started_at: Date; completed_at: Date | null; stage_label: string }>(sql`
      select a.id, a.stage_label, d.code as wf_code, i.started_at, i.completed_at
      ${from}
      join wf_definitions d on d.id = i.definition_id
      where ${where(listFilters)}
      order by ${order}
      limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
    c.db.execute<{ label: string; n: string; in_process: string; overdue: string; first_status: number }>(sql`
      select ${stageExpr} as label, min(a.status_id) as first_status,
             count(*) filter (where ${matches})::text as n,
             count(*) filter (where ${open})::text as in_process,
             count(*) filter (where ${open} and ${PROCESSING_DAYS} > coalesce(p.total_days, 100000))::text as overdue
      ${from}
      where ${where([sql`(${open} or (${matches}))`])}
      group by 1`),
  ]);
  const stageRows = agg.rows
    .map((r) => ({ label: r.label, count: Number(r.n), first: Number(r.first_status), in_process: Number(r.in_process), overdue: Number(r.overdue) }))
    .sort((x, y) => x.first - y.first || x.label.localeCompare(y.label));
  const stages = stageRows.filter((r) => r.count > 0).map(({ label, count }) => ({ label, count }));
  const total = q.stage ? (stages.find((st) => st.label === q.stage)?.count ?? 0) : stages.reduce((n, st) => n + st.count, 0);
  const kpis = {
    in_process: stageRows.reduce((n, r) => n + r.in_process, 0),
    processing_overdue: stageRows.reduce((n, r) => n + r.overdue, 0),
  };
  const summaries = new Map((await summariesByIds(c.db, page.rows.map((r) => Number(r.id)))).map((r) => [Number(r.appl_id), r]));
  const items = {
    rows: page.rows
      .filter((r) => summaries.has(Number(r.id)))
      .map((r) => ({ ...summaries.get(Number(r.id))!, stage_label: r.stage_label, wf_code: r.wf_code, started_at: r.started_at, completed_at: r.completed_at })),
  };

  const sla = slaConfig(c);
  const names = stationNames(c);
  return {
    items: items.rows.map((r) => {
      const run = {
        definition_code: r.wf_code,
        started_on: timestampToApiDate(r.started_at),
        ...(r.completed_at ? { completed_on: timestampToApiDate(r.completed_at) } : {}),
      } as WorkflowRun;
      const app = { workflow: run };
      return {
        app: summary(r),
        station: names.get(Number(r.fire_station_id)) ?? String(r.fire_station_id ?? ''),
        days: processingDays(app, now),
        sla: slaFor(app, sla)?.processing_days ?? null,
        overdue: isProcessingOverdue(app, sla, now),
        complete: !!r.completed_at,
      };
    }),
    total,
    page: q.page,
    pageSize: q.pageSize,
    stages,
    kpis,
    decided,
  };
}

/**
 * Average citizen rating over the last `months` months (legacy Feedback_AvgRating.aspx),
 * in the shape of `feedbackSummary()` of @srisaa/noc-domain (its reference implementation).
 */
export async function feedbackSummary(
  db: Database,
  months: number | null,
  now: Date = new Date(),
  level?: string,
  /** Only files of these fire stations (the officer's jurisdiction); undefined = every file. */
  stationIds?: number[],
): Promise<FeedbackSummary> {
  const since = months == null ? null : new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  const where = sql.join(
    [
      sql`a.deleted_at is null`,
      sql`f.rating between 1 and 5`,
      ...(since ? [sql`f.rated_on >= ${isoDate(since)}`, sql`f.rated_on <= ${isoDate(now)}`] : []),
      ...(level ? [sql`a.delegation_level = ${level}`] : []),
      ...(stationIds ? [stationIds.length ? sql`a.fire_station_id in ${stationIds}` : sql`false`] : []),
    ],
    sql` and `,
  );
  const [agg, recent] = await Promise.all([
    db.execute<{ rating: number; n: string }>(sql`
      select f.rating, count(*)::text as n from application_feedback f join applications a on a.id = f.application_id
       where ${where} group by f.rating`),
    db.execute<{ appl_id: number; appl_number: string | null; site_name: string; build_name: string; delegation_level: string; rating: number; remarks: string; rated_on: string | null }>(sql`
      select a.id as appl_id, a.appl_number, a.site_name, a.build_name, a.delegation_level, f.rating, f.remarks, f.rated_on::text
        from application_feedback f join applications a on a.id = f.application_id
       where ${where} order by f.rated_on desc nulls last, f.id desc limit 50`),
  ]);
  const distribution = [1, 2, 3, 4, 5].map((star) => Number(agg.rows.find((r) => r.rating === star)?.n ?? 0));
  const count = distribution.reduce((x, y) => x + y, 0);
  const sum = distribution.reduce((x, n, i) => x + n * (i + 1), 0);
  return {
    average: count ? Math.round((sum / count) * 100) / 100 : 0,
    count,
    distribution,
    rows: recent.rows.map((r) => ({
      appl_id: r.appl_id,
      appl_number: r.appl_number ?? '',
      site_name: r.site_name,
      build_name: r.build_name,
      delegation_level: r.delegation_level as FeedbackSummary['rows'][number]['delegation_level'],
      rating: r.rating,
      remarks: r.remarks,
      rated_on: fromDateColumn(r.rated_on),
    })),
  };
}
