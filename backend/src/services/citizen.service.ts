/**
 * The citizen application lifecycle (phase B2): create, save, delete,
 * carry-forward, payment, submission, revision and rating.
 *
 * Every operation is one transaction that locks the application row first.
 * The server is the source of truth: on every save it re-runs the rules engine
 * (`assess`) and stores the result, overwriting whatever the browser computed.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  assess,
  canApplyForOccupancy,
  canApplyForRenewal,
  canDelete,
  canEdit,
  canRate,
  canRevise,
  computeFee,
  declarationLevel,
  effectOf,
  newDraft,
  occupancyFromProvisional,
  parametersToFeeConfig,
  renewalFromOccupancy,
  RULE_SETS,
  saveProblem,
  toProcessDefinition,
  toSummary,
  type Application,
  type Assessment,
  type FeeBreakdown,
  type OccupancyCondition,
  type PartyRole,
  type UserAccount,
  type ValidationIssue,
} from '@srisaa/noc-domain';
import { archive, start, pendingWith as enginePendingWith, type WorkflowEvent } from '@srisaa/workflow-engine';
import type { RuleEngine } from '@srisaa/rules-engine';
import type { ReferenceBundle } from '../cache/bundles.js';
import * as s from '../db/schema/index.js';
import {
  formsOf,
  definitionFor,
  insertInstance,
  loadLiveInstance,
  persistInstance,
  workflowContext,
} from '../engines/workflow.js';
import { assert, businessRule, conflict, forbidden, notFound, validationFailed } from '../errors/app-error.js';
import { businessDate, businessToday } from '../lib/dates.js';
import {
  loadReferenceIds,
  ownedScalars,
  refreshCaches,
  writeOwnedChildren,
  type Tx,
} from '../repositories/application.writer.js';
import type { PublicUser } from './auth.service.js';
import { audit, logStep, notify, read, reference, type ServiceContext } from './shared.js';

export type { ServiceContext } from './shared.js';
export { audit } from './shared.js';

export interface SaveResult {
  application: Application;
  assessment: Assessment;
}

function assessmentLookups(ref: ReferenceBundle) {
  return {
    applicationTypes: ref.applicationTypes as never,
    buildTypes: ref.buildTypes as never,
    partyRoles: ref.partyRoles as never,
    documentRequirements: ref.documentRequirements as never,
    equipments: ref.equipments as never,
  };
}

function runAssessment(c: ServiceContext, app: Application): Assessment {
  return assess(app, c.rules.get(), assessmentLookups(reference(c)), c.now ?? businessToday());
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Locks the citizen's own application row for the rest of the transaction. */
async function lockOwned(tx: Tx, c: ServiceContext, id: number) {
  if (c.user.portal !== 'citizen') throw forbidden('Only the applicant can change an application.');
  const [row] = await tx
    .select()
    .from(s.applications)
    .where(and(eq(s.applications.id, id), eq(s.applications.ownerUserId, c.user.id), isNull(s.applications.deletedAt)))
    .for('update');
  if (!row) throw notFound('Application not found.');
  return row;
}

async function storeAssessment(tx: Tx, applicationId: number, a: Assessment): Promise<void> {
  const values = {
    applicationId,
    assessedAt: new Date(),
    feeTotal: String(a.fee.total),
    feeBreakdown: a.fee as unknown as Record<string, unknown>,
    approvalLevel: a.approvalLevel,
    renewalYears: a.renewalYears,
    issues: a.issues as unknown as Record<string, unknown>[],
    errorCount: a.errorCount,
    ruleVersions: a.ruleVersions,
  };
  await tx
    .insert(s.applicationAssessments)
    .values(values)
    .onConflictDoUpdate({ target: s.applicationAssessments.applicationId, set: values });
}

function ownerAccount(user: PublicUser): UserAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    portal: 'citizen',
    email: user.email,
    mobile: user.mobile,
    active: true,
    created_on: user.created_on,
    address: user.address,
  } as UserAccount;
}

/**
 * The domain validation checks the fee against the *current* rates. Once the
 * applicant has paid, the fee is frozen with the rule version it was paid under
 * (decision Q-57), so the server replaces that check with the frozen position.
 */
