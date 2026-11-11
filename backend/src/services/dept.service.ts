/**
 * Department processing (phase B3): every officer action on a submitted
 * application, run through the workflow engine inside one transaction.
 *
 *   note / report   save (draft) · submit (server-side form validation)
 *   routing         send back · bypass (skip) · change officer (reassign)
 *   decision        approve / return / reject (signed copy + remarks) · order an inspection
 *   file actions    document request · department document · SMS ·
 *                   fire station (re-resolves the officers) · licensing authority
 *
 * The engine decides what is allowed; this service persists its result, applies
 * the events to the application (status, stage label, pending-with), writes the
 * process log, queues the notifications and the audit entry.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import {
  CHALLAN_VERIFIED,
  challanProblems,
  challanVerificationRequired,
  decisionAction,
  decisionPreviewApp,
  decisionValidity,
  formatLegacyDate,
  SIGNED_DECISION,
  taskFormProblems,
  type Application,
  type DecisionInput,
  type DeptRole,
  type FormDef,
  type WorkflowOutcome,
  type WorkflowTask,
} from '@srisaa/noc-domain';
import {
  activeStageIndex,
  activeTasks,
  allowedActions as engineAllowedActions,
  allowedOutcomes as engineAllowedOutcomes,
  complete,
  currentTasks,
  decide,
  finalStageIndex,
  isFinalTask,
  pendingWith as enginePendingWith,
  reassign,
  reresolveAssignees,
  saveDraft,
  sendBack,
  skip,
  taskDefOf,
  type EngineContext,
  type Instance,
  type Transition,
  type WorkflowEvent,
} from '@srisaa/workflow-engine';
import type { DirectoryBundle, WorkflowBundle } from '../cache/bundles.js';
import * as s from '../db/schema/index.js';
import { formsOf, loadLiveInstance, persistInstance, workflowContext, type StoredInstance } from '../engines/workflow.js';
import { AppError, businessRule, forbidden, notFound, validationFailed } from '../errors/app-error.js';
import { businessDate, businessToday, toDateColumn } from '../lib/dates.js';
import type { Tx } from '../repositories/application.writer.js';
import { storageKeys } from '../storage/storage.js';
import { assertCanRead } from './application.service.js';
import { effectsOf } from './citizen.service.js';
import { discardStored, insertFile, storeUpload, type IncomingFile } from './document.service.js';
import { audit, logStep, notify, read, reference, type ServiceContext } from './shared.js';

type Officer = DirectoryBundle['officers'][number];

const roles = (c: Pick<ServiceContext, 'cache'>) => reference(c).deptRoles as unknown as DeptRole[];
const roleCodeOf = (c: Pick<ServiceContext, 'cache'>, roleId: number | string | null | undefined) =>
  roles(c).find((r) => String(r.id) === String(roleId))?.code ?? String(roleId ?? '');
const officers = (c: Pick<ServiceContext, 'cache'>) => c.cache.data<DirectoryBundle>('directory').officers;
const officer = (c: Pick<ServiceContext, 'cache'>, id: number | string | null | undefined): Officer | undefined =>
  officers(c).find((o) => String(o.id) === String(id));

/** Display name and role code of the acting user, for the process log. */
function actorOf(c: ServiceContext): { name: string; role: string; userId: number } {
  const o = officer(c, c.user.id);
  return { name: c.user.displayName, role: o ? roleCodeOf(c, o.role_id) : c.user.portal === 'admin' ? 'Admin' : 'System', userId: c.user.id };
}

function requireOfficer(c: ServiceContext): void {
  if (c.user.portal !== 'dept') throw forbidden('Only department officers can process applications.');
}

// ---------------------------------------------------------------------------
// Loading and committing
// ---------------------------------------------------------------------------

interface Loaded {
  row: typeof s.applications.$inferSelect;
  stored: StoredInstance;
  ctx: EngineContext;
  now: Date;
}

async function lockSubmitted(tx: Tx, id: number) {
  const [row] = await tx
    .select()
    .from(s.applications)
    .where(and(eq(s.applications.id, id), isNull(s.applications.deletedAt)))
    .for('update');
  if (!row || row.statusId <= 1) throw notFound('Application not found.');
  return row;
}

