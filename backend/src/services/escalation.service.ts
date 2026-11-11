/**
 * Escalations (legacy modules/admin/escalations.aspx, now SLA based) — phase B3.
 *
 *   overdue   every active task past its step / inspection SLA, and every file
 *             past its processing SLA — found in SQL (wf_tasks, wf_sla_policies)
 *   due       the overdue items not reminded within `remind_every_days`
 *   send      records the run, the notices and the reminders, and e-mails each
 *             recipient one digest (transactional outbox)
 *
 * The scheduler runs `send` daily (decision N-12: 09:00 IST, every day); the
 * admin can preview and send by hand. The results match `overdueItems()` /
 * `dueEscalations()` of @srisaa/noc-domain, the reference implementation.
 */
import { sql } from 'drizzle-orm';
import type { EscalationLogEntry, EscalationNotice } from '@srisaa/noc-domain';
import type { WorkflowBundle } from '../cache/bundles.js';
import { config } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';
import type { ReferenceCache } from '../cache/reference-cache.js';

const KIND_TO_DB = { step: 'step', inspection: 'sla_class', processing: 'total' } as const;

interface EscalationSettings {
  notify_officer: boolean;
  notify_approver: boolean;
  remind_every_days: number;
}

function settings(cache: ReferenceCache): EscalationSettings {
  return cache.data<WorkflowBundle>('workflow').sla.escalation as unknown as EscalationSettings;
}

type Overdue = EscalationNotice & { instance_id: number };

/** Everything past its SLA at `now`. */
export async function overdueNotices(db: Database, cache: ReferenceCache, now: Date = new Date()): Promise<Overdue[]> {
  const tz = config().APP_TIMEZONE;
  const today = sql`(${now.toISOString()}::timestamptz at time zone ${tz})::date`;
  // The open tasks: active, and the latest row of their step (send back and re-inspection append rows).
  const openTasks = sql`
    open_tasks as (
      select t.* from wf_tasks t
        join wf_instances i on i.id = t.instance_id and i.status = 'running'
       where t.state = 'active'
         and not exists (select 1 from wf_tasks t2 where t2.instance_id = t.instance_id and t2.stage_key = t.stage_key
                                                     and t2.task_key = t.task_key and t2.task_no > t.task_no)
    )`;
  const stepSla = sql`case when f.sla_class = 'inspection' then coalesce((p.class_days->>'inspection')::int, p.total_days, 7)
                           else coalesce((p.task_days->>t.task_key)::int, 7) end`;
  const stepDays = sql`(${today} - (t.activated_at at time zone ${tz})::date)`;
  const [tasks, totals] = await Promise.all([
    db.execute<{
      instance_id: number; appl_id: number; appl_number: string | null; task_no: number; name: string; inspection: boolean;
      assignee: string | null; assignee_name: string; decider: string | null; decider_name: string | null; days: number; sla: number;
    }>(sql`
      with ${openTasks}
      select i.id as instance_id, a.id as appl_id, a.appl_number, t.task_no, t.name,
             coalesce(f.sla_class = 'inspection', false) as inspection,
             u.username as assignee, t.assignee_name, du.username as decider, du.display_name as decider_name,
             ${stepDays} as days, ${stepSla} as sla
        from open_tasks t
        join wf_instances i on i.id = t.instance_id
        join applications a on a.id = i.subject_id and a.current_wf_instance_id = i.id and a.deleted_at is null and a.status_id > 1
        left join wf_forms f on f.id = t.form_id
        left join wf_sla_policies p on p.definition_id = i.definition_id
        left join users u on u.id = t.assignee_user_id
        left join users du on du.id = i.decider_user_id
       where t.activated_at is not null and ${stepDays} > ${stepSla}`),
    db.execute<{
      instance_id: number; appl_id: number; appl_number: string | null; decider: string | null; decider_name: string | null; days: number; sla: number;
      officers: string[] | null; officer_names: string[] | null;
    }>(sql`
      select i.id as instance_id, a.id as appl_id, a.appl_number, du.username as decider, du.display_name as decider_name,
             (${today} - (i.started_at at time zone ${tz})::date) as days, p.total_days as sla,
             o.officers, o.officer_names
        from wf_instances i
        join applications a on a.id = i.subject_id and a.current_wf_instance_id = i.id and a.deleted_at is null and a.status_id > 1
        join wf_sla_policies p on p.definition_id = i.definition_id
        left join users du on du.id = i.decider_user_id
        -- per overdue run, its open tasks (an index lookup each; robust to misestimated row counts)
        left join lateral (
          select array_agg(distinct u.username) filter (where u.username is not null) as officers,
                 array_agg(distinct coalesce(nullif(t.assignee_name, ''), 'Unassigned')) as officer_names
            from wf_tasks t left join users u on u.id = t.assignee_user_id
           where t.instance_id = i.id and t.state = 'active'
             and not exists (select 1 from wf_tasks t2 where t2.instance_id = t.instance_id and t2.stage_key = t.stage_key
                                                         and t2.task_key = t.task_key and t2.task_no > t.task_no)
        ) o on true
       where i.status = 'running' and i.completed_at is null and (${today} - (i.started_at at time zone ${tz})::date) > p.total_days`),
  ]);
  const e = settings(cache);
  const recipients = (officers: string[], approver: string | null) => {
    const out = new Set<string>();
    if (e.notify_officer) officers.forEach((o) => out.add(o));
    if (e.notify_approver && approver) out.add(approver);
    return [...out];
  };
  const out: Overdue[] = [];
  for (const t of tasks.rows) {
    if (Number(t.days) <= Number(t.sla)) continue;
    const officers = t.assignee ? [t.assignee] : [];
    out.push({
      instance_id: t.instance_id,
      appl_id: t.appl_id,
      appl_number: t.appl_number ?? '',
      kind: t.inspection ? 'inspection' : 'step',
      task: t.name,
      task_id: t.task_no,
      officers,
      officer_names: t.assignee ? [t.assignee_name] : ['Unassigned'],
      approver: t.decider,
      approver_name: t.decider_name ?? t.decider ?? '',
      days_pending: Number(t.days),
      sla_days: Number(t.sla),
      recipients: recipients(officers, t.decider),
    });
  }
  for (const p of totals.rows) {
    const officers = (p.officers ?? []).filter(Boolean);
    out.push({
      instance_id: p.instance_id,
      appl_id: p.appl_id,
      appl_number: p.appl_number ?? '',
      kind: 'processing',
      task: 'Whole processing',
      task_id: 0,
      officers,
      officer_names: p.officer_names ?? [],
      approver: p.decider,
      approver_name: p.decider_name ?? p.decider ?? '',
      days_pending: Number(p.days),
      sla_days: Number(p.sla),
      recipients: recipients(officers, p.decider),
    });
  }
  return out.sort((x, y) => y.days_pending - y.sla_days - (x.days_pending - x.sla_days));
}