function withFeePosition(a: Assessment, position: FeePosition): Assessment {
  const issues = a.issues.filter((i) => i.field !== 'payment');
  if (position.paid <= 0) {
    issues.push({ step: 'submit', field: 'payment', message: 'Pay the fee online or record the bank challan details.', severity: 'error' });
  } else if (position.due > 0) {
    issues.push({
      step: 'submit',
      field: 'payment',
      message: `An additional fee of Rs. ${position.due.toLocaleString('en-IN')} is payable because the built-up area changed after the fee was paid. Please pay the difference before submitting.`,
      severity: 'error',
    });
  }
  return { ...a, fee: position.frozen ? position.fee : a.fee, issues, errorCount: issues.filter((i) => i.severity === 'error').length };
}

// ---------------------------------------------------------------------------
// Create / save / delete
// ---------------------------------------------------------------------------

/**
 * First save of a new application (legacy newapplication.aspx). Only the site
 * name and address are required; everything else may be filled in later.
 */
export async function createApplication(c: ServiceContext, payload: Partial<Application> & { appl_type: string }): Promise<SaveResult> {
  if (c.user.portal !== 'citizen') throw forbidden('Only citizens can apply for a NOC.');
  const type = payload.appl_type === 'RO' ? 'R' : payload.appl_type;
  assert(['P', 'O', 'R', 'D'].includes(type), 'Choose the type of NOC to apply for.');
  const ref = reference(c);
  const base = newDraft(
    0,
    type as Application['appl_type'],
    ownerAccount(c.user),
    ref.partyRoles as PartyRole[],
    c.now ?? new Date(),
    ref.occupancyConditions as OccupancyCondition[],
  );
  const draft: Application = { ...base, ...payload, appl_type: type as Application['appl_type'], owner: c.user.username, status_id: 1 } as Application;
  const problem = saveProblem(draft);
  if (problem) throw businessRule(problem);

  return c.db.transaction(async (tx) => {
    const ids = await loadReferenceIds(tx);
    const typeId = ids.typeByCode.get(type) as number;
    const assessment = runAssessment(c, draft);
    const [row] = await tx
      .insert(s.applications)
      .values({
        applicationTypeId: typeId,
        ownerUserId: c.user.id,
        statusId: 1,
        revision: 1,
        ...ownedScalars(draft, ids, typeId),
        delegationLevel: assessment.approvalLevel,
        createdBy: c.user.id,
        updatedBy: c.user.id,
        lastModified: c.now ?? new Date(),
      })
      .returning({ id: s.applications.id });
    await writeOwnedChildren(tx, row.id, draft, ids, false);
    await tx.insert(s.payments).values({ applicationId: row.id, status: 'pending', amount: '0' });
    await refreshCaches(tx, [row.id]);
    await storeAssessment(tx, row.id, assessment);
    await audit(tx, c, 'application.created', 'application', row.id, `Draft ${type} application created`);
    return { application: await read(tx, row.id), assessment };
  });
}