async function load(tx: Tx, c: ServiceContext, id: number): Promise<Loaded> {
  const row = await lockSubmitted(tx, id);
  const stored = await loadLiveInstance(tx, id, formsOf(c.cache), true);
  if (!stored || stored.instance.status !== 'running') throw businessRule('This application has no workflow in progress.');
  const now = c.now ?? new Date();
  return { row, stored, ctx: workflowContext(c.cache, row.fireStationId, stored.definitionCode, now), now };
}

interface LogEntry {
  action: string;
  remarks: string;
  actor: { name: string; role: string; userId?: number | null };
}

/**
 * Persists an engine transition and applies it to the application: status and
 * stage label (from the events), pending-with, process log, notifications.
 */
async function commit(
  tx: Tx,
  c: ServiceContext,
  loaded: Loaded,
  transition: Transition,
  logs: LogEntry[],
  extra: Partial<typeof s.applications.$inferInsert> = {},
): Promise<{ status_id: number; stage_label: string }> {
  const { row, stored, now } = loaded;
  await persistInstance(tx, stored, transition.instance, transition.events, c.user.id);
  const effect = effectsOf(transition.events, { status_id: row.statusId, stage_label: row.stageLabel });
  const reviewer =
    transition.instance.status === 'running' ? enginePendingWith(transition.instance, (role) => `Unassigned (${roleCodeOf(c, role)})`) : '';
  await tx
    .update(s.applications)
    .set({
      statusId: effect.status_id,
      stageLabel: effect.stage_label,
      reviewer,
      lastModified: now,
      updatedAt: now,
      updatedBy: c.user.id,
      rowVersion: row.rowVersion + 1,
      ...extra,
    })
    .where(eq(s.applications.id, row.id));
  for (const l of logs) await logStep(tx, c, row.id, l.action, l.remarks, effect.status_id, l.actor);
  await notifyActivated(tx, c, row, transition.instance, transition.events);
  return effect;
}

/** Officers whose task has just been opened get the legacy "forwarded to you" SMS. */
async function notifyActivated(tx: Tx, c: ServiceContext, row: Loaded['row'], instance: Instance, events: WorkflowEvent[]): Promise<void> {
  const opened = new Set(events.filter((e) => e.type === 'TaskActivated').map((e) => (e as { task: number }).task));
  const userIds = [...new Set(instance.tasks.filter((t) => opened.has(t.no) && t.assignee).map((t) => Number(t.assignee!.id)))];
  if (!userIds.length) return;
  const people = await tx.select({ id: s.users.id, mobile: s.users.mobile }).from(s.users).where(inArray(s.users.id, userIds));
  for (const p of people) {
    if (p.id === c.user.id) continue;
    await notify(tx, 'sms', p.mobile, 'forwarded_to', { appl_number: row.applNumber ?? '', site_name: row.siteName, build_name: row.buildName }, { applicationId: row.id, userId: p.id });
  }
}

function taskOf(instance: Instance, taskNo: number) {
  const t = instance.tasks.find((x) => x.no === taskNo);
  if (!t) throw notFound('Task not found.');
  return t;
}

/** Only an officer with an open task on the file, or its issuing authority, may act on it. */
function ensureInvolved(c: ServiceContext, instance: Instance): void {
  const mine = activeTasks(instance).some((t) => String(t.assignee?.id) === String(c.user.id));
  const decider = String(instance.decider?.id) === String(c.user.id);
  if (!mine && !decider) throw forbidden('Only an officer with an open task on this file can do this.');
}

async function afterCommit(tx: Tx, c: ServiceContext, id: number, action: string, summary: string): Promise<Application> {
  await audit(tx, c, action, 'application', id, summary);
  return read(tx, id, false);
}

// ---------------------------------------------------------------------------
// Reads: the dept view of one application, what the officer may do
// ---------------------------------------------------------------------------

export interface AllowedActions {
  /** Tasks of the officer that are open now. */
  tasks: { task_id: number; save: boolean; submit: boolean; send_back: boolean; decide: boolean; request_documents: boolean; challan_check: boolean }[];
  /** Decision outcomes still allowed (the processing SLA removes "return"). */
  outcomes: WorkflowOutcome[];
  skip: number[];
  reassign: number[];
  /** Active officers who may take each reassignable task. */
  reassign_candidates: Record<number, { id: number; username: string; displayName: string }[]>;
  upload_documents: boolean;
  sms: boolean;
  change_fire_station: boolean;
  update_licensing_authority: boolean;
  is_decider: boolean;
}

