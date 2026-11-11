/**
 * Read-only views over a workflow run as the NOC portal presents it.
 *
 * Transitions are NOT here: they live in the backend workflow engine
 * (@srisaa/workflow-engine, phase B2). This module only derives what the API
 * and the UI need to *display*: the current row of each task, the active
 * stage, "pending with", SLA counters, queues and the Declaration level.
 *
 * Ported from the browser implementation (frontend core/domain/workflow.ts)
 * so that the values shown by the portal do not change.
 */
import type {
  Application,
  DelegationLevel,
  DeptRole,
  FormDef,
  SlaConfig,
  UserAccount,
  WorkflowDefinition,
  WorkflowOutcome,
  WorkflowRun,
  WorkflowStageDef,
  WorkflowTask,
  WorkflowTaskDef,
} from './models/index.js';
import { daysSince, parseLegacyDate } from './dates.js';

export function workflowCode(applType: string, level: DelegationLevel): string {
  return `${applType === 'RO' ? 'R' : applType}-${level}`;
}

export function findDefinition(
  defs: WorkflowDefinition[],
  applType: string,
  level: DelegationLevel,
): WorkflowDefinition | undefined {
  return defs.find((d) => d.code === workflowCode(applType, level));
}

export function taskDefOf(stages: WorkflowStageDef[], stageKey: string, taskKey: string): WorkflowTaskDef | undefined {
  return stages.find((s) => s.key === stageKey)?.tasks.find((t) => t.key === taskKey);
}

export function finalStageIndex(stages: WorkflowStageDef[]): number {
  return stages.length - 1;
}

/** The latest row of every task (send back and re-inspection append new rows). */
export function currentTasks(run: WorkflowRun): WorkflowTask[] {
  const latest = new Map<string, WorkflowTask>();
  for (const t of run.tasks) {
    const k = `${t.stage_key}/${t.task_key}`;
    const prev = latest.get(k);
    if (!prev || t.task_id > prev.task_id) latest.set(k, t);
  }
  return [...latest.values()].sort((a, b) => a.task_id - b.task_id);
}

export function stageTasks(run: WorkflowRun, stageKey: string): WorkflowTask[] {
  return currentTasks(run).filter((t) => t.stage_key === stageKey);
}

export function activeTasks(run: WorkflowRun): WorkflowTask[] {
  return currentTasks(run).filter((t) => t.state === 'active');
}

/** Index of the stage in progress (-1 when the run is complete). */
export function activeStageIndex(run: WorkflowRun): number {
  const active = new Set(activeTasks(run).map((t) => t.stage_key));
  return run.stages.findIndex((s) => active.has(s.key));
}

export function isFinalTask(run: WorkflowRun, task: WorkflowTask): boolean {
  return run.stages[finalStageIndex(run.stages)]?.key === task.stage_key;
}

export function roleCode(roleId: number, roles: DeptRole[]): string {
  return roles.find((r) => r.id === roleId)?.code ?? String(roleId);
}

/** "Pending with" text (the legacy reviewer column). */
export function pendingWith(run: WorkflowRun | undefined, roles: DeptRole[]): string {
  if (!run || run.completed_on) return '';
  return activeTasks(run)
    .map((t) => (t.assignee ? t.assignee_name : `Unassigned (${roleCode(t.role_id, roles)})`))
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(', ');
}

/** Officers of a role associated with the fire station of the property (lowest id first). */
export function isAssociated(user: Pick<UserAccount, 'all_stations' | 'fire_station_ids'>, fireStationId: number): boolean {
  return !!user.all_stations || (user.fire_station_ids ?? []).includes(fireStationId);
}