/** Saves a draft (legacy SaveApplication). Only drafts are editable. */
export async function saveApplication(c: ServiceContext, id: number, payload: Application, ifMatch?: number): Promise<SaveResult> {
  return c.db.transaction(async (tx) => {
    const row = await lockOwned(tx, c, id);
    if (!canEdit({ status_id: row.statusId as Application['status_id'] })) throw businessRule('Only draft applications can be edited.');
    if (ifMatch !== undefined && ifMatch !== row.rowVersion) {
      throw conflict('This application was changed elsewhere (another tab or device). Reload it to see the latest version before saving.');
    }
    const current = await read(tx, id);
    // Only the fields the applicant owns are taken from the payload; the rest is the server's.
    const merged: Application = {
      ...current,
      appl_mode: payload.appl_mode ?? current.appl_mode,
      site_name: payload.site_name,
      site_addr: payload.site_addr,
      district: payload.district,
      fire_station_id: Number(payload.fire_station_id) || 0,
      corr_addr: payload.corr_addr,
      plot_area: payload.plot_area,
      perimeter: payload.perimeter,
      lic_auth: payload.lic_auth,
      lic_addr: payload.lic_addr,
      build_name: payload.build_name,
      build_landline: payload.build_landline,
      build_mobile: payload.build_mobile,
      build_email: payload.build_email,
      build_aadhar: payload.build_aadhar,
      ref_no: payload.ref_no,
      last_inspect_date: payload.last_inspect_date,
      mcapprove_date: payload.mcapprove_date,
      noc_level: payload.noc_level,
      loc_lat: payload.loc_lat,
      loc_lng: payload.loc_lng,
      declaration_accepted: !!payload.declaration_accepted,
      conditions: payload.conditions ?? current.conditions,
      parties: payload.parties ?? current.parties,
      blocks: payload.blocks ?? current.blocks,
    };
    const problem = saveProblem(merged);
    if (problem) throw businessRule(problem);
    const raw = runAssessment(c, merged); // recomputes the FFE grid in place
    const assessment = withFeePosition(raw, await feePosition(c, tx, merged));
    const ids = await loadReferenceIds(tx);
    await tx
      .update(s.applications)
      .set({
        ...ownedScalars(merged, ids, row.applicationTypeId),
        // derived by the assessment; kept current on drafts so what is shown (and
        // which documents are demanded) matches the server (fixed at submission)
        delegationLevel: assessment.approvalLevel,
        lastModified: c.now ?? new Date(),
        updatedAt: new Date(),
        updatedBy: c.user.id,
        rowVersion: row.rowVersion + 1,
      })
      .where(eq(s.applications.id, id));
    await writeOwnedChildren(tx, id, merged, ids, true);
    await refreshCaches(tx, [id]);
    await storeAssessment(tx, id, assessment);
    return { application: await read(tx, id), assessment };
  });
}

/** Deletes a first-revision draft and unlinks it from its parent. */
export async function deleteDraft(c: ServiceContext, id: number): Promise<void> {
  await c.db.transaction(async (tx) => {
    const row = await lockOwned(tx, c, id);
    const allowed = canDelete({ status_id: row.statusId as Application['status_id'], revision: row.revision, host_name: row.hostName ?? null });
    if (!allowed) throw businessRule('Only first-revision draft applications can be deleted.');
    await tx.update(s.applications).set({ deletedAt: new Date(), updatedBy: c.user.id }).where(eq(s.applications.id, id));
    await tx.update(s.applications).set({ childApplicationId: null }).where(eq(s.applications.childApplicationId, id));
    await audit(tx, c, 'application.deleted', 'application', id, 'Draft deleted by the applicant');
  });
}

// ---------------------------------------------------------------------------
// Carry forward (P → O, O/R → R)
// ---------------------------------------------------------------------------

export async function carryForward(
  c: ServiceContext,
  parentId: number,
  kind: 'occupancy' | 'renewal',
  conditions: OccupancyCondition[] = [],
): Promise<SaveResult> {
  return c.db.transaction(async (tx) => {
    await lockOwned(tx, c, parentId);
    const parent = await read(tx, parentId, false);
    const summary = toSummary(parent);
    if (kind === 'occupancy') {
      assert(canApplyForOccupancy(summary), 'An Occupancy application can only be made from an issued Provisional NOC that has none yet.');
    } else {
      assert(canApplyForRenewal(summary), 'A Renewal can only be made from an issued Occupancy NOC or Renewal that has none yet.');
    }
    const ref = reference(c);
    const checklist = conditions.length ? conditions : (ref.occupancyConditions as OccupancyCondition[]);
    const child =
      kind === 'occupancy'
        ? occupancyFromProvisional(parent, 0, c.now ?? new Date(), checklist)
        : renewalFromOccupancy(parent, 0, c.now ?? new Date());
    const ids = await loadReferenceIds(tx);
    const typeId = ids.typeByCode.get(child.appl_type) as number;
    const assessment = runAssessment(c, child);
    const [row] = await tx
      .insert(s.applications)
      .values({
        applicationTypeId: typeId,
        ownerUserId: c.user.id,
        statusId: 1,
        revision: 1,
        ...ownedScalars(child, ids, typeId),
        delegationLevel: assessment.approvalLevel,
        parentApplicationId: parentId,
        hostName: child.host_name ?? null,
        createdBy: c.user.id,
        updatedBy: c.user.id,
        lastModified: c.now ?? new Date(),
      })
      .returning({ id: s.applications.id });
    await writeOwnedChildren(tx, row.id, child, ids, false);
    await tx.insert(s.payments).values({ applicationId: row.id, status: 'pending', amount: '0' });
    await tx.update(s.applications).set({ childApplicationId: row.id }).where(eq(s.applications.id, parentId));
    await refreshCaches(tx, [row.id]);
    await storeAssessment(tx, row.id, assessment);
    await audit(tx, c, `application.${kind}`, 'application', row.id, `Carried forward from application ${parentId}`);
    return { application: await read(tx, row.id), assessment };
  });
}

