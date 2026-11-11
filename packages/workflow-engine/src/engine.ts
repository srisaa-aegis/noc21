/**
 * The workflow reducer. Every command is a pure function
 *   (instance, input, context) → { instance', events }
 * that never mutates its input and never performs I/O; it throws a
 * WorkflowError (with a user-presentable message) when the command is not
 * allowed. The host persists the result and reacts to the events.
 */
import { fail } from './errors.js';
import {
  activeStageIndex,
  activeTasks,
  currentTasks,
  finalStageIndex,
  isFinalTask,
  nextTaskNo,
  previousStageIndex,
  sameActor,
  stageTasks,
  taskDefOf,
} from './queries.js';
import type {
  Actor,
  DecisionInput,
  EngineContext,
  Id,
  Instance,
  ProcessDefinition,
  TaskInstance,
  Transition,
  WorkflowEvent,
} from './types.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const iso = (d: Date): string => d.toISOString();

function taskOrFail(instance: Instance, no: number): TaskInstance {
  return instance.tasks.find((t) => t.no === no) ?? fail('task_not_found', 'Task not found.');
}

function liveOrFail(instance: Instance | undefined): Instance {
  if (!instance || instance.status !== 'running') fail('no_live_instance', 'This application has no workflow in progress.');
  return instance;
}

function ensureCurrent(instance: Instance, task: TaskInstance): void {
  if (!currentTasks(instance).some((t) => t.no === task.no)) fail('task_superseded', 'This task has been superseded.');
}

function ensureOwner(task: TaskInstance, actor: Id): void {
  if (task.state !== 'active') fail('task_not_open', 'This task is not open.');
  if (!sameActor(task.assignee, actor)) fail('not_assignee', 'Only the officer the task is assigned to can act on it.');
}

function activate(instance: Instance, task: TaskInstance, ctx: EngineContext, now: Date, events: WorkflowEvent[]): void {
  task.state = 'active';
  task.activatedAt = iso(now);
  const def = taskDefOf(instance.definition.stages, task.stageKey, task.taskKey);
  const due = ctx.sla?.dueAt(task, def, now);
  task.dueAt = due ? iso(due) : undefined;
  events.push({ type: 'TaskActivated', at: iso(now), task: task.no });
}

function copyRow(instance: Instance, t: TaskInstance, state: TaskInstance['state']): TaskInstance {
  return {
    ...clone(t),
    no: nextTaskNo(instance),
    state,
    activatedAt: undefined,
    dueAt: undefined,
    completedAt: undefined,
    draft: true,
    outcome: undefined,
    sentBackTo: undefined,
  };
}

function activateStage(instance: Instance, stageIndex: number, ctx: EngineContext, now: Date, events: WorkflowEvent[]): void {
  const stage = instance.definition.stages[stageIndex];
  for (const t of stageTasks(instance, stage.key)) {
    if (t.state === 'waiting' || t.state === 'not_required') {
      activate(instance, t, ctx, now, events);
    } else if (t.state === 'sent_back' || t.state === 'done') {
      const row = copyRow(instance, t, 'waiting');
      instance.tasks.push(row);
      activate(instance, row, ctx, now, events);
    }
  }
}

/**
 * A stage is complete when every mandatory task is done or bypassed; optional
 * tasks never hold it up (any still open become "not required").
 *
 * Note: the browser implementation this replaces also required optional tasks
 * to be inactive, which made its own "optional tasks left open" branch
 * unreachable. No shipped workflow uses optional tasks, so the documented rule
 * is implemented here.
 */
function stageComplete(instance: Instance, stageIndex: number): boolean {
  const stage = instance.definition.stages[stageIndex];
  return stageTasks(instance, stage.key).every((t) => {
    const def = taskDefOf(instance.definition.stages, t.stageKey, t.taskKey);
    return t.state === 'done' || t.state === 'skipped' || !!def?.optional;
  });
}

function isOnDemandStage(instance: Instance, index: number): boolean {
  return instance.definition.stages[index].tasks.every((t) => t.onDemand);
}

/** Completes the stage when its mandatory tasks are finished and opens the next regular stage. */
function advanceIfComplete(instance: Instance, stageIndex: number, ctx: EngineContext, now: Date, events: WorkflowEvent[]): void {
  if (!stageComplete(instance, stageIndex)) return;
  const stage = instance.definition.stages[stageIndex];
  for (const t of stageTasks(instance, stage.key)) {
    if (t.state === 'active') t.state = 'not_required'; // optional tasks left open
  }
  events.push({ type: 'StageCompleted', at: iso(now), stage: stage.key, effects: clone(stage.effects ?? {}) });
  const last = finalStageIndex(instance.definition.stages);
  let next = stageIndex + 1;
  while (next < last && isOnDemandStage(instance, next)) next++;
  if (next < instance.definition.stages.length) {
    activateStage(instance, next, ctx, now, events);
    // a stage whose tasks were all bypassed in advance completes immediately
    if (next < last) advanceIfComplete(instance, next, ctx, now, events);
  }
}

