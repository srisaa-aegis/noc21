/**
 * Escalations (legacy modules/admin/escalations.aspx, now SLA based): tasks pending longer than their
 * step / inspection SLA and applications whose whole processing exceeds the processing SLA. The
 * escalation configuration (config/sla.json) decides who is notified — the officer, the issuing
 * authority or both — and how often a reminder for the same item is repeated.
 */
import type { Application, EscalationLogEntry, EscalationNotice, FormDef, SlaConfig, UserAccount } from './models/index.js';
import { activeTasks, isProcessingOverdue, processingDays, slaFor, taskDaysPending, taskSlaDays } from './workflow-view.js';

function nameOf(users: Pick<UserAccount, 'username' | 'displayName'>[], username: string | null): string {
  return users.find((u) => u.username === username)?.displayName ?? username ?? '';
}

function recipientsFor(officers: string[], approver: string | null, sla: SlaConfig): string[] {
  const out = new Set<string>();
  if (sla.escalation.notify_officer) officers.forEach((o) => out.add(o));
  if (sla.escalation.notify_approver && approver) out.add(approver);
  return [...out];
}

/** Everything past its SLA right now. */
export function overdueItems(apps: Application[], sla: SlaConfig, forms: FormDef[], users: Pick<UserAccount, 'username' | 'displayName'>[], now: Date): EscalationNotice[] {
  const out: EscalationNotice[] = [];
  for (const a of apps) {
    const run = a.workflow;
    if (a.status_id < 2 || !run || run.completed_on) continue;
    const approver = run.approver;
    for (const t of activeTasks(run)) {
      const days = taskDaysPending(t, now);
      const limit = taskSlaDays(run, t, sla, forms);
      if (days <= limit) continue;
      const officers = t.assignee ? [t.assignee] : [];
      out.push({
        appl_id: a.appl_id,
        appl_number: a.appl_number,
        kind: forms.find((f) => f.id === t.form)?.inspection ? 'inspection' : 'step',
        task: t.name,
        task_id: t.task_id,
        officers,
        officer_names: t.assignee ? [t.assignee_name] : ['Unassigned'],
        approver,
        approver_name: nameOf(users, approver),
        days_pending: days,
        sla_days: limit,
        recipients: recipientsFor(officers, approver, sla),
      });
    }
    if (isProcessingOverdue(a, sla, now)) {
      const open = activeTasks(run);
      const officers = [...new Set(open.map((t) => t.assignee).filter((x): x is string => !!x))];
      out.push({
        appl_id: a.appl_id,
        appl_number: a.appl_number,
        kind: 'processing',
        task: 'Whole processing',
        task_id: 0,
        officers,
        officer_names: [...new Set(open.map((t) => t.assignee_name || 'Unassigned'))],
        approver,
        approver_name: nameOf(users, approver),
        days_pending: processingDays(a, now),
        sla_days: slaFor(a, sla)!.processing_days,
        recipients: recipientsFor(officers, approver, sla),
      });
    }
  }
  return out.sort((x, y) => y.days_pending - y.sla_days - (x.days_pending - x.sla_days));
}

const key = (n: Pick<EscalationNotice, 'appl_id' | 'kind' | 'task_id'>) => `${n.appl_id}/${n.kind}/${n.task_id}`;

/** Overdue items not reminded within the last `remind_every_days` days. */
export function dueEscalations(items: EscalationNotice[], log: EscalationLogEntry[], sla: SlaConfig, now: Date): EscalationNotice[] {
  const last = new Map<string, number>();
  for (const entry of log) {
    const at = new Date(entry.sent_at).getTime();
    for (const n of entry.notices ?? []) {
      const k = key(n);
      last.set(k, Math.max(last.get(k) ?? 0, at));
    }
  }
  const gap = sla.escalation.remind_every_days * 86_400_000;
  return items.filter((n) => n.recipients.length && now.getTime() - (last.get(key(n)) ?? 0) >= gap);
}

export function escalationEntry(notices: EscalationNotice[], now: Date): EscalationLogEntry {
  return {
    sent_at: now.toISOString(),
    recipients: new Set(notices.flatMap((n) => n.recipients)).size,
    applications: new Set(notices.map((n) => n.appl_id)).size,
    notices,
  };
}