// ---------------------------------------------------------------------------
// Fee and payment (the fee is frozen at payment — decision Q-57)
// ---------------------------------------------------------------------------

/** The fee computed with a specific version of the fee parameters. */
async function feeWithVersion(c: ServiceContext, tx: Tx, app: Application, versionId: number): Promise<FeeBreakdown> {
  const engine = c.rules.get();
  const current = engine.get(RULE_SETS.fees);
  if (current.versionId === versionId) {
    return computeFee(app, parametersToFeeConfig(current.definition as never), c.now ?? businessToday());
  }
  const [row] = await tx.select().from(s.reRuleSetVersions).where(eq(s.reRuleSetVersions.id, versionId)).limit(1);
  assert(row, 'The fee rules this payment was made under are missing.', 500);
  return computeFee(app, parametersToFeeConfig(row.definition as never), c.now ?? businessToday());
}

export interface FeePosition {
  fee: FeeBreakdown;
  paid: number;
  due: number;
  ruleVersionId: number;
  frozen: boolean;
}

/** What the applicant owes: computed with the frozen fee rules once anything has been paid. */
export async function feePosition(c: ServiceContext, tx: Tx, app: Application): Promise<FeePosition> {
  const [payment] = await tx.select().from(s.payments).where(eq(s.payments.applicationId, app.appl_id)).limit(1);
  const frozenVersion = payment?.feeRuleVersionId ?? null;
  const versionId = frozenVersion ?? c.rules.get().get(RULE_SETS.fees).versionId;
  const fee = await feeWithVersion(c, tx, app, versionId);
  const paid = payment?.status === 'paid' ? Number(payment.amount) : 0;
  return { fee, paid, due: Math.max(0, Math.round((fee.total - paid) * 100) / 100), ruleVersionId: versionId, frozen: frozenVersion !== null };
}

export interface PaymentInput {
  mode: 'online' | 'challan';
  challan_num?: string;
  challan_date?: string;
  bank?: string;
  branch?: string;
}