/** Overdue items not reminded within the reminder interval (and with someone to tell). */
export async function dueNotices(db: Database, cache: ReferenceCache, items: Overdue[], now: Date = new Date()): Promise<Overdue[]> {
  if (!items.length) return [];
  const reminders = await db.select().from(s.wfReminders);
  const last = new Map(reminders.map((r) => [`${r.instanceId}/${r.kind}/${r.taskId ?? 0}`, r.lastRemindedAt.getTime()]));
  const gap = settings(cache).remind_every_days * 86_400_000;
  return items.filter((n) => n.recipients.length && now.getTime() - (last.get(`${n.instance_id}/${KIND_TO_DB[n.kind]}/${n.task_id}`) ?? 0) >= gap);
}

/** Items listed by the preview (most overdue first); the counts cover all of them. */
export const PREVIEW_ROWS = 500;

export async function preview(
  db: Database,
  cache: ReferenceCache,
  now: Date = new Date(),
): Promise<{ overdue: EscalationNotice[]; due: EscalationNotice[]; counts: { overdue: number; due: number }; last: EscalationLogEntry | null }> {
  const overdue = await overdueNotices(db, cache, now);
  const due = await dueNotices(db, cache, overdue, now);
  const log = await escalationLog(db, 1);
  return {
    overdue: overdue.slice(0, PREVIEW_ROWS).map(strip),
    due: due.slice(0, PREVIEW_ROWS).map(strip),
    counts: { overdue: overdue.length, due: due.length },
    last: log[0] ?? null,
  };
}

const strip = ({ instance_id: _ignored, ...n }: Overdue): EscalationNotice => n;

/**
 * Sends the reminders that are due: one run, its notices, the reminder marks
 * and one e-mail per recipient, all in one transaction.
 */