export function officersFor(roleId: number, fireStationId: number, users: UserAccount[]): UserAccount[] {
  return users
    .filter((u) => u.portal === 'dept' && u.active && u.role_id === roleId && isAssociated(u, fireStationId))
    .sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export function slaFor(app: Pick<Application, 'workflow'>, sla: SlaConfig) {
  return app.workflow ? sla.workflows[app.workflow.definition_code] : undefined;
}

export function taskSlaDays(run: WorkflowRun, task: WorkflowTask, sla: SlaConfig, forms: FormDef[]): number {
  const s = sla.workflows[run.definition_code];
  if (!s) return 7;
  if (forms.find((f) => f.id === task.form)?.inspection) return s.inspection_days;
  return s.step_days[task.task_key] ?? 7;
}

export function taskDaysPending(task: WorkflowTask, now: Date): number {
  return task.start_date ? Math.max(0, daysSince(task.start_date, now) ?? 0) : 0;
}

export function isTaskOverdue(run: WorkflowRun, task: WorkflowTask, sla: SlaConfig, forms: FormDef[], now: Date): boolean {
  return task.state === 'active' && taskDaysPending(task, now) > taskSlaDays(run, task, sla, forms);
}

export function processingDays(app: Pick<Application, 'workflow'>, now: Date): number {
  const run = app.workflow;
  if (!run) return 0;
  const end = run.completed_on ? (parseLegacyDate(run.completed_on) ?? now) : now;
  return Math.max(0, daysSince(run.started_on, end) ?? 0);
}

export function isProcessingOverdue(app: Pick<Application, 'workflow'>, sla: SlaConfig, now: Date): boolean {
  const s = slaFor(app, sla);
  return !!s && !!app.workflow && !app.workflow.completed_on && processingDays(app, now) > s.processing_days;
}

/** Legacy rule: once the processing SLA is crossed the file can only be approved or rejected. */
export function allowedOutcomes(app: Application, sla: SlaConfig, now: Date): WorkflowOutcome[] {
  const run = app.workflow;
  if (!run) return [];
  const final = run.stages[finalStageIndex(run.stages)]?.tasks[0];
  const outcomes = final?.decision?.outcomes ?? [];
  return isProcessingOverdue(app, sla, now) ? outcomes.filter((o) => o !== 'return') : outcomes;
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

export interface TaskItem {
  app: Application;
  task: WorkflowTask;
  action_label: string;
}

/** Active tasks assigned to an officer (dashboard "My tasks"). */
export function myTasks(apps: Application[], username: string): TaskItem[] {
  const out: TaskItem[] = [];
  for (const app of apps) {
    const run = app.workflow;
    if (!run || run.completed_on) continue;
    for (const t of activeTasks(run)) {
      if (t.assignee === username) {
        out.push({ app, task: t, action_label: taskDefOf(run.stages, t.stage_key, t.task_key)?.action_label ?? 'Open' });
      }
    }
  }
  return out.sort(
    (x, y) => (parseLegacyDate(x.task.start_date)?.getTime() ?? 0) - (parseLegacyDate(y.task.start_date)?.getTime() ?? 0),
  );
}

/** Applications an officer may follow (dashboard "Monitoring"). */
/** The read-only monitoring role (legacy role 8, code VIEW): sees every submitted application. */
export const MONITORING_ROLE_CODE = 'VIEW';

export function monitoredApplications(apps: Application[], user: UserAccount, roles: DeptRole[] = []): Application[] {
  const monitoring = roles.find((r) => r.id === user.role_id)?.code === MONITORING_ROLE_CODE;
  return apps.filter((app) => {
    if (app.status_id < 2 || !app.workflow) return false;
    if (monitoring) return true;
    const run = app.workflow;
    if (run.tasks.some((t) => t.assignee === user.username)) return true;
    return run.stages.some((s) => s.tasks.some((t) => t.role_id === user.role_id)) && isAssociated(user, app.fire_station_id);
  });
}

/** The stored data of the final decision task, if a decision was taken. */
export function decisionInput(app: Pick<Application, 'workflow'>): Record<string, unknown> | undefined {
  const t = app.workflow?.tasks.find((x) => x.decision && x.decision !== 'inspect');
  return t?.data as Record<string, unknown> | undefined;
}

/** Level of a Declaration: the level of the Occupancy NOC being renewed. */
export function declarationLevel(
  app: Pick<Application, 'noc_level' | 'ref_no' | 'parent_id'>,
  apps: Pick<Application, 'appl_id' | 'appl_number' | 'delegation_level'>[] = [],
): DelegationLevel {
  const parent = apps.find((x) => (app.parent_id && x.appl_id === app.parent_id) || (!!app.ref_no && x.appl_number === app.ref_no));
  return parent?.delegation_level ?? app.noc_level ?? 'DFO';
}

export function outcomeLabel(o: WorkflowOutcome): string {
  return { approve: 'Approved', return: 'Returned with Remarks', reject: 'Rejected', inspect: 'Inspection' }[o];
}
