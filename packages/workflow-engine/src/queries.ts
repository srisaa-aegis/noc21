/** Pure read helpers over an instance. */
import type { Actor, Id, Instance, StageDef, TaskDef, TaskInstance } from './types.js';

export function finalStageIndex(stages: StageDef[]): number {
  return stages.length - 1;
}

export function taskDefOf(stages: StageDef[], stageKey: string, taskKey: string): TaskDef | undefined {
  return stages.find((s) => s.key === stageKey)?.tasks.find((t) => t.key === taskKey);
}

/** The latest row of every task (send back and re-activation append rows). */
export function currentTasks(instance: Pick<Instance, 'tasks'>): TaskInstance[] {
  const latest = new Map<string, TaskInstance>();
  for (const t of instance.tasks) {
    const k = `${t.stageKey}/${t.taskKey}`;
    const prev = latest.get(k);
    if (!prev || t.no > prev.no) latest.set(k, t);
  }
  return [...latest.values()].sort((a, b) => a.no - b.no);
}

export function stageTasks(instance: Pick<Instance, 'tasks'>, stageKey: string): TaskInstance[] {
  return currentTasks(instance).filter((t) => t.stageKey === stageKey);
}

export function activeTasks(instance: Pick<Instance, 'tasks'>): TaskInstance[] {
  return currentTasks(instance).filter((t) => t.state === 'active');
}

/** Index of the stage in progress (-1 when nothing is active). */
export function activeStageIndex(instance: Instance): number {
  const active = new Set(activeTasks(instance).map((t) => t.stageKey));
  return instance.definition.stages.findIndex((s) => active.has(s.key));
}

export function isFinalTask(instance: Instance, task: Pick<TaskInstance, 'stageKey'>): boolean {
  const stages = instance.definition.stages;
  return stages[finalStageIndex(stages)]?.key === task.stageKey;
}

/** Display text: who the subject is pending with. */
export function pendingWith(instance: Instance | undefined, unassignedLabel: (role: Id) => string): string {
  if (!instance || instance.status !== 'running') return '';
  return activeTasks(instance)
    .map((t) => (t.assignee ? t.assignee.name : unassignedLabel(t.role)))
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(', ');
}

/** The most recent earlier stage that has finished work (send-back target). */
export function previousStageIndex(instance: Instance, stageIndex: number): number {
  for (let i = stageIndex - 1; i >= 0; i--) {
    if (stageTasks(instance, instance.definition.stages[i].key).some((t) => t.state === 'done')) return i;
  }
  return -1;
}

export function nextTaskNo(instance: Pick<Instance, 'tasks'>): number {
  return instance.tasks.reduce((m, t) => Math.max(m, t.no), 0) + 1;
}

export function sameActor(a: Actor | null | undefined, id: Id): boolean {
  return !!a && String(a.id) === String(id);
}

export interface AllowedActions {
  save: number[];
  complete: number[];
  sendBack: number[];
  skip: number[];
  reassign: number[];
  decide: number | null;
  outcomes: string[];
  /** Involved in the instance (assignee of an active task, or the decider). */
  involved: boolean;
}

/** What `actor` may do right now — the UI shows exactly these buttons. */
export function allowedActions(
  instance: Instance,
  actor: Id,
  opts: { now?: Date; blockedOutcomes?: string[]; asAdmin?: boolean } = {},
): AllowedActions {
  const out: AllowedActions = { save: [], complete: [], sendBack: [], skip: [], reassign: [], decide: null, outcomes: [], involved: false };
  if (instance.status !== 'running') return out;
  const isDecider = sameActor(instance.decider, actor);
  const current = currentTasks(instance);
  const stageIndex = activeStageIndex(instance);
  for (const t of current) {
    const def = taskDefOf(instance.definition.stages, t.stageKey, t.taskKey);
    const mine = t.state === 'active' && sameActor(t.assignee, actor);
    if (mine) {
      out.involved = true;
      out.save.push(t.no);
      if (isFinalTask(instance, t)) {
        out.decide = t.no;
        const blocked = new Set(opts.blockedOutcomes ?? []);
        out.outcomes = (def?.decision?.outcomes ?? []).map((o) => o.key).filter((k) => !blocked.has(k));
      } else {
        out.complete.push(t.no);
        if (def?.permissions.sendBack && previousStageIndex(instance, stageIndex) >= 0) out.sendBack.push(t.no);
      }
    }
    const pending = t.state === 'active' || t.state === 'waiting';
    if ((isDecider || opts.asAdmin) && pending && !isFinalTask(instance, t) && def?.permissions.skippable) out.skip.push(t.no);
    const reassignable = t.state === 'active' || t.state === 'waiting' || t.state === 'not_required';
    if (reassignable && (opts.asAdmin || (isDecider && def?.permissions.reassignable))) out.reassign.push(t.no);
  }
  if (isDecider) out.involved = true;
  return out;
}