export async function pay(c: ServiceContext, id: number, input: PaymentInput, idempotencyKey?: string): Promise<{ application: Application; payment: FeePosition & { charged: number } }> {
  return c.db.transaction(async (tx) => {
    const row = await lockOwned(tx, c, id);
    if (row.statusId !== 1) throw businessRule('The fee can only be paid while the application is a draft.');
    const [payment] = await tx.select().from(s.payments).where(eq(s.payments.applicationId, id)).limit(1);
    if (idempotencyKey && payment?.idempotencyKey === idempotencyKey) {
      const app = await read(tx, id);
      return { application: app, payment: { ...(await feePosition(c, tx, app)), charged: 0 } };
    }
    const app = await read(tx, id);
    const position = await feePosition(c, tx, app);
    if (position.due <= 0 && position.paid > 0) throw conflict('The fee has already been paid in full.');
    if (position.fee.total <= 0) throw businessRule('The fee cannot be computed yet: enter the built-up area of the building first.');
    if (input.mode === 'challan') {
      if (![input.challan_num, input.challan_date, input.bank, input.branch].every((v) => v && String(v).trim())) {
        throw businessRule('Enter the challan number, date, bank and branch.');
      }
    }
    const today = businessDate(c.now ?? new Date());
    const charged = position.due;
    const differential = position.paid > 0;
    const values = {
      applicationId: id,
      mode: input.mode,
      amount: String(position.paid + charged),
      status: 'paid' as const,
      challanNum: input.mode === 'challan' ? String(input.challan_num).trim() : '',
      challanDate: input.mode === 'challan' ? (input.challan_date ?? null) : null,
      challanBank: input.mode === 'challan' ? String(input.bank).trim() : '',
      challanBranch: input.mode === 'challan' ? String(input.branch).trim() : '',
      txnRef: input.mode === 'online' ? `PAYU${createHash('sha1').update(`${id}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 10).toUpperCase()}` : '',
      paidOn: input.mode === 'challan' ? (input.challan_date ?? today) : today,
      feeBreakdown: position.fee as unknown as Record<string, unknown>,
      feeRuleVersionId: position.ruleVersionId,
      idempotencyKey: idempotencyKey ?? null,
      updatedAt: new Date(),
    };
    const [saved] = await tx
      .insert(s.payments)
      .values(values)
      .onConflictDoUpdate({ target: s.payments.applicationId, set: values })
      .returning({ id: s.payments.id });
    await tx.insert(s.paymentEvents).values({
      paymentId: saved.id,
      event: differential ? 'differential_paid' : 'paid',
      payload: { mode: input.mode, charged, total: position.fee.total, feeRuleVersionId: position.ruleVersionId, simulated: input.mode === 'online' },
    });
    await tx.update(s.applications).set({ lastModified: c.now ?? new Date(), rowVersion: row.rowVersion + 1 }).where(eq(s.applications.id, id));
    await audit(tx, c, 'payment.paid', 'application', id, `${differential ? 'Differential fee' : 'Fee'} of Rs. ${charged} paid (${input.mode})`);
    const after = await read(tx, id);
    return { application: after, payment: { ...(await feePosition(c, tx, after)), charged } };
  });
}

// ---------------------------------------------------------------------------
// Submission and revision
// ---------------------------------------------------------------------------

async function nextApplicationNumber(tx: Tx, now: Date): Promise<string> {
  const today = businessDate(now);
  const prefix = today.slice(0, 4) + today.slice(5, 7);
  const rows = await tx.execute<{ last_seq: number }>(sql`
    insert into application_number_sequence (prefix, last_seq) values (${prefix}, 1)
    on conflict (prefix) do update set last_seq = application_number_sequence.last_seq + 1
    returning last_seq`);
  // yyyymm + 5 digits: 100 000 applications a year overflow a 4-digit monthly sequence (decision N-2).
  return `${prefix}${String(rows.rows[0].last_seq).padStart(5, '0')}`;
}

function toFieldIssues(issues: ValidationIssue[]) {
  return issues
    .filter((i) => i.severity === 'error')
    .map((i) => ({ field: i.field, message: i.message, step: i.step, block: i.block, blockStep: i.blockStep, severity: i.severity }));
}

const roleCodeOf = (ref: ReferenceBundle) => (role: number | string) =>
  (ref.deptRoles as { id: number; code: string }[]).find((r) => String(r.id) === String(role))?.code ?? String(role);

/** Applies the engine's events to the application (status, label, pending-with). */
export function effectsOf(events: WorkflowEvent[], initial: { status_id: number; stage_label: string }) {
  let effect = initial;
  for (const e of events) {
    if (e.type === 'InstanceStarted') effect = effectOf(null);
    if (e.type === 'StageCompleted') effect = effectOf(e.effects);
    if (e.type === 'SentBack') effect = effectOf(e.restore);
    if (e.type === 'InstanceCompleted') effect = effectOf(e.effects);
  }
  return effect;
}

export async function submit(c: ServiceContext, id: number, input: { undertakings?: string[] }): Promise<{ application: Application; assessment: Assessment }> {
  const now = c.now ?? new Date();
  return c.db.transaction(async (tx) => {
    const row = await lockOwned(tx, c, id);
    if (row.statusId !== 1) throw businessRule('Only draft applications can be submitted.');
    const app = await read(tx, id);
    const ref = reference(c);

    // 1. Full validation by the server (the same rules the wizard shows), with the
    //    fee judged against what was paid under the frozen rules (Q-57 / N-3).
    const position = await feePosition(c, tx, app);
    const assessment = withFeePosition(runAssessment(c, app), position);
    if (assessment.errorCount > 0) {
      throw validationFailed(
        `The application cannot be submitted yet: ${assessment.errorCount} item${assessment.errorCount === 1 ? '' : 's'} need attention.`,
        toFieldIssues(assessment.issues),
      );
    }
    const required = ((ref.undertakings as Record<string, { id: string; required: boolean }[]>)[app.appl_type === 'RO' ? 'R' : app.appl_type] ?? []).filter((u) => u.required);
    const ticked = new Set(input.undertakings ?? []);
    const missing = required.filter((u) => !ticked.has(u.id));
    if (missing.length) throw businessRule('Please tick every undertaking on the confirmation page before submitting.');

    // 3. Approval level (a Declaration follows the Occupancy NOC it renews).
    let level = assessment.approvalLevel;
    if (app.appl_type === 'D') {
      const parents = await tx
        .select({ appl_id: s.applications.id, appl_number: s.applications.applNumber, delegation_level: s.applications.delegationLevel })
        .from(s.applications)
        .where(or(eq(s.applications.id, app.parent_id || -1), eq(s.applications.applNumber, app.ref_no || '~none~')));
      level = declarationLevel(app, parents.map((p) => ({ ...p, appl_number: p.appl_number ?? '' })));
    }

    // 4. The department workflow of this type × level, started by the engine.
    const binding = await definitionFor(tx, app.appl_type, level);
    if (!binding) throw businessRule(`No department workflow is configured for this application type at the ${level} level.`);
    const ctx = workflowContext(c.cache, row.fireStationId, binding.code, now);
    const started = start(toProcessDefinition(binding.definition, formsOf(c.cache)), app.revision, ctx);
    const instanceId = await insertInstance(tx, id, binding, started.instance, started.events, c.user.id);
    const effect = effectsOf(started.events, { status_id: 1, stage_label: '' });
    const reviewer = enginePendingWith(started.instance, (role) => `Unassigned (${roleCodeOf(ref)(role)})`);

    // 5. Number, status, dates.
    const number = row.applNumber ?? (await nextApplicationNumber(tx, now));
    await tx
      .update(s.applications)
      .set({
        applNumber: number,
        statusId: effect.status_id,
        stageLabel: effect.stage_label,
        reviewer,
        delegationLevel: level,
        appliedDate: businessDate(now),
        submittedAt: now,
        lastModified: now,
        currentWfInstanceId: instanceId,
        rowVersion: row.rowVersion + 1,
        updatedBy: c.user.id,
      })
      .where(eq(s.applications.id, id));
    await logStep(
      tx,
      c,
      id,
      app.revision > 1 ? 'Resubmitted' : 'Submitted',
      app.revision > 1 ? `Revision ${app.revision} submitted by the applicant.` : 'Application submitted by the applicant.',
      effect.status_id,
      { name: app.build_name || c.user.displayName, role: 'Applicant', userId: c.user.id },
    );
    await storeAssessment(tx, id, assessment);

    // 6. The immutable snapshot of what the department will review (Q-39).
    const submitted = await read(tx, id, false);
    await tx.insert(s.applicationRevisions).values({
      applicationId: id,
      revision: app.revision,
      kind: 'submitted',
      snapshot: submitted as unknown as Record<string, unknown>,
      assessment: assessment as unknown as Record<string, unknown>,
      ruleVersions: assessment.ruleVersions,
      wfInstanceId: instanceId,
      checksum: createHash('sha256').update(JSON.stringify(submitted)).digest('hex').slice(0, 32),
      createdBy: c.user.id,
    });

    // 7. Notifications (transactional outbox; delivered by the outbox job).
    await notify(tx, 'sms', c.user.mobile || app.build_mobile, 'submitted', { appl_number: number }, { applicationId: id, userId: c.user.id });
    const assignees = started.instance.tasks.filter((t) => t.state === 'active' && t.assignee).map((t) => Number(t.assignee!.id));
    if (assignees.length) {
      const officers = await tx.select({ id: s.users.id, mobile: s.users.mobile }).from(s.users).where(sql`${s.users.id} in ${assignees}`);
      for (const o of officers) {
        await notify(tx, 'sms', o.mobile, 'assigned_to', { appl_number: number, site_name: app.site_name }, { applicationId: id, userId: o.id });
      }
    }
    await audit(tx, c, 'application.submitted', 'application', id, `Submitted as ${number} (${binding.code})`);
    return { application: await read(tx, id), assessment };
  });
}

/** Reopens a returned / rejected application as a new revision (legacy revise.aspx). */
export async function revise(c: ServiceContext, id: number): Promise<Application> {
  const now = c.now ?? new Date();
  return c.db.transaction(async (tx) => {
    const row = await lockOwned(tx, c, id);
    if (!canRevise({ status_id: row.statusId as Application['status_id'] })) throw businessRule('Only returned or rejected applications can be revised.');
    // Keep the application as it was decided, before anything changes (Q-39).
    const before = await read(tx, id, false);
    await tx
      .insert(s.applicationRevisions)
      .values({
        applicationId: id,
        revision: row.revision,
        kind: 'archived',
        snapshot: before as unknown as Record<string, unknown>,
        wfInstanceId: row.currentWfInstanceId,
        checksum: createHash('sha256').update(JSON.stringify(before)).digest('hex').slice(0, 32),
        createdBy: c.user.id,
      })
      .onConflictDoNothing();
    const live = await loadLiveInstance(tx, id, formsOf(c.cache), true);
    if (live) {
      const archived = archive(live.instance, { assignees: { resolve: () => null, canHoldRole: () => false, nameOf: () => undefined }, clock: { now: () => now } });
      await persistInstance(tx, live, archived.instance, archived.events, c.user.id);
    }
    const nextRevision = row.revision + 1;
    await tx
      .update(s.applications)
      .set({
        statusId: 1,
        revision: nextRevision,
        finalDate: null,
        reviewer: '',
        stageLabel: '',
        declarationAccepted: false,
        currentWfInstanceId: null,
        lastModified: now,
        rowVersion: row.rowVersion + 1,
        updatedBy: c.user.id,
      })
      .where(eq(s.applications.id, id));
    await logStep(tx, c, id, 'Revision started', `Revision ${nextRevision} opened by the applicant.`, 1, {
      name: before.build_name || c.user.displayName,
      role: 'Applicant',
      userId: c.user.id,
    });
    await audit(tx, c, 'application.revised', 'application', id, `Revision ${nextRevision} opened`);
    return read(tx, id);
  });
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

export async function saveFeedback(c: ServiceContext, id: number, rating: number, remarks: string): Promise<Application> {
  return c.db.transaction(async (tx) => {
    const row = await lockOwned(tx, c, id);
    if (!canRate({ status_id: row.statusId as Application['status_id'] })) throw businessRule('Only completed applications can be rated.');
    if (!(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw businessRule('Please provide a rating (1 to 5 stars) before submitting.');
    if (!remarks.trim()) throw businessRule('Please enter a description before submitting.');
    const values = { applicationId: id, rating, remarks: remarks.trim(), ratedOn: businessDate(c.now ?? new Date()) };
    await tx.insert(s.applicationFeedback).values(values).onConflictDoUpdate({ target: s.applicationFeedback.applicationId, set: values });
    await audit(tx, c, 'application.rated', 'application', id, `Rated ${rating}/5`);
    return read(tx, id);
  });
}

/** Stateless assessment of an unsaved payload (used by the wizard and other clients). */
/** The assessment of a stored application, with the fee judged as at submission. */
export async function assessStored(c: ServiceContext, app: Application): Promise<Assessment> {
  return withFeePosition(runAssessment(c, JSON.parse(JSON.stringify(app)) as Application), await feePosition(c, c.db, app));
}

export function assessPayload(c: Pick<ServiceContext, 'cache' | 'rules' | 'now'>, app: Application): Assessment {
  return assess(JSON.parse(JSON.stringify(app)) as Application, c.rules.get() as RuleEngine, assessmentLookups(c.cache.data<ReferenceBundle>('reference')), c.now ?? businessToday());
}