const NONE: AllowedActions = {
  tasks: [],
  outcomes: [],
  skip: [],
  reassign: [],
  reassign_candidates: {},
  upload_documents: false,
  sms: false,
  change_fire_station: false,
  update_licensing_authority: false,
  is_decider: false,
};

export function allowedActionsFor(
  c: Pick<ServiceContext, 'cache' | 'user'>,
  app: Application,
  stored: StoredInstance | null,
  ctx: EngineContext | null,
  opts: { asAdmin?: boolean } = {},
): AllowedActions {
  if (!stored || !ctx || stored.instance.status !== 'running' || (c.user.portal !== 'dept' && !opts.asAdmin)) return { ...NONE };
  const instance = stored.instance;
  const allowed = engineAllowedOutcomes(instance, ctx);
  const all = instance.definition.stages.at(-1)?.tasks[0]?.decision?.outcomes.map((o) => o.key) ?? [];
  const blocked = all.filter((o) => !allowed.includes(o));
  const a = engineAllowedActions(instance, c.user.id, { blockedOutcomes: blocked, asAdmin: opts.asAdmin });
  const run = app.workflow!;
  const involved = a.involved;
  const tasks = [...new Set([...a.save])].map((no) => {
    const t = instance.tasks.find((x) => x.no === no)!;
    const def = taskDefOf(instance.definition.stages, t.stageKey, t.taskKey);
    const wire = run.tasks.find((x) => x.task_id === no) as WorkflowTask;
    return {
      task_id: no,
      save: true,
      submit: a.complete.includes(no),
      send_back: a.sendBack.includes(no),
      decide: a.decide === no,
      request_documents: !!def?.permissions.requestInput,
      challan_check: !isFinalTask(instance, t) && challanVerificationRequired(app, run, wire),
    };
  });
  const candidates: AllowedActions['reassign_candidates'] = {};
  for (const no of a.reassign) {
    const t = instance.tasks.find((x) => x.no === no)!;
    candidates[no] = officers(c)
      .filter((o) => o.active && String(o.role_id) === String(t.role))
      .map((o) => ({ id: o.id, username: o.username, displayName: o.displayName }));
  }
  const acted = instance.tasks.some((t) => t.state === 'done' || t.state === 'skipped' || t.state === 'sent_back');
  return {
    tasks,
    outcomes: (a.decide !== null ? a.outcomes : []) as WorkflowOutcome[],
    skip: a.skip,
    reassign: a.reassign,
    reassign_candidates: candidates,
    upload_documents: involved,
    sms: involved,
    change_fire_station: involved && app.status_id === 2 && !acted,
    update_licensing_authority: involved && activeStageIndex(instance) === finalStageIndex(instance.definition.stages),
    is_decider: String(instance.decider?.id) === String(c.user.id),
  };
}

/** GET /dept/applications/:id — the processing page's data in one call. */
export async function deptView(c: ServiceContext, id: number): Promise<{ application: Application; allowed_actions: AllowedActions; parent: Application | null }> {
  if (c.user.portal !== 'dept' && c.user.portal !== 'admin') throw forbidden('Only department officers can process applications.');
  const app = await read(c.db as unknown as Tx, id, false);
  if (app.status_id <= 1) throw notFound('Application not found.');
  await assertCanRead(c.db, c.user, app);
  const stored = await loadLiveInstance(c.db as unknown as Tx, id, formsOf(c.cache));
  const [row] = await c.db.select({ fireStationId: s.applications.fireStationId }).from(s.applications).where(eq(s.applications.id, id));
  const ctx = stored ? workflowContext(c.cache, row?.fireStationId ?? null, stored.definitionCode, c.now ?? new Date()) : null;
  let parent: Application | null = null;
  if (app.parent_id) {
    try {
      parent = await read(c.db as unknown as Tx, app.parent_id, false);
    } catch {
      parent = null;
    }
  }
  return { application: app, allowed_actions: allowedActionsFor(c, app, stored, ctx), parent };
}

// ---------------------------------------------------------------------------
// Note / report: save, submit
// ---------------------------------------------------------------------------