function resolveDecider(instance: Instance): Actor | null {
  const finalKey = instance.definition.stages[finalStageIndex(instance.definition.stages)]?.key;
  return currentTasks(instance).find((t) => t.stageKey === finalKey)?.assignee ?? null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Starts a run: creates every task, resolves assignees, activates the first regular stage. */
export function start(definition: ProcessDefinition, cycle: number, ctx: EngineContext): Transition {
  const now = ctx.clock.now();
  const events: WorkflowEvent[] = [{ type: 'InstanceStarted', at: iso(now) }];
  const stages = clone(definition.stages);
  const instance: Instance = {
    definition: { ...clone(definition), stages },
    cycle,
    status: 'running',
    decider: null,
    startedAt: iso(now),
    tasks: [],
  };
  const firstStage = stages.findIndex((s) => !s.tasks.every((t) => t.onDemand));
  let no = 1;
  stages.forEach((s, si) => {
    for (const t of s.tasks) {
      instance.tasks.push({
        no: no++,
        stageKey: s.key,
        taskKey: t.key,
        name: t.name,
        role: t.role,
        assignee: ctx.assignees.resolve(t.role),
        state: t.onDemand ? 'not_required' : 'waiting',
        form: t.form,
        data: {},
        draft: false,
        remarks: '',
      });
      if (si === firstStage && !t.onDemand) activate(instance, instance.tasks[instance.tasks.length - 1], ctx, now, events);
    }
  });
  instance.decider = resolveDecider(instance);
  return { instance, events };
}

/** Saves the form of a task as a draft. */
export function saveDraft(current: Instance, taskNo: number, actor: Id, data: Record<string, unknown>, ctx: EngineContext): Transition {
  const instance = clone(liveOrFail(current));
  const task = taskOrFail(instance, taskNo);
  ensureCurrent(instance, task);
  ensureOwner(task, actor);
  task.data = clone(data);
  task.draft = true;
  return { instance, events: [{ type: 'TaskDraftSaved', at: iso(ctx.clock.now()), task: task.no, actor }] };
}

/** Completes a (non-decision) task; advances the stage when it is complete. */
export function complete(
  current: Instance,
  taskNo: number,
  actor: Id,
  input: { data: Record<string, unknown>; remarks: string; resultCode?: string },
  ctx: EngineContext,
): Transition {
  const now = ctx.clock.now();
  const instance = clone(liveOrFail(current));
  const task = taskOrFail(instance, taskNo);
  ensureCurrent(instance, task);
  ensureOwner(task, actor);
  if (isFinalTask(instance, task)) fail('use_decision', 'Use the final decision to complete this task.');
  task.data = clone(input.data);
  task.draft = false;
  task.state = 'done';
  task.completedAt = iso(now);
  task.remarks = input.remarks;
  if (input.resultCode !== undefined) task.resultCode = input.resultCode;
  const events: WorkflowEvent[] = [{ type: 'TaskCompleted', at: iso(now), task: task.no, actor, remarks: task.remarks }];
  const si = instance.definition.stages.findIndex((s) => s.key === task.stageKey);
  advanceIfComplete(instance, si, ctx, now, events);
  return { instance, events };
}

/** Sends the subject back to the officers of the previous stage (that stage's work is reopened with its data). */
export function sendBack(current: Instance, taskNo: number, actor: Id, remarks: string, ctx: EngineContext): Transition {
  const now = ctx.clock.now();
  const instance = clone(liveOrFail(current));
  const task = taskOrFail(instance, taskNo);
  ensureCurrent(instance, task);
  ensureOwner(task, actor);
  const def = taskDefOf(instance.definition.stages, task.stageKey, task.taskKey);
  if (!def?.permissions.sendBack) fail('send_back_not_allowed', 'This task cannot send the file back.');
  if (!remarks.trim()) fail('remarks_required', 'Enter the comments for the officer the file is sent back to.');
  const stages = instance.definition.stages;
  const si = stages.findIndex((s) => s.key === task.stageKey);
  const prev = previousStageIndex(instance, si);
  if (prev < 0) fail('no_previous_stage', 'There is no previous stage to send the file back to.');

  task.state = 'sent_back';
  task.completedAt = iso(now);
  task.remarks = remarks.trim();
  task.sentBackTo = stages[prev].key;
  const events: WorkflowEvent[] = [];
  for (const t of stageTasks(instance, task.stageKey)) {
    if (t.no === task.no) continue;
    if (t.state === 'active') {
      t.state = 'waiting';
      t.activatedAt = undefined;
      t.dueAt = undefined;
    } else if (t.state === 'done') {
      instance.tasks.push(copyRow(instance, t, 'waiting'));
    }
  }
  for (const t of stageTasks(instance, stages[prev].key)) {
    if (t.state === 'done') {
      const row = copyRow(instance, t, 'waiting');
      instance.tasks.push(row);
      activate(instance, row, ctx, now, events);
    }
  }
  // The subject goes back to what it was before the previous stage.
  const before = stages.slice(0, prev).filter((s) => stageTasks(instance, s.key).some((t) => t.state === 'done'));
  const restoreStage = before[before.length - 1];
  events.unshift({
    type: 'SentBack',
    at: iso(now),
    task: task.no,
    actor,
    toStage: stages[prev].key,
    remarks: task.remarks,
    restore: restoreStage ? clone(restoreStage.effects ?? {}) : null,
  });
  return { instance, events };
}

/** The decider bypasses a pending task. */
export function skip(current: Instance, taskNo: number, actor: Id, ctx: EngineContext, opts: { asAdmin?: boolean } = {}): Transition {
  const now = ctx.clock.now();
  const instance = clone(liveOrFail(current));
  const task = taskOrFail(instance, taskNo);
  ensureCurrent(instance, task);
  if (!opts.asAdmin && !sameActor(instance.decider, actor)) fail('not_decider', 'Only the issuing authority can bypass an officer.');
  const def = taskDefOf(instance.definition.stages, task.stageKey, task.taskKey);
  if (!def?.permissions.skippable) fail('not_skippable', 'This officer cannot be bypassed.');
  if (task.state !== 'active' && task.state !== 'waiting') fail('not_pending', 'Only pending tasks can be bypassed.');
  if (isFinalTask(instance, task)) fail('decision_not_skippable', 'The final decision cannot be bypassed.');
  const inProgress = activeStageIndex(instance);
  task.state = 'skipped';
  task.completedAt = iso(now);
  task.remarks = 'Officer Bypassed';
  const events: WorkflowEvent[] = [{ type: 'TaskSkipped', at: iso(now), task: task.no, actor }];
  const si = instance.definition.stages.findIndex((s) => s.key === task.stageKey);
  if (si === inProgress) advanceIfComplete(instance, si, ctx, now, events);
  return { instance, events };
}

/** Changes the assignee of a pending task (the decider, or an administrator for any task). */
export function reassign(
  current: Instance,
  taskNo: number,
  actor: Id,
  to: Id,
  ctx: EngineContext,
  opts: { asAdmin?: boolean; roleName?: (role: Id) => string } = {},
): Transition {
  const now = ctx.clock.now();
  const instance = clone(liveOrFail(current));
  const task = taskOrFail(instance, taskNo);
  ensureCurrent(instance, task);
  if (task.state !== 'active' && task.state !== 'waiting' && task.state !== 'not_required') {
    fail('not_pending', 'Only pending tasks can be reassigned.');
  }
  const def = taskDefOf(instance.definition.stages, task.stageKey, task.taskKey);
  if (!opts.asAdmin) {
    if (!sameActor(instance.decider, actor)) fail('not_decider', 'Only the issuing authority can change an officer.');
    if (!def?.permissions.reassignable) fail('not_reassignable', 'The officer of this task cannot be changed.');
  }
  const name = ctx.assignees.nameOf(to);
  if (!name) fail('invalid_assignee', 'Select an active department officer.');
  if (!ctx.assignees.canHoldRole(to, task.role)) {
    fail('invalid_assignee', `The task needs a ${opts.roleName ? opts.roleName(task.role) : String(task.role)}.`);
  }
  const from = task.assignee;
  task.assignee = { id: to, name };
  if (isFinalTask(instance, task)) instance.decider = task.assignee;
  return { instance, events: [{ type: 'TaskReassigned', at: iso(now), task: task.no, actor, from, to: task.assignee }] };
}

/** Re-runs assignment for every pending task (e.g. the subject moved to another office). */
export function reresolveAssignees(current: Instance, ctx: EngineContext): Transition {
  const now = ctx.clock.now();
  const instance = clone(liveOrFail(current));
  if (instance.tasks.some((t) => t.state === 'done' || t.state === 'skipped' || t.state === 'sent_back')) {
    fail('already_acted', 'The fire station can only be changed while the file is Submitted, before any officer has acted on it.');
  }
  const changed: number[] = [];
  for (const t of instance.tasks) {
    if (t.state !== 'active' && t.state !== 'waiting' && t.state !== 'not_required') continue;
    t.assignee = ctx.assignees.resolve(t.role);
    changed.push(t.no);
  }
  instance.decider = resolveDecider(instance);
  return { instance, events: [{ type: 'AssigneesResolved', at: iso(now), tasks: changed }] };
}

/** Outcomes still allowed (the SLA may block some once the total deadline has passed). */
export function allowedOutcomes(instance: Instance, ctx: EngineContext): string[] {
  const final = instance.definition.stages[finalStageIndex(instance.definition.stages)]?.tasks[0];
  const outcomes = (final?.decision?.outcomes ?? []).map((o) => o.key);
  const deadline = ctx.sla?.totalDueAt?.(instance);
  if (deadline && ctx.clock.now() > deadline) {
    const blocked = new Set(ctx.sla?.outcomesBlockedAfterDeadline ?? []);
    return outcomes.filter((o) => !blocked.has(o));
  }
  return outcomes;
}

/** The decision of the final task. Terminal outcomes complete the instance. */
export function decide(
  current: Instance,
  taskNo: number,
  actor: Id,
  outcomeKey: string,
  input: DecisionInput,
  ctx: EngineContext,
  messages: { slaBlocked?: string; attachment?: string; remarks?: string } = {},
): Transition {
  const now = ctx.clock.now();
  const instance = clone(liveOrFail(current));
  const task = taskOrFail(instance, taskNo);
  ensureCurrent(instance, task);
  ensureOwner(task, actor);
  if (!isFinalTask(instance, task)) fail('not_decision_task', 'This is not the final decision task.');
  const def = taskDefOf(instance.definition.stages, task.stageKey, task.taskKey);
  const outcome = def?.decision?.outcomes.find((o) => o.key === outcomeKey);
  if (!outcome) fail('outcome_not_allowed', `"${outcomeKey}" is not an allowed decision for this workflow.`);
  if (!allowedOutcomes(instance, ctx).includes(outcomeKey)) {
    fail('outcome_blocked_by_sla', messages.slaBlocked ?? 'The processing deadline has passed; this decision is no longer available.');
  }
  if (outcome.requiresAttachment && !(input.attachments ?? []).includes(outcome.requiresAttachment)) {
    fail('attachment_required', messages.attachment ?? `Attach the ${outcome.requiresAttachment} before submitting the decision.`);
  }
  if (outcome.requiresRemarks && !input.remarks?.trim()) {
    fail('remarks_required', messages.remarks ?? 'Enter the remarks of the decision.');
  }
  task.data = clone(input.data ?? {});
  task.draft = false;
  task.state = 'done';
  task.completedAt = iso(now);
  task.remarks = input.remarks?.trim() ?? '';
  task.outcome = outcomeKey;
  const events: WorkflowEvent[] = [{ type: 'DecisionTaken', at: iso(now), task: task.no, actor, outcome: outcomeKey, remarks: task.remarks }];

  if (!outcome.terminal) {
    const target = instance.definition.stages.findIndex((s) => s.key === outcome.activatesStage);
    if (target < 0) fail('stage_not_configured', 'The inspection stage of this workflow is not configured.');
    instance.tasks.push(copyRow(instance, task, 'waiting'));
    events.push({ type: 'OnDemandStageActivated', at: iso(now), stage: outcome.activatesStage as string });
    activateStage(instance, target, ctx, now, events);
    return { instance, events };
  }

  instance.status = 'completed';
  instance.outcome = outcomeKey;
  instance.completedAt = iso(now);
  events.push({ type: 'InstanceCompleted', at: iso(now), outcome: outcomeKey, effects: clone(outcome.effects ?? {}) });
  return { instance, events };
}

/** Retires a finished run (e.g. the subject is revised and will get a new run). */
export function archive(current: Instance, ctx: EngineContext): Transition {
  if (current.status === 'archived') return { instance: clone(current), events: [] };
  const instance = clone(current);
  instance.status = 'archived';
  return { instance, events: [{ type: 'InstanceArchived', at: iso(ctx.clock.now()) }] };
}

/** Moves every pending task of one actor to another, within one instance. */
export function handover(current: Instance, from: Id, to: Id, ctx: EngineContext): Transition {
  let instance = clone(current);
  const events: WorkflowEvent[] = [];
  if (instance.status !== 'running') return { instance, events };
  for (const t of currentTasks(instance)) {
    if (sameActor(t.assignee, from) && (t.state === 'active' || t.state === 'waiting' || t.state === 'not_required')) {
      const r = reassign(instance, t.no, 'admin', to, ctx, { asAdmin: true });
      instance = r.instance;
      events.push(...r.events);
    }
  }
  return { instance, events };
}

/** Convenience for hosts: which tasks are waiting on whom. */
export function openTasksOf(instance: Instance, actor: Id): TaskInstance[] {
  return activeTasks(instance).filter((t) => sameActor(t.assignee, actor));
}