export async function send(db: Database, cache: ReferenceCache, triggeredBy: string, now: Date = new Date()): Promise<EscalationLogEntry> {
  const due = await dueNotices(db, cache, await overdueNotices(db, cache, now), now);
  const recipients = [...new Set(due.flatMap((n) => n.recipients))];
  const entry: EscalationLogEntry = {
    sent_at: now.toISOString(),
    recipients: recipients.length,
    applications: new Set(due.map((n) => n.appl_id)).size,
    notices: due.map(strip),
  };
  if (!due.length) return entry;
  await db.transaction(async (tx) => {
    const people = await tx.execute<{ id: number; username: string; email: string; display_name: string }>(
      sql`select id, username, email, display_name from users where username in ${recipients}`,
    );
    const byName = new Map(people.rows.map((p) => [p.username, p]));
    const [run] = await tx
      .insert(s.wfEscalationRuns)
      .values({ ranAt: now, triggeredBy, noticesCount: due.length, recipientsCount: recipients.length })
      .returning({ id: s.wfEscalationRuns.id });
    await tx.insert(s.wfEscalationNotices).values(
      due.map((n) => ({
        runId: run.id,
        instanceId: n.instance_id,
        taskId: n.task_id,
        kind: KIND_TO_DB[n.kind],
        taskName: n.task,
        daysPending: n.days_pending,
        slaDays: n.sla_days,
        recipientUserIds: n.recipients.map((r) => byName.get(r)?.id).filter((x): x is number => !!x),
      })),
    );
    for (const n of due) {
      await tx
        .insert(s.wfReminders)
        .values({ instanceId: n.instance_id, taskId: n.task_id, kind: KIND_TO_DB[n.kind], lastRemindedAt: now })
        .onConflictDoUpdate({ target: [s.wfReminders.instanceId, s.wfReminders.taskId, s.wfReminders.kind], set: { lastRemindedAt: now } });
    }
    for (const r of recipients) {
      const person = byName.get(r);
      if (!person?.email) continue;
      const mine = due.filter((n) => n.recipients.includes(r));
      const items = mine.map((n) => `- ${n.appl_number}: ${n.task} — ${n.days_pending} days (SLA ${n.sla_days})`).join('\n');
      await tx.insert(s.notificationOutbox).values({
        kind: 'email',
        toAddress: person.email,
        templateKey: 'escalation',
        payload: { name: person.display_name, items },
        userId: person.id,
      });
    }
  });
  return entry;
}

/** The runs, newest first, with their notices. */
export async function escalationLog(db: Database, limit = 50): Promise<EscalationLogEntry[]> {
  const runs = await db.execute<{ id: number; ran_at: Date; recipients_count: number; triggered_by: string }>(sql`
    select id, ran_at, recipients_count, triggered_by from wf_escalation_runs where not dry_run order by ran_at desc limit ${limit}`);
  if (!runs.rows.length) return [];
  const notices = await db.execute<{
    run_id: number; instance_id: number; task_id: number | null; kind: string; task_name: string; days_pending: number; sla_days: number;
    appl_id: number | null; appl_number: string | null; recipients: string[] | null;
  }>(sql`
    select n.run_id, n.instance_id, n.task_id, n.kind, n.task_name, n.days_pending, n.sla_days, a.id as appl_id, a.appl_number,
           (select array_agg(u.username) from users u where u.id = any(n.recipient_user_ids)) as recipients
      from wf_escalation_notices n
      left join wf_instances i on i.id = n.instance_id
      left join applications a on a.id = i.subject_id
     where n.run_id in ${runs.rows.map((r) => r.id)}`);
  const FROM_DB: Record<string, EscalationNotice['kind']> = { step: 'step', sla_class: 'inspection', total: 'processing' };
  return runs.rows.map((r) => {
    const mine = notices.rows.filter((n) => n.run_id === r.id);
    return {
      sent_at: new Date(r.ran_at).toISOString(),
      recipients: r.recipients_count,
      applications: new Set(mine.map((n) => n.appl_id)).size,
      notices: mine.map((n) => ({
        appl_id: n.appl_id ?? 0,
        appl_number: n.appl_number ?? '',
        kind: FROM_DB[n.kind] ?? 'step',
        task: n.task_name,
        task_id: n.task_id ?? 0,
        officers: [],
        officer_names: [],
        approver: null,
        approver_name: '',
        days_pending: n.days_pending,
        sla_days: n.sla_days,
        recipients: n.recipients ?? [],
      })),
    };
  });
}