export async function saveTask(c: ServiceContext, id: number, taskNo: number, data: Record<string, unknown>): Promise<Application> {
  requireOfficer(c);
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    const tr = saveDraft(loaded.stored.instance, taskNo, c.user.id, data, loaded.ctx);
    await persistInstance(tx, loaded.stored, tr.instance, tr.events, c.user.id);
    await tx.update(s.applications).set({ rowVersion: loaded.row.rowVersion + 1 }).where(eq(s.applications.id, id));
    return read(tx, id, false);
  });
}

export async function submitTask(c: ServiceContext, id: number, taskNo: number, data: Record<string, unknown>): Promise<Application> {
  requireOfficer(c);
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    const task = taskOf(loaded.stored.instance, taskNo);
    const app = await read(tx, id, false);
    const form = (formsOf(c.cache) as FormDef[]).find((f) => f.id === task.form);
    const wire = app.workflow!.tasks.find((t) => t.task_id === taskNo)!;
    const problems = [
      ...(form ? taskFormProblems(form, data, app) : []),
      ...challanProblems(!isFinalTask(loaded.stored.instance, task) && challanVerificationRequired(app, app.workflow!, wire), data),
    ];
    if (problems.length) {
      throw validationFailed(
        `Complete the form before submitting (${problems.length} item${problems.length === 1 ? '' : 's'} pending).`,
        problems.map((message) => ({ field: 'task', message })),
      );
    }
    const remarks = String(data['remark'] ?? '').trim();
    const recommendation = data['recommendation'] === 'Y' || data['recommendation'] === 'N' ? String(data['recommendation']) : undefined;
    const tr = complete(loaded.stored.instance, taskNo, c.user.id, { data, remarks, resultCode: recommendation }, loaded.ctx);
    await commit(tx, c, loaded, tr, [{ action: `${task.name} submitted`, remarks, actor: { name: task.assignee?.name ?? c.user.displayName, role: roleCodeOf(c, task.role), userId: c.user.id } }]);
    const verified = data[CHALLAN_VERIFIED] === 'Y' ? ' (challan verified)' : '';
    return afterCommit(tx, c, id, 'workflow.task_submitted', `${task.name} submitted${verified}`);
  });
}

// ---------------------------------------------------------------------------
// Routing: send back, bypass, change officer
// ---------------------------------------------------------------------------

export async function sendTaskBack(c: ServiceContext, id: number, taskNo: number, comments: string): Promise<Application> {
  requireOfficer(c);
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    const task = taskOf(loaded.stored.instance, taskNo);
    const tr = sendBack(loaded.stored.instance, taskNo, c.user.id, comments, loaded.ctx);
    const sent = tr.events.find((e) => e.type === 'SentBack') as Extract<WorkflowEvent, { type: 'SentBack' }>;
    const stageName = loaded.stored.instance.definition.stages.find((st) => st.key === sent.toStage)?.name ?? sent.toStage;
    await commit(tx, c, loaded, tr, [{ action: `Sent back to ${stageName}`, remarks: comments.trim(), actor: { name: task.assignee?.name ?? c.user.displayName, role: roleCodeOf(c, task.role), userId: c.user.id } }]);
    return afterCommit(tx, c, id, 'workflow.sent_back', `${task.name} sent the file back to ${stageName}`);
  });
}

export async function skipTask(c: ServiceContext, id: number, taskNo: number, opts: { asAdmin?: boolean } = {}): Promise<Application> {
  if (!opts.asAdmin) requireOfficer(c);
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    const task = taskOf(loaded.stored.instance, taskNo);
    const tr = skip(loaded.stored.instance, taskNo, c.user.id, loaded.ctx, opts);
    const actor = actorOf(c);
    await commit(tx, c, loaded, tr, [{ action: `${task.name} bypassed`, remarks: 'Officer Bypassed', actor: { ...actor, role: roleCodeOf(c, task.role) } }]);
    return afterCommit(tx, c, id, 'workflow.task_skipped', `${task.name} bypassed`);
  });
}

