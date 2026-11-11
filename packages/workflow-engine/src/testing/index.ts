/** Test kit: a fixed clock, an in-memory assignee directory and definition builders. */
import type { Actor, AssigneeResolver, Clock, EngineContext, Id, ProcessDefinition, SlaPolicy, StageDef, TaskDef } from '../types.js';

export class FixedClock implements Clock {
  constructor(private current: Date = new Date('2025-01-01T09:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}

export class InMemoryDirectory implements AssigneeResolver {
  constructor(private readonly people: { id: Id; name: string; roles: Id[]; active?: boolean }[]) {}
  resolve(role: Id): Actor | null {
    const p = this.people
      .filter((x) => x.active !== false && x.roles.map(String).includes(String(role)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))[0];
    return p ? { id: p.id, name: p.name } : null;
  }
  canHoldRole(actor: Id, role: Id): boolean {
    return this.people.some((p) => String(p.id) === String(actor) && p.active !== false && p.roles.map(String).includes(String(role)));
  }
  nameOf(actor: Id): string | undefined {
    return this.people.find((p) => String(p.id) === String(actor) && p.active !== false)?.name;
  }
}

export const DEFAULT_PERMISSIONS = { sendBack: false, requestInput: true, skippable: true, reassignable: true };

export function task(key: string, role: Id, extra: Partial<TaskDef> = {}): TaskDef {
  return { key, name: key, role, form: `${key}_form`, actionLabel: 'Open', permissions: { ...DEFAULT_PERMISSIONS }, ...extra };
}

export function stage(key: string, tasks: TaskDef[], effects?: Record<string, unknown>): StageDef {
  return { key, name: key, tasks, effects };
}

export function decision(role: Id, outcomes = ['approve', 'return', 'reject']): TaskDef {
  return task('decision', role, {
    permissions: { sendBack: true, requestInput: true, skippable: false, reassignable: false },
    decision: { outcomes: outcomes.map((key) => ({ key, terminal: true, effects: { outcome: key } })) },
  });
}

export function definition(stages: StageDef[], code = 'TEST'): ProcessDefinition {
  return { code, name: code, stages };
}

export function context(directory: AssigneeResolver, clock = new FixedClock(), sla?: SlaPolicy): EngineContext & { clock: FixedClock } {
  return { assignees: directory, clock, sla } as EngineContext & { clock: FixedClock };
}
