/**
 * Demo data: the 22 accounts and the 14 applications of the portal fixtures,
 * written into the normalised schema (including their workflow runs).
 *
 * Not idempotent by upsert: it deletes the demo rows first, so re-seeding
 * always produces exactly the same database.
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import type { Application, WorkflowRun } from '@srisaa/noc-domain';
import { config } from '../../config/env.js';
import { businessToday, isoDate, toDateColumn } from '../../lib/dates.js';
import { redateApplications } from './redate.js';
import type { Database } from '../client.js';
import * as s from '../schema/index.js';
import { insertBlocks, loadReferenceIds, num, type ReferenceIds } from '../../repositories/application.writer.js';
import { seedInputs, stationId } from './inputs.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];


/** Hash once: the 22 demo accounts share the same password. */
async function demoPasswordHash(): Promise<string> {
  return argon2.hash(config().SEED_DEMO_PASSWORD, { type: argon2.argon2id });
}

export interface DemoSeedResult {
  counts: Record<string, number>;
  notes: string[];
}

export async function clearDemoData(tx: Tx): Promise<void> {
  // Append-only tables (audit log, workflow events, revisions) are purged only
  // with this explicit, transaction-scoped escape hatch.
  await tx.execute(sql`set local noc.allow_purge = 'on'`);
  // Order matters only where there is no cascade; applications cascade to all
  // their children, wf_instances cascade to tasks and events.
  await tx.execute(sql`update applications set parent_application_id = null, child_application_id = null, current_wf_instance_id = null`);
  await tx.delete(s.wfEscalationNotices);
  await tx.delete(s.wfEscalationRuns);
  await tx.delete(s.wfReminders);
  await tx.delete(s.applicationRevisions);
  await tx.delete(s.applications);
  await tx.delete(s.wfInstances);
  await tx.delete(s.files);
  await tx.delete(s.notificationOutbox);
  await tx.execute(sql`delete from audit_log`);
  await tx.delete(s.deptUserStations);
  await tx.delete(s.deptProfiles);
  await tx.delete(s.citizenProfiles);
  await tx.delete(s.refreshTokens);
  await tx.delete(s.passwordResetTokens);
  await tx.delete(s.downloadTokens);
  // Configuration published by an administrator survives a demo reset as history,
  // detached from the accounts that are about to be recreated.
  await tx.execute(sql`update wf_definition_versions set created_by = null where created_by is not null`);
  await tx.execute(sql`update wf_definitions set updated_by = null where updated_by is not null`);
  await tx.execute(sql`update wf_sla_policies set updated_by = null where updated_by is not null`);
  await tx.execute(sql`update wf_escalation_settings set updated_by = null where updated_by is not null`);
  await tx.execute(sql`update config_change_log set changed_by = null where changed_by is not null`);
  await tx.delete(s.users);
  await tx.delete(s.applicationNumberSequence);
}

export async function seedUsers(tx: Tx): Promise<{ count: number; notes: string[] }> {
  const notes: string[] = [];
  const passwordHash = await demoPasswordHash();
  const users = seedInputs.users();
  const cfg = config();
  const forceChange = cfg.SEED_FORCE_PASSWORD_CHANGE ?? cfg.isProduction;
  for (const u of users) {
    await tx.insert(s.users).values({
      id: u.id,
      username: u.username,
      email: u.email,
      passwordHash,
      portal: u.portal,
      displayName: u.displayName,
      mobile: u.mobile ?? '',
      active: u.active !== false,
      // B2-8: in production every seeded officer / administrator must choose a password at first sign-in.
      mustChangePassword: forceChange && u.portal !== 'citizen',
      createdOn: toDateColumn(u.created_on),
    });
    if (u.portal === 'citizen') {
      await tx.insert(s.citizenProfiles).values({
        userId: u.id,
        gender: u.gender ?? '',
        dob: toDateColumn(u.dob),
        aadharLast4: (u.aadhar ?? '').slice(-4),
        aadharHash: u.aadhar ? createHash('sha256').update(u.aadhar).digest('hex') : '',
        address: u.address ?? '',
      });
    }
    if (u.portal === 'dept') {
      await tx.insert(s.deptProfiles).values({
        userId: u.id,
        roleId: Number(u.role_id),
        districtId: u.district ? Number(u.district) : null,
        allStations: !!u.all_stations,
      });
      const stationRows = (u.fire_station_ids ?? []).map((fireStationId) => ({ userId: u.id, fireStationId }));
      if (stationRows.length) await tx.insert(s.deptUserStations).values(stationRows).onConflictDoNothing();
    }
  }
  await tx.execute(sql`select setval(pg_get_serial_sequence('users', 'id'), (select coalesce(max(id), 1) from users))`);
  return { count: users.length, notes };
}