export async function reassignTask(c: ServiceContext, id: number, taskNo: number, toUserId: number, opts: { asAdmin?: boolean } = {}): Promise<Application> {
  if (!opts.asAdmin) requireOfficer(c);
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    const task = taskOf(loaded.stored.instance, taskNo);
    const from = task.assignee?.name || 'Unassigned';
    const tr = reassign(loaded.stored.instance, taskNo, opts.asAdmin ? 'admin' : c.user.id, toUserId, loaded.ctx, {
      asAdmin: opts.asAdmin,
      roleName: (role) => roleCodeOf(c, role),
    });
    const to = tr.instance.tasks.find((t) => t.no === taskNo)!.assignee!.name;
    const byName = opts.asAdmin ? 'Portal Administrator' : c.user.displayName;
    await commit(tx, c, loaded, tr, [{ action: `${task.name}: officer changed`, remarks: `${from} → ${to}`, actor: { name: byName, role: roleCodeOf(c, task.role), userId: c.user.id } }]);
    // The new officer is told about a task that is already open.
    if (task.state === 'active') {
      const [p] = await tx.select({ mobile: s.users.mobile }).from(s.users).where(eq(s.users.id, toUserId));
      await notify(tx, 'sms', p?.mobile ?? '', 'forwarded_to', { appl_number: loaded.row.applNumber ?? '', site_name: loaded.row.siteName, build_name: loaded.row.buildName }, { applicationId: id, userId: toUserId });
    }
    return afterCommit(tx, c, id, 'workflow.task_reassigned', `${task.name}: ${from} → ${to}`);
  });
}

// ---------------------------------------------------------------------------
// Final decision
// ---------------------------------------------------------------------------

async function signedCopyOf(tx: Tx, instanceId: number, taskNo: number): Promise<{ fileId: string; name: string; size: number } | null> {
  const rows = await tx
    .select({ fileId: s.wfTaskAttachments.fileId, name: s.files.originalName, size: s.files.sizeBytes })
    .from(s.wfTaskAttachments)
    .innerJoin(s.wfTasks, eq(s.wfTasks.id, s.wfTaskAttachments.taskId))
    .innerJoin(s.files, eq(s.files.id, s.wfTaskAttachments.fileId))
    .where(and(eq(s.wfTasks.instanceId, instanceId), eq(s.wfTasks.taskNo, taskNo), eq(s.wfTaskAttachments.purpose, SIGNED_DECISION)))
    .orderBy(sql`${s.wfTaskAttachments.id} desc`)
    .limit(1);
  return rows[0] ? { fileId: rows[0].fileId, name: rows[0].name, size: Number(rows[0].size) } : null;
}

/** Uploads the signed NOC / letter for the decision task (before `decide`). */
export async function uploadSignedCopy(c: ServiceContext, id: number, taskNo: number, file: IncomingFile): Promise<{ file_id: string; file_name: string; size: number }> {
  requireOfficer(c);
  const stored = await storeUpload(file, () => storageKeys.decisionDocument(id), ['application/pdf']);
  try {
    return await c.db.transaction(async (tx) => {
      const loaded = await load(tx, c, id);
      const task = taskOf(loaded.stored.instance, taskNo);
      if (!isFinalTask(loaded.stored.instance, task)) throw businessRule('The signed copy belongs to the final decision.');
      if (task.state !== 'active' || String(task.assignee?.id) !== String(c.user.id)) {
        throw forbidden('Only the officer the task is assigned to can act on it.');
      }
      await insertFile(tx, stored, c.user.id);
      const [t] = await tx
        .select({ id: s.wfTasks.id })
        .from(s.wfTasks)
        .where(and(eq(s.wfTasks.instanceId, loaded.stored.id), eq(s.wfTasks.taskNo, taskNo)));
      await tx.insert(s.wfTaskAttachments).values({ taskId: t.id, fileId: stored.id, purpose: SIGNED_DECISION });
      await audit(tx, c, 'workflow.signed_copy_uploaded', 'application', id, `Signed copy uploaded (${stored.originalName})`);
      return { file_id: stored.id, file_name: stored.originalName, size: stored.size };
    });
  } catch (e) {
    await discardStored(stored);
    throw e;
  }
}

/** The renewal period recorded at submission (decision N-11), else the current rules. */
async function renewalYearsAtSubmit(tx: Tx, applicationId: number, revision: number): Promise<number | null> {
  const [rev] = await tx
    .select({ assessment: s.applicationRevisions.assessment })
    .from(s.applicationRevisions)
    .where(and(eq(s.applicationRevisions.applicationId, applicationId), eq(s.applicationRevisions.revision, revision), eq(s.applicationRevisions.kind, 'submitted')))
    .limit(1);
  const years = (rev?.assessment as { renewalYears?: number } | null)?.renewalYears;
  return typeof years === 'number' && years > 0 ? years : null;
}

