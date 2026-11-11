/**
 * Overdue detection for escalations: tasks past their due date, and instances
 * past their total deadline, minus anything reminded within the interval.
 */
import { activeTasks } from './queries.js';
import type { Id, Instance, SlaPolicy } from './types.js';

export interface OverdueItem {
  kind: 'task' | 'total';
  taskNo?: number;
  taskName: string;
  assignee: Id | null;
  decider: Id | null;
  dueAt: string;
  daysOverdue: number;
}

const DAY = 86_400_000;

export function overdueItems(instance: Instance, now: Date, sla?: SlaPolicy): OverdueItem[] {
  if (instance.status !== 'running') return [];
  const out: OverdueItem[] = [];
  for (const t of activeTasks(instance)) {
    if (t.dueAt && new Date(t.dueAt) < now) {
      out.push({
        kind: 'task',
        taskNo: t.no,
        taskName: t.name,
        assignee: t.assignee?.id ?? null,
        decider: instance.decider?.id ?? null,
        dueAt: t.dueAt,
        daysOverdue: Math.floor((now.getTime() - new Date(t.dueAt).getTime()) / DAY),
      });
    }
  }
  const total = sla?.totalDueAt?.(instance);
  if (total && total < now) {
    out.push({
      kind: 'total',
      taskName: 'Whole processing',
      assignee: null,
      decider: instance.decider?.id ?? null,
      dueAt: total.toISOString(),
      daysOverdue: Math.floor((now.getTime() - total.getTime()) / DAY),
    });
  }
  return out;
}

/** Drops items already reminded within `remindEveryDays`. */
export function dueForReminder(
  items: (OverdueItem & { key: string })[],
  lastReminded: Map<string, Date>,
  remindEveryDays: number,
  now: Date,
): (OverdueItem & { key: string })[] {
  return items.filter((i) => {
    const last = lastReminded.get(i.key);
    return !last || now.getTime() - last.getTime() >= remindEveryDays * DAY;
  });
}