async function insertWorkflow(
  tx: Tx,
  applicationId: number,
  run: WorkflowRun,
  ids: ReferenceIds,
  status: 'running' | 'completed' | 'archived',
): Promise<number | null> {
  const def = ids.definitionByCode.get(run.definition_code);
  if (!def) return null;
  const [instance] = await tx
    .insert(s.wfInstances)
    .values({
      definitionId: def.id,
      definitionVersionId: def.versionId,
      subjectType: 'noc_application',
      subjectId: applicationId,
      cycle: run.revision ?? 1,
      status,
      outcome: run.outcome ?? null,
      deciderUserId: run.approver ? (ids.userByUsername.get(run.approver) ?? null) : null,
      startedAt: toDate(run.started_on) ?? new Date(),
      completedAt: run.completed_on ? toDate(run.completed_on) : null,
    })
    .returning({ id: s.wfInstances.id });

  const taskRows = run.tasks.map((t) => ({
      instanceId: instance.id,
      taskNo: t.task_id,
      stageKey: t.stage_key,
      taskKey: t.task_key,
      name: t.name,
      roleId: Number(t.role_id) || null,
      assigneeUserId: t.assignee ? (ids.userByUsername.get(t.assignee) ?? null) : null,
      assigneeName: t.assignee_name ?? '',
      state: t.state,
      activatedAt: t.start_date ? toDate(t.start_date) : null,
      completedAt: t.end_date ? toDate(t.end_date) : null,
      formId: ids.formByCode.get(t.form) ?? null,
      data: (t.data ?? {}) as Record<string, unknown>,
      draft: !!t.draft,
      remarks: t.remarks ?? '',
      resultCode: t.recommendation ?? null,
      outcome: t.decision ?? null,
      sentBackToStage: t.sent_back_to ?? null,
  }));
  if (taskRows.length) await tx.insert(s.wfTasks).values(taskRows);
  await tx.insert(s.wfEvents).values({
    instanceId: instance.id,
    type: 'InstanceSeeded',
    at: toDate(run.started_on) ?? new Date(),
    payload: { definition: run.definition_code, version: run.version, tasks: run.tasks.length },
  });
  return instance.id;
}

function toDate(legacy: string | undefined | null): Date | null {
  const iso = toDateColumn(legacy);
  return iso ? new Date(`${iso}T00:00:00Z`) : null;
}

/** The day the demo data is re-dated against; recorded so tests can reproduce it. */
export const REDATE_STATE = 'seed:redate-anchor';

export function demoApplications(anchor: Date | null): Application[] {
  const apps = seedInputs.applications();
  return anchor ? redateApplications(apps, anchor).applications : apps;
}