function renewalBasis(c: ServiceContext, years: number | null) {
  if (years) return { years };
  const rules = (c.cache.data<{ renewalRules: unknown }>('rules').renewalRules ?? []) as never;
  return { rules };
}

const STATUS_TEXT: Record<string, string> = { approve: 'approved', return: 'returned with remarks', reject: 'rejected' };
const TYPE_TEXT: Record<string, string> = { P: 'Provisional NOC', O: 'Occupancy NOC', R: 'Renewal of NOC', RO: 'Renewal of NOC', D: 'Declaration' };

export async function decideApplication(c: ServiceContext, id: number, taskNo: number, outcome: WorkflowOutcome, input: DecisionInput): Promise<Application> {
  requireOfficer(c);
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    const { stored, ctx, now, row } = loaded;
    const task = taskOf(stored.instance, taskNo);
    const signed = outcome === 'inspect' ? null : await signedCopyOf(tx, stored.id, taskNo);
    const sla = c.cache.data<WorkflowBundle>('workflow').sla.workflows[stored.definitionCode] as { processing_days?: number } | undefined;
    const data = {
      ...input,
      remark: input.remark ?? '',
      ...(signed ? { signed_document: { file_name: signed.name, size: signed.size, file_id: signed.fileId } } : {}),
    } as unknown as Record<string, unknown>;
    const tr = decide(
      stored.instance,
      taskNo,
      c.user.id,
      outcome,
      { remarks: input.remark ?? '', data, attachments: signed ? [SIGNED_DECISION] : [] },
      ctx,
      {
        slaBlocked: `The processing SLA of ${sla?.processing_days ?? '—'} days has been exceeded — the application can only be approved or rejected.`,
        attachment: 'Upload the signed NOC / letter before submitting the decision.',
        remarks: 'Enter the remarks of the decision (they are printed on the NOC / letter).',
      },
    );
    const actor = { name: task.assignee?.name ?? c.user.displayName, role: roleCodeOf(c, task.role), userId: c.user.id };

    if (outcome === 'inspect') {
      await commit(tx, c, loaded, tr, [{ action: 'Inspection ordered', remarks: (input.remark ?? '').trim(), actor }]);
      return afterCommit(tx, c, id, 'workflow.inspection_ordered', 'Inspection ordered by the issuing authority');
    }

    const today = businessDate(now);
    const app = await read(tx, id, false);
    // Validity is computed in the legacy date notation the domain code uses, then stored as dates.
    const issued = formatLegacyDate(businessToday(now));
    const validity = outcome === 'approve' ? decisionValidity(app, issued, input, renewalBasis(c, await renewalYearsAtSubmit(tx, id, row.revision))) : null;
    await commit(tx, c, loaded, tr, [{ action: decisionAction(outcome, app.appl_type), remarks: (input.remark ?? '').trim(), actor }], {
      finalDate: today,
      reviewer: '',
      ...(validity ? { validFrom: toDateColumn(validity.valid_from), validTo: toDateColumn(validity.valid_to) } : {}),
    });

    // The immutable record of what was decided (Q-39).
    const decided = await read(tx, id, false);
    await tx
      .insert(s.applicationRevisions)
      .values({
        applicationId: id,
        revision: row.revision,
        kind: 'decided',
        snapshot: decided as unknown as Record<string, unknown>,
        wfInstanceId: stored.id,
        checksum: createHash('sha256').update(JSON.stringify(decided)).digest('hex').slice(0, 32),
        createdBy: c.user.id,
      })
      .onConflictDoNothing();

    // The applicant is told (legacy final_status SMS + e-mail).
    const [owner] = await tx.select({ id: s.users.id, mobile: s.users.mobile, email: s.users.email }).from(s.users).where(eq(s.users.id, row.ownerUserId));
    const payload = {
      appl_number: row.applNumber ?? '',
      site_name: row.siteName,
      build_name: row.buildName,
      status_text: STATUS_TEXT[outcome],
      appl_type: TYPE_TEXT[app.appl_type] ?? app.appl_type,
      final_date: decided.final_date,
    };
    await notify(tx, 'sms', owner?.mobile || row.buildMobile, 'final_status', payload, { applicationId: id, userId: owner?.id });
    await notify(tx, 'email', owner?.email || row.buildEmail, 'final_status_mail', payload, { applicationId: id, userId: owner?.id });
    return afterCommit(tx, c, id, 'workflow.decided', `Decision: ${outcome}`);
  });
}