export async function seedApplications(tx: Tx, anchor: Date | null = businessToday()): Promise<{ counts: Record<string, number> }> {
  const ids = await loadReferenceIds(tx);
  const [feesSet] = await tx.select({ id: s.reRuleSets.currentVersionId }).from(s.reRuleSets).where(eq(s.reRuleSets.code, 'noc.fees'));
  const feesVersionId = feesSet?.id ?? null;
  const apps = demoApplications(anchor);
  await tx
    .insert(s.seedState)
    .values({ name: REDATE_STATE, checksum: anchor ? isoDate(anchor) : 'none' })
    .onConflictDoUpdate({ target: s.seedState.name, set: { checksum: anchor ? isoDate(anchor) : 'none', appliedAt: new Date() } });
  const counts = { applications: 0, blocks: 0, floors: 0, documents: 0, workflow_instances: 0, process_log: 0 };
  const childLinks: { id: number; child: number }[] = [];

  for (const app of apps as Application[]) {
    const typeId = ids.typeByCode.get(app.appl_type === 'RO' ? 'R' : app.appl_type);
    if (!typeId) throw new Error(`Unknown application type "${app.appl_type}" in the seed data.`);
    const ownerId = ids.userByUsername.get(app.owner);
    if (!ownerId) throw new Error(`Unknown owner "${app.owner}" in the seed data.`);

    await tx.insert(s.applications).values({
      id: app.appl_id,
      applNumber: app.appl_number || null,
      revision: app.revision ?? 1,
      applicationTypeId: typeId,
      applicationTypeModeId: ids.modeByTypeAndCode.get(`${typeId}:${app.appl_mode ?? ''}`) ?? null,
      ownerUserId: ownerId,
      siteName: app.site_name ?? '',
      siteAddr: app.site_addr ?? '',
      corrAddr: app.corr_addr ?? '',
      districtId: app.district ? Number(app.district) : null,
      fireStationId: stationId(app.fire_station_id),
      plotArea: num(app.plot_area),
      perimeter: num(app.perimeter),
      licAuth: app.lic_auth ?? '',
      licAddr: app.lic_addr ?? '',
      buildName: app.build_name ?? '',
      buildLandline: app.build_landline ?? '',
      buildMobile: app.build_mobile ?? '',
      buildEmail: app.build_email ?? '',
      buildAadhar: app.build_aadhar ?? '',
      refNo: app.ref_no ?? '',
      nocLevel: app.noc_level ?? null,
      lastInspectDate: toDateColumn(app.last_inspect_date),
      mcapproveDate: toDateColumn(app.mcapprove_date),
      appliedDate: toDateColumn(app.applied_date),
      finalDate: toDateColumn(app.final_date),
      validFrom: toDateColumn(app.valid_from),
      validTo: toDateColumn(app.valid_to),
      statusId: app.status_id,
      delegationLevel: app.delegation_level ?? 'DFO',
      stageLabel: app.stage_label ?? '',
      reviewer: app.reviewer ?? '',
      locLat: num(app.loc_lat),
      locLng: num(app.loc_lng),
      hostName: app.host_name ?? null,
      declarationAccepted: !!app.declaration_accepted,
      submittedAt: app.status_id > 1 ? toDate(app.applied_date) : null,
      lastModified: toDate(app.last_modified) ?? new Date(),
      createdBy: ownerId,
      updatedBy: ownerId,
    });
    counts.applications++;
    if (app.child_id) childLinks.push({ id: app.appl_id, child: app.child_id });

    const parties = (app.parties ?? []).map((p) => ({
      applicationId: app.appl_id,
      slNo: p.sl_no,
      partyRoleId: ids.partyRoleByName.get(p.role_name) ?? null,
      roleName: p.role_name,
      partyName: p.party_name ?? '',
      phoneNumber: p.phone_number ?? '',
      email: p.email ?? '',
      licenseNo: p.license_no ?? '',
    }));
    if (parties.length) await tx.insert(s.applicationParties).values(parties);
    const conditions = (app.conditions ?? []).map((c) => ({
      applicationId: app.appl_id,
      checklistNo: c.checklist_id,
      itemDesc: c.item_desc,
      selected: c.selected,
    }));
    if (conditions.length) await tx.insert(s.applicationConditions).values(conditions);
    if (app.feedback) {
      await tx.insert(s.applicationFeedback).values({
        applicationId: app.appl_id,
        rating: app.feedback.rating,
        remarks: app.feedback.remarks ?? '',
        ratedOn: toDateColumn(app.feedback.rated_on),
      });
    }
    if (app.payment) {
      await tx.insert(s.payments).values({
        applicationId: app.appl_id,
        mode: app.payment.mode ?? null,
        amount: num(app.payment.amount),
        status: app.payment.status ?? 'pending',
        challanNum: app.payment.challan_num ?? '',
        challanDate: toDateColumn(app.payment.challan_date),
        challanBank: app.payment.challan_bnk ?? '',
        challanBranch: app.payment.challan_brch ?? '',
        txnRef: app.payment.txn_ref ?? '',
        paidOn: toDateColumn(app.payment.paid_on),
        // a seeded payment is frozen under the seeded fee rules, like a real one (Q-57)
        feeRuleVersionId: app.payment.status === 'paid' ? feesVersionId : null,
      });
    }
    const documents = (app.documents ?? []).map((d) => ({
      applicationId: app.appl_id,
      docNo: d.doc_id,
      code: d.code,
      category: d.category ?? '',
      uploadedOn: toDateColumn(d.uploaded_on),
      uploadedBy: ownerId,
      fileNameFallback: d.file_name ?? '',
      sizeFallback: d.size ?? null,
    }));
    if (documents.length) await tx.insert(s.applicationDocuments).values(documents);
    counts.documents += documents.length;
    for (const d of app.dept_documents ?? []) {
      await tx.insert(s.deptDocuments).values({
        applicationId: app.appl_id,
        docNo: d.doc_id,
        description: d.description ?? '',
        fileNameFallback: d.file_name ?? '',
        uploadedByName: d.uploaded_by ?? '',
        uploadedOn: toDateColumn(d.uploaded_on),
      });
    }
    for (const m of app.sms ?? []) {
      await tx.insert(s.smsMessages).values({
        applicationId: app.appl_id,
        smsNo: m.sms_id,
        message: m.message,
        sentByName: m.sent_by ?? '',
        sentOn: toDateColumn(m.sent_on),
      });
    }
    const steps = (app.processLog ?? []).map((step) => ({
      applicationId: app.appl_id,
      stepNo: step.step_id,
      actorUserId: null,
      reviewerName: step.reviewer_name ?? '',
      role: step.role ?? '',
      statusId: step.status_id ?? null,
      action: step.action,
      remarks: step.remarks ?? '',
      atDate: toDateColumn(step.at_date),
      at: toDate(step.at_date) ?? new Date(),
    }));
    if (steps.length) await tx.insert(s.processLog).values(steps);
    counts.process_log += steps.length;

    counts.floors += await insertBlocks(tx, app.appl_id, app, ids);
    counts.blocks += (app.blocks ?? []).length;

    for (const historic of app.workflow_history ?? []) {
      await insertWorkflow(tx, app.appl_id, historic, ids, 'archived');
      counts.workflow_instances++;
    }
    let currentInstanceId: number | null = null;
    if (app.workflow) {
      currentInstanceId = await insertWorkflow(
        tx,
        app.appl_id,
        app.workflow,
        ids,
        app.workflow.completed_on ? 'completed' : 'running',
      );
      if (currentInstanceId) {
        await tx.execute(sql`update applications set current_wf_instance_id = ${currentInstanceId} where id = ${app.appl_id}`);
        counts.workflow_instances++;
      }
    }

    // Document requests carry the workflow task that raised them (legacy `processid`).
    const taskIdByNo = new Map<number, number>();
    if (currentInstanceId) {
      const rows = await tx
        .select({ id: s.wfTasks.id, taskNo: s.wfTasks.taskNo })
        .from(s.wfTasks)
        .where(eq(s.wfTasks.instanceId, currentInstanceId));
      for (const r of rows) taskIdByNo.set(r.taskNo, r.id);
    }
    for (const f of app.deptfiles ?? []) {
      await tx.insert(s.documentRequests).values({
        applicationId: app.appl_id,
        requestNo: f.fileid,
        wfTaskId: f.processid ? (taskIdByNo.get(f.processid) ?? null) : null,
        fileName: f.file_name,
        fileDesc: f.file_desc,
        status: f.status,
        citizenComment: f.citizen_comment ?? '',
        requestedByName: f.requested_by ?? '',
        requestedOn: toDateColumn(f.requested_on),
      });
    }
  }

  for (const link of childLinks) {
    await tx.execute(sql`update applications set child_application_id = ${link.child} where id = ${link.id}`);
    await tx.execute(sql`update applications set parent_application_id = ${link.id} where id = ${link.child}`);
  }

  // Cached aggregates
  await tx.execute(sql`
    update applications a set
      block_count = coalesce(b.blocks, 0),
      floor_count = coalesce(b.floors, 0),
      built_area_total = coalesce(b.area, 0),
      max_height = coalesce(b.height, 0)
    from (
      select bl.application_id,
             count(distinct bl.id) as blocks,
             count(f.id) as floors,
             coalesce(sum(f.built_area), 0) as area,
             coalesce(max(bl.height), 0) as height
      from blocks bl left join block_floors f on f.block_id = bl.id
      group by bl.application_id
    ) b where b.application_id = a.id`);

  // Application numbering continues after the seeded numbers.
  await tx.execute(sql`
    insert into application_number_sequence (prefix, last_seq)
    select substring(appl_number from 1 for 6), max(substring(appl_number from 7)::int)
    from applications where appl_number is not null
    group by 1
    on conflict (prefix) do update set last_seq = excluded.last_seq`);

  await tx.execute(sql`select setval(pg_get_serial_sequence('applications', 'id'), (select coalesce(max(id), 1) from applications))`);
  return { counts };
}

export async function seedDemo(tx: Tx): Promise<DemoSeedResult> {
  await clearDemoData(tx);
  const users = await seedUsers(tx);
  // SEED_REDATE=false keeps the fixture dates exactly as they are in the JSON.
  const anchor = config().SEED_REDATE ? businessToday() : null;
  const apps = await seedApplications(tx, anchor);
  return { counts: { users: users.count, ...apps.counts }, notes: users.notes };
}