/** The application as it would be after the decision (live NOC / letter preview). */
export async function decisionPreview(c: ServiceContext, id: number, taskNo: number, outcome: WorkflowOutcome, input: DecisionInput): Promise<Application> {
  requireOfficer(c);
  const app = await read(c.db as unknown as Tx, id, false);
  await assertCanRead(c.db, c.user, app);
  const task = app.workflow?.tasks.find((t) => t.task_id === taskNo);
  if (!task) throw notFound('Task not found.');
  const years = await renewalYearsAtSubmit(c.db as unknown as Tx, id, app.revision);
  return decisionPreviewApp(app, outcome, input, roles(c), renewalBasis(c, years), c.now ?? new Date());
}

// ---------------------------------------------------------------------------
// File actions
// ---------------------------------------------------------------------------

export async function requestDocument(c: ServiceContext, id: number, fileDesc: string): Promise<Application> {
  requireOfficer(c);
  const desc = fileDesc.trim();
  if (!desc) throw businessRule('Describe the document requested from the applicant.');
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    ensureInvolved(c, loaded.stored.instance);
    const mine = activeTasks(loaded.stored.instance).find((t) => String(t.assignee?.id) === String(c.user.id));
    const [n] = await tx.select({ n: max(s.documentRequests.requestNo) }).from(s.documentRequests).where(eq(s.documentRequests.applicationId, id));
    let wfTaskId: number | null = null;
    if (mine) {
      const [t] = await tx.select({ id: s.wfTasks.id }).from(s.wfTasks).where(and(eq(s.wfTasks.instanceId, loaded.stored.id), eq(s.wfTasks.taskNo, mine.no)));
      wfTaskId = t?.id ?? null;
    }
    await tx.insert(s.documentRequests).values({
      applicationId: id,
      requestNo: (n?.n ?? 0) + 1,
      wfTaskId,
      fileName: desc.replace(/[^a-zA-Z0-9]+/g, ''),
      fileDesc: desc,
      status: 'R',
      requestedByUserId: c.user.id,
      requestedByName: c.user.displayName,
      requestedOn: businessDate(loaded.now),
    });
    await tx.update(s.applications).set({ lastModified: loaded.now, rowVersion: loaded.row.rowVersion + 1 }).where(eq(s.applications.id, id));
    await logStep(tx, c, id, 'Document requested', desc, loaded.row.statusId, actorOf(c));
    const [owner] = await tx.select({ mobile: s.users.mobile, id: s.users.id }).from(s.users).where(eq(s.users.id, loaded.row.ownerUserId));
    await notify(tx, 'sms', owner?.mobile || loaded.row.buildMobile, 'document_requested', { appl_number: loaded.row.applNumber ?? '', file_desc: desc }, { applicationId: id, userId: owner?.id });
    return afterCommit(tx, c, id, 'workflow.document_requested', desc);
  });
}

export async function uploadDeptDocument(c: ServiceContext, id: number, description: string, file: IncomingFile): Promise<Application> {
  requireOfficer(c);
  const stored = await storeUpload(file, (ext) => storageKeys.deptDocument(id, ext), ['application/pdf']);
  try {
    return await c.db.transaction(async (tx) => {
      const loaded = await load(tx, c, id);
      ensureInvolved(c, loaded.stored.instance);
      await insertFile(tx, stored, c.user.id);
      const [n] = await tx.select({ n: max(s.deptDocuments.docNo) }).from(s.deptDocuments).where(eq(s.deptDocuments.applicationId, id));
      await tx.insert(s.deptDocuments).values({
        applicationId: id,
        docNo: (n?.n ?? 0) + 1,
        fileId: stored.id,
        description: description.trim(),
        uploadedByUserId: c.user.id,
        uploadedByName: c.user.displayName,
        uploadedOn: businessDate(loaded.now),
      });
      await tx.update(s.applications).set({ lastModified: loaded.now, rowVersion: loaded.row.rowVersion + 1 }).where(eq(s.applications.id, id));
      await logStep(tx, c, id, 'Department document uploaded', description.trim() || stored.originalName, loaded.row.statusId, actorOf(c));
      return afterCommit(tx, c, id, 'workflow.dept_document_uploaded', stored.originalName);
    });
  } catch (e) {
    await discardStored(stored);
    throw e;
  }
}

export async function sendSms(c: ServiceContext, id: number, message: string): Promise<Application> {
  requireOfficer(c);
  const text = message.trim();
  if (!text) throw businessRule('Enter the message to send.');
  if (text.length > 480) throw businessRule('An SMS can hold at most 480 characters.');
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    ensureInvolved(c, loaded.stored.instance);
    const [n] = await tx.select({ n: max(s.smsMessages.smsNo) }).from(s.smsMessages).where(eq(s.smsMessages.applicationId, id));
    const [owner] = await tx.select({ mobile: s.users.mobile, id: s.users.id }).from(s.users).where(eq(s.users.id, loaded.row.ownerUserId));
    await tx.insert(s.smsMessages).values({
      applicationId: id,
      smsNo: (n?.n ?? 0) + 1,
      message: text,
      sentByUserId: c.user.id,
      sentByName: c.user.displayName,
      sentOn: businessDate(loaded.now),
      deliveryStatus: 'queued',
    });
    await notify(tx, 'sms', loaded.row.buildMobile || owner?.mobile || '', 'dept_message', { message: text }, { applicationId: id, userId: owner?.id });
    await logStep(tx, c, id, 'SMS sent', text, loaded.row.statusId, actorOf(c));
    return afterCommit(tx, c, id, 'workflow.sms_sent', text.slice(0, 80));
  });
}

/**
 * Moves a file to another fire station while it is still Submitted, before any
 * officer has acted (legacy update_application.aspx): the officers of every
 * pending task are resolved again from the new station.
 */
export async function changeFireStation(c: ServiceContext, id: number, districtId: number, fireStationId: number): Promise<Application> {
  requireOfficer(c);
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    ensureInvolved(c, loaded.stored.instance);
    if (loaded.row.statusId !== 2) throw businessRule('The fire station can only be changed while the file is Submitted, before any officer has acted on it.');
    const [station] = await tx.select().from(s.fireStations).where(eq(s.fireStations.id, fireStationId));
    if (!station || station.districtId !== districtId) throw businessRule('Select a fire station of the chosen district.');
    const [district] = await tx.select().from(s.districts).where(eq(s.districts.id, districtId));
    const ctx = workflowContext(c.cache, fireStationId, loaded.stored.definitionCode, loaded.now);
    const tr = reresolveAssignees(loaded.stored.instance, ctx);
    await commit(tx, c, { ...loaded, ctx }, tr, [{ action: 'Fire station changed', remarks: `${district?.name ?? districtId} / ${station.name}`, actor: actorOf(c) }], {
      districtId,
      fireStationId,
    });
    return afterCommit(tx, c, id, 'workflow.fire_station_changed', `${district?.name ?? districtId} / ${station.name}`);
  });
}

export async function updateLicensingAuthority(c: ServiceContext, id: number, licAuth: string, licAddr: string): Promise<Application> {
  requireOfficer(c);
  if (!licAuth.trim() || !licAddr.trim()) throw businessRule('Enter the licensing authority and its address.');
  return c.db.transaction(async (tx) => {
    const loaded = await load(tx, c, id);
    ensureInvolved(c, loaded.stored.instance);
    const instance = loaded.stored.instance;
    if (activeStageIndex(instance) !== finalStageIndex(instance.definition.stages)) {
      throw businessRule('The licensing authority can only be updated once the file has reached the final decision.');
    }
    const from = loaded.row.licAuth;
    await tx
      .update(s.applications)
      .set({ licAuth: licAuth.trim(), licAddr: licAddr.trim(), lastModified: loaded.now, rowVersion: loaded.row.rowVersion + 1 })
      .where(eq(s.applications.id, id));
    await logStep(tx, c, id, 'Licensing authority updated', `${from || '—'} → ${licAuth.trim()}`, loaded.row.statusId, actorOf(c));
    return afterCommit(tx, c, id, 'workflow.licensing_authority_updated', licAuth.trim());
  });
}

/** Thrown for an unknown outcome string before it reaches the engine. */
export function parseOutcome(value: string): WorkflowOutcome {
  if (value === 'approve' || value === 'return' || value === 'reject' || value === 'inspect') return value;
  throw new AppError(422, 'validation', `"${value}" is not a decision.`);
}

export { currentTasks };
