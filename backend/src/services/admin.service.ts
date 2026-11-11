/**
 * Administration (phase B3): accounts (citizens, officers), the officer
 * hand-over on deactivation, unassigned tasks, application deletion and the
 * configurable statuses (N-4).
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { generateTemporaryPassword, passwordPolicyProblems } from '@srisaa/noc-domain';
import { handover, type Instance } from '@srisaa/workflow-engine';
import type { DirectoryBundle } from '../cache/bundles.js';
import * as s from '../db/schema/index.js';
import { formsOf, loadLiveInstance, persistInstance, workflowContext } from '../engines/workflow.js';
import { AppError, assert, businessRule, conflict, forbidden, notFound } from '../errors/app-error.js';
import { businessDate, toDateColumn } from '../lib/dates.js';
import type { Tx } from '../repositories/application.writer.js';
import { publicUser, type PublicUser } from './auth.service.js';
import { effectsOf } from './citizen.service.js';
import { audit, logStep, reference, type ServiceContext } from './shared.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE = /^[6-9]\d{9}$/;
const USERNAME = /^[a-z0-9._@-]{3,40}$/;

function requireAdmin(c: ServiceContext): void {
  if (c.user.portal !== 'admin') throw forbidden('Only administrators can do this.');
}

async function lockUser(tx: Tx, id: number) {
  const [row] = await tx.select().from(s.users).where(and(eq(s.users.id, id), isNull(s.users.deletedAt))).for('update');
  if (!row) throw notFound('Account not found.');
  return row;
}

async function emailTaken(tx: Tx, email: string, exceptId?: number): Promise<boolean> {
  const rows = await tx
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(sql`lower(${s.users.email}) = ${email.toLowerCase()}`, exceptId ? ne(s.users.id, exceptId) : undefined, isNull(s.users.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

/** The directory bundle is built from users + dept profiles; account edits must refresh it. */
async function bumpDirectory(tx: Tx): Promise<void> {
  await tx.execute(sql`
    with v as (
      insert into cache_versions (bundle, version, updated_at) values ('directory', 1, now())
      on conflict (bundle) do update set version = cache_versions.version + 1, updated_at = now()
      returning version)
    select pg_notify('noc_cache', 'directory:' || version) from v`);
}

// ---------------------------------------------------------------------------
// Officers
// ---------------------------------------------------------------------------

export interface DeptUserInput {
  username?: string;
  displayName: string;
  email: string;
  mobile: string;
  role_id: number;
  district?: number | null;
  fire_station_ids?: number[];
  all_stations?: boolean;
}

async function checkDeptFields(tx: Tx, input: DeptUserInput, exceptId?: number): Promise<void> {
  assert(input.displayName?.trim().length > 1, 'Display name / designation is required.');
  const [role] = await tx.select().from(s.deptRoles).where(eq(s.deptRoles.id, Number(input.role_id)));
  assert(role, 'Select a department role.');
  assert(!!input.all_stations || (input.fire_station_ids ?? []).length > 0, 'Associate the officer with at least one fire station (or with all fire stations).');
  if (!input.all_stations && input.fire_station_ids?.length) {
    const found = await tx.select({ id: s.fireStations.id }).from(s.fireStations).where(inArray(s.fireStations.id, input.fire_station_ids));
    assert(found.length === new Set(input.fire_station_ids).size, 'One of the selected fire stations does not exist.');
  }
  assert(EMAIL.test(input.email.trim()), 'Enter a valid e-mail address.');
  assert(MOBILE.test(input.mobile), 'Enter a valid 10-digit mobile number.');
  assert(!(await emailTaken(tx, input.email.trim(), exceptId)), 'Another account already uses this e-mail.');
}

async function writeStations(tx: Tx, userId: number, input: DeptUserInput): Promise<void> {
  await tx.delete(s.deptUserStations).where(eq(s.deptUserStations.userId, userId));
  const ids = input.all_stations ? [] : [...new Set(input.fire_station_ids ?? [])];
  if (ids.length) await tx.insert(s.deptUserStations).values(ids.map((fireStationId) => ({ userId, fireStationId })));
}

/** New department officer with a temporary password shown once to the admin (changed at first sign-in). */
export async function createDeptUser(c: ServiceContext, input: DeptUserInput): Promise<{ account: PublicUser; temporaryPassword: string }> {
  requireAdmin(c);
  const username = (input.username ?? '').trim().toLowerCase();
  assert(USERNAME.test(username), 'Username must be 3-40 characters: letters, digits, ".", "_", "-" or "@".');
  const temporaryPassword = generateTemporaryPassword();
  const id = await c.db.transaction(async (tx) => {
    const taken = await tx.select({ id: s.users.id }).from(s.users).where(sql`lower(${s.users.username}) = ${username}`).limit(1);
    assert(!taken.length, 'This username is already taken.', 409);
    await checkDeptFields(tx, input);
    const [u] = await tx
      .insert(s.users)
      .values({
        username,
        email: input.email.trim(),
        passwordHash: await argon2.hash(temporaryPassword, { type: argon2.argon2id }),
        portal: 'dept',
        displayName: input.displayName.trim(),
        mobile: input.mobile,
        active: true,
        mustChangePassword: true,
        createdOn: businessDate(c.now ?? new Date()),
      })
      .returning({ id: s.users.id });
    await tx.insert(s.deptProfiles).values({
      userId: u.id,
      roleId: Number(input.role_id),
      districtId: input.district ? Number(input.district) : null,
      allStations: !!input.all_stations,
    });
    await writeStations(tx, u.id, input);
    await bumpDirectory(tx);
    await audit(tx, c, 'account.created', 'user', u.id, `Department user ${username} created`);
    return u.id;
  });
  return { account: await publicUser(c.db, id), temporaryPassword };
}

export async function updateDeptUser(c: ServiceContext, id: number, input: DeptUserInput): Promise<PublicUser> {
  requireAdmin(c);
  await c.db.transaction(async (tx) => {
    const row = await lockUser(tx, id);
    assert(row.portal === 'dept', 'Not a department account.');
    await checkDeptFields(tx, input, id);
    await tx
      .update(s.users)
      .set({ displayName: input.displayName.trim(), email: input.email.trim(), mobile: input.mobile, updatedAt: new Date() })
      .where(eq(s.users.id, id));
    await tx
      .update(s.deptProfiles)
      .set({ roleId: Number(input.role_id), districtId: input.district ? Number(input.district) : null, allStations: !!input.all_stations })
      .where(eq(s.deptProfiles.userId, id));
    await writeStations(tx, id, input);
    await bumpDirectory(tx);
    await audit(tx, c, 'account.updated', 'user', id, `Department user ${row.username} updated`);
  });
  return publicUser(c.db, id);
}

// ---------------------------------------------------------------------------
// Citizens
// ---------------------------------------------------------------------------

export interface CitizenPatch {
  displayName: string;
  email: string;
  mobile: string;
  address?: string;
  gender?: string;
  /** dd-Mon-yyyy or yyyy-mm-dd; '' clears it. */
  dob?: string;
}

export async function updateCitizen(c: ServiceContext, id: number, patch: CitizenPatch): Promise<PublicUser> {
  requireAdmin(c);
  await c.db.transaction(async (tx) => {
    const row = await lockUser(tx, id);
    assert(row.portal === 'citizen', 'Not a citizen account.');
    assert(patch.displayName?.trim().length > 1, 'Name is required.');
    assert(EMAIL.test(patch.email.trim()), 'Enter a valid e-mail address.');
    assert(MOBILE.test(patch.mobile), 'Enter a valid 10-digit mobile number.');
    assert(!(await emailTaken(tx, patch.email.trim(), id)), 'Another account already uses this e-mail.');
    await tx
      .update(s.users)
      .set({ displayName: patch.displayName.trim(), email: patch.email.trim(), mobile: patch.mobile, updatedAt: new Date() })
      .where(eq(s.users.id, id));
    if (patch.address !== undefined || patch.gender !== undefined || patch.dob !== undefined) {
      await tx
        .update(s.citizenProfiles)
        .set({
          ...(patch.address !== undefined ? { address: patch.address } : {}),
          ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
          ...(patch.dob !== undefined ? { dob: toDateColumn(patch.dob) } : {}),
        })
        .where(eq(s.citizenProfiles.userId, id));
    }
    await audit(tx, c, 'account.updated', 'user', id, `Citizen ${row.username} updated`);
  });
  return publicUser(c.db, id);
}

/**
 * An administrator sets a password for someone (legacy admin "change password"):
 * the password given, or a generated temporary one; either way the user must
 * choose their own at the next sign-in, and every session is signed out.
 */
export async function adminSetPassword(c: ServiceContext, id: number, password?: string): Promise<{ account: PublicUser; temporaryPassword?: string }> {
  requireAdmin(c);
  let temporaryPassword: string | undefined;
  await c.db.transaction(async (tx) => {
    const row = await lockUser(tx, id);
    assert(row.portal !== 'admin' || row.id === c.user.id, 'Administrator passwords are changed by the administrator himself.');
    let next = password;
    if (next) {
      const problems = passwordPolicyProblems(next, { username: row.username, email: row.email });
      assert(!problems.length, `The password does not meet the policy: ${problems.join(' ')}`);
    } else {
      next = temporaryPassword = generateTemporaryPassword();
    }
    await tx
      .update(s.users)
      .set({ passwordHash: await argon2.hash(next, { type: argon2.argon2id }), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(s.users.id, id));
    await tx.update(s.refreshTokens).set({ revokedAt: new Date() }).where(and(eq(s.refreshTokens.userId, id), isNull(s.refreshTokens.revokedAt)));
    await audit(tx, c, 'account.password_set', 'user', id, `Password set for ${row.username} by the administrator`);
  });
  return { account: await publicUser(c.db, id), ...(temporaryPassword ? { temporaryPassword } : {}) };
}

// ---------------------------------------------------------------------------
// Activation and hand-over
// ---------------------------------------------------------------------------

export interface OpenTask {
  appl_id: number;
  appl_number: string;
  site_name: string;
  task: { task_id: number; name: string; state: string; role_id: number; stage_key: string };
}

/** Pending tasks (active, waiting or on demand) of an officer, in files still in process. */
export async function openTasksOf(c: Pick<ServiceContext, 'db'>, userId: number): Promise<OpenTask[]> {
  const rows = await c.db.execute<{ appl_id: number; appl_number: string | null; site_name: string; task_no: number; name: string; state: string; role_id: number; stage_key: string }>(sql`
    select a.id as appl_id, a.appl_number, a.site_name, t.task_no, t.name, t.state, t.role_id, t.stage_key
      from wf_tasks t
      join wf_instances i on i.id = t.instance_id and i.status = 'running'
      join applications a on a.id = i.subject_id and a.current_wf_instance_id = i.id and a.deleted_at is null
     where t.assignee_user_id = ${userId} and t.state in ('active', 'waiting', 'not_required')
       and t.task_no = (select max(t2.task_no) from wf_tasks t2 where t2.instance_id = t.instance_id and t2.stage_key = t.stage_key and t2.task_key = t.task_key)
     order by a.id, t.task_no`);
  return rows.rows.map((r) => ({
    appl_id: r.appl_id,
    appl_number: r.appl_number ?? '',
    site_name: r.site_name,
    task: { task_id: r.task_no, name: r.name, state: r.state, role_id: r.role_id, stage_key: r.stage_key },
  }));
}

export async function setActive(c: ServiceContext, id: number, active: boolean): Promise<PublicUser> {
  requireAdmin(c);
  await c.db.transaction(async (tx) => {
    const row = await lockUser(tx, id);
    assert(row.portal !== 'admin', 'Administrator accounts cannot be deactivated here.');
    if (!active && row.portal === 'dept') {
      const open = await openTasksOf({ db: tx as never }, id);
      if (open.length) {
        throw new AppError(
          409,
          'open-tasks',
          `${row.displayName} has ${open.length} open task${open.length === 1 ? '' : 's'}. Hand them over to another officer before deactivating the account.`,
        );
      }
    }
    await tx.update(s.users).set({ active, updatedAt: new Date() }).where(eq(s.users.id, id));
    if (!active) await tx.update(s.refreshTokens).set({ revokedAt: new Date() }).where(and(eq(s.refreshTokens.userId, id), isNull(s.refreshTokens.revokedAt)));
    await bumpDirectory(tx);
    await audit(tx, c, active ? 'account.activated' : 'account.deactivated', 'user', id, `${row.username} ${active ? 'activated' : 'deactivated'}`);
  });
  return publicUser(c.db, id);
}

/** Moves every pending task of one officer to another of the same role (before a deactivation or a transfer). */
export async function handOver(c: ServiceContext, fromId: number, toId: number): Promise<{ moved: number; applications: number }> {
  requireAdmin(c);
  const directory = c.cache.data<DirectoryBundle>('directory').officers;
  const from = directory.find((o) => o.id === fromId);
  const to = directory.find((o) => o.id === toId);
  if (!from) throw notFound('Department officer not found.');
  if (!to || !to.active) throw businessRule('Select an active department officer to hand the tasks over to.');
  if (from.role_id !== to.role_id) throw businessRule('Tasks can only be handed over to an officer of the same role.');
  const open = await openTasksOf(c, fromId);
  const appIds = [...new Set(open.map((o) => o.appl_id))];
  let moved = 0;
  const now = c.now ?? new Date();
  for (const appId of appIds) {
    await c.db.transaction(async (tx) => {
      const [row] = await tx.select().from(s.applications).where(eq(s.applications.id, appId)).for('update');
      const stored = await loadLiveInstance(tx, appId, formsOf(c.cache), true);
      if (!row || !stored) return;
      const ctx = workflowContext(c.cache, row.fireStationId, stored.definitionCode, now);
      const tr = handover(stored.instance, fromId, toId, ctx);
      const count = tr.events.filter((e) => e.type === 'TaskReassigned').length;
      if (!count) return;
      await persistInstance(tx, stored, tr.instance, tr.events, c.user.id);
      const effect = effectsOf(tr.events, { status_id: row.statusId, stage_label: row.stageLabel });
      await tx
        .update(s.applications)
        .set({ reviewer: pendingWithOf(c, tr.instance), rowVersion: row.rowVersion + 1, updatedBy: c.user.id })
        .where(eq(s.applications.id, appId));
      await logStep(tx, c, appId, 'Officer changed', `${from.displayName} → ${to.displayName} (${count} task${count === 1 ? '' : 's'})`, effect.status_id, {
        name: 'Portal Administrator',
        role: 'Admin',
        userId: c.user.id,
      });
      await audit(tx, c, 'workflow.handover', 'application', appId, `${from.username} → ${to.username}`);
      moved += count;
    });
  }
  return { moved, applications: appIds.length };
}

function pendingWithOf(c: Pick<ServiceContext, 'cache'>, instance: Instance): string {
  const roles = reference(c).deptRoles as { id: number; code: string }[];
  const latest = new Map<string, Instance['tasks'][number]>();
  for (const t of instance.tasks) {
    const k = `${t.stageKey}/${t.taskKey}`;
    if (!latest.has(k) || latest.get(k)!.no < t.no) latest.set(k, t);
  }
  return [...latest.values()]
    .filter((t) => t.state === 'active')
    .map((t) => (t.assignee ? t.assignee.name : `Unassigned (${roles.find((r) => r.id === Number(t.role))?.code ?? t.role})`))
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Unassigned tasks (Q-59)
// ---------------------------------------------------------------------------

export async function unassignedTasks(c: ServiceContext): Promise<
  { appl_id: number; appl_number: string; site_name: string; fire_station_id: number | null; task: { task_id: number; name: string; state: string; role_id: number }; candidates: { id: number; username: string; displayName: string }[] }[]
> {
  requireAdmin(c);
  const rows = await c.db.execute<{ appl_id: number; appl_number: string | null; site_name: string; fire_station_id: number | null; task_no: number; name: string; state: string; role_id: number }>(sql`
    select a.id as appl_id, a.appl_number, a.site_name, a.fire_station_id, t.task_no, t.name, t.state, t.role_id
      from wf_tasks t
      join wf_instances i on i.id = t.instance_id and i.status = 'running'
      join applications a on a.id = i.subject_id and a.current_wf_instance_id = i.id and a.deleted_at is null
     where t.assignee_user_id is null and t.state in ('active', 'waiting')
       and t.task_no = (select max(t2.task_no) from wf_tasks t2 where t2.instance_id = t.instance_id and t2.stage_key = t.stage_key and t2.task_key = t.task_key)
     order by (t.state = 'active') desc, a.id`);
  const officers = c.cache.data<DirectoryBundle>('directory').officers.filter((o) => o.active);
  return rows.rows.map((r) => ({
    appl_id: r.appl_id,
    appl_number: r.appl_number ?? '',
    site_name: r.site_name,
    fire_station_id: r.fire_station_id,
    task: { task_id: r.task_no, name: r.name, state: r.state, role_id: r.role_id },
    candidates: officers.filter((o) => o.role_id === r.role_id).map((o) => ({ id: o.id, username: o.username, displayName: o.displayName })),
  }));
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** Soft-deletes applications (legacy deleteOldFiles.aspx); their files are purged by the retention job. */
export async function deleteApplications(c: ServiceContext, ids: number[]): Promise<number> {
  requireAdmin(c);
  if (!ids.length) return 0;
  return c.db.transaction(async (tx) => {
    // Only drafts that were never submitted may be deleted (decided after B3): a
    // submitted application — and a revision of one — is a record that is kept.
    const kept = await tx.execute<{ id: number; appl_number: string | null }>(sql`
      select a.id, a.appl_number from applications a join statuses st on st.id = a.status_id
       where a.id in ${ids} and a.deleted_at is null and (st.category <> 'draft' or a.appl_number is not null)`);
    if (kept.rows.length) {
      throw businessRule(
        `Submitted applications cannot be deleted: ${kept.rows.map((r) => r.appl_number ?? `#${r.id}`).join(', ')}. Only drafts that were never submitted can be deleted.`,
      );
    }
    const removed = await tx
      .update(s.applications)
      .set({ deletedAt: new Date(), updatedBy: c.user.id })
      .where(and(inArray(s.applications.id, ids), isNull(s.applications.deletedAt)))
      .returning({ id: s.applications.id, number: s.applications.applNumber });
    if (removed.length) {
      const gone = removed.map((r) => r.id);
      await tx.update(s.applications).set({ childApplicationId: null }).where(inArray(s.applications.childApplicationId, gone));
      await tx.update(s.wfInstances).set({ status: 'archived' }).where(and(eq(s.wfInstances.subjectType, 'noc_application'), inArray(s.wfInstances.subjectId, gone), eq(s.wfInstances.status, 'running')));
      for (const r of removed) await audit(tx, c, 'application.deleted_by_admin', 'application', r.id, `Deleted ${r.number ?? `draft #${r.id}`}`);
    }
    return removed.length;
  });
}

// ---------------------------------------------------------------------------
// Statuses (N-4)
// ---------------------------------------------------------------------------

export interface StatusRow {
  code: number;
  desc: string;
  category: string;
  is_system: boolean;
  is_pre_decision: boolean;
  badge: string;
  sort_order: number;
  active: boolean;
  /** Applications / log entries / workflow versions that use the status. */
  used_by: { applications: number; history: number; workflows: number };
}

export async function listStatuses(c: Pick<ServiceContext, 'db'>): Promise<StatusRow[]> {
  const rows = await c.db.execute<{
    id: number; name: string; category: string; is_system: boolean; is_pre_decision: boolean; badge: string; sort_order: number; active: boolean;
    applications: string; history: string; workflows: string;
  }>(sql`
    with apps as (select status_id, count(*) as n from applications group by status_id),
         hist as (select status_id, count(*) as n from process_log group by status_id)
    select st.*,
           coalesce(apps.n, 0)::text as applications,
           coalesce(hist.n, 0)::text as history,
           (select count(*) from wf_definitions d join wf_definition_versions v on v.id = d.current_version_id
             where exists (select 1 from jsonb_array_elements(v.definition->'stages') x where (x->>'citizen_status')::int = st.id))::text as workflows
      from statuses st
      left join apps on apps.status_id = st.id
      left join hist on hist.status_id = st.id
     order by st.sort_order, st.id`);
  return rows.rows.map((r) => ({
    code: r.id,
    desc: r.name,
    category: r.category,
    is_system: r.is_system,
    is_pre_decision: r.is_pre_decision,
    badge: r.badge,
    sort_order: r.sort_order,
    active: r.active,
    used_by: { applications: Number(r.applications), history: Number(r.history), workflows: Number(r.workflows) },
  }));
}

export async function addStatus(c: ServiceContext, input: { desc: string; badge?: string; sort_order?: number; is_pre_decision?: boolean }): Promise<StatusRow[]> {
  requireAdmin(c);
  assert(input.desc?.trim().length > 1, 'Enter the name of the status.');
  await c.db.transaction(async (tx) => {
    const dup = await tx.select({ id: s.statuses.id }).from(s.statuses).where(sql`lower(${s.statuses.name}) = ${input.desc.trim().toLowerCase()}`);
    assert(!dup.length, 'A status with this name already exists.', 409);
    const [{ next }] = (await tx.execute<{ next: number }>(sql`select greatest(coalesce(max(id), 0) + 1, 10) as next from statuses`)).rows;
    await tx.insert(s.statuses).values({
      id: next,
      name: input.desc.trim(),
      category: 'in_process',
      isSystem: false,
      isPreDecision: !!input.is_pre_decision,
      badge: input.badge ?? 'REV',
      sortOrder: input.sort_order ?? 65,
      active: true,
    });
    await audit(tx, c, 'status.added', 'status', next, input.desc.trim());
  });
  return listStatuses(c);
}

export async function updateStatus(c: ServiceContext, id: number, patch: { desc?: string; badge?: string; sort_order?: number; active?: boolean; is_pre_decision?: boolean }): Promise<StatusRow[]> {
  requireAdmin(c);
  await c.db.transaction(async (tx) => {
    const [row] = await tx.select().from(s.statuses).where(eq(s.statuses.id, id)).for('update');
    if (!row) throw notFound('Status not found.');
    if (row.isSystem) throw businessRule('Statuses 1, 2, 7, 8 and 9 are system statuses and cannot be changed.');
    if (patch.active === false) {
      const usage = (await listStatuses({ db: tx as never })).find((r) => r.code === id)!;
      if (usage.used_by.workflows) throw businessRule('This status is still set by a workflow. Change the workflows first, then deactivate it.');
    }
    if (patch.desc !== undefined) assert(patch.desc.trim().length > 1, 'Enter the name of the status.');
    await tx
      .update(s.statuses)
      .set({
        ...(patch.desc !== undefined ? { name: patch.desc.trim() } : {}),
        ...(patch.badge !== undefined ? { badge: patch.badge } : {}),
        ...(patch.sort_order !== undefined ? { sortOrder: patch.sort_order } : {}),
        ...(patch.is_pre_decision !== undefined ? { isPreDecision: patch.is_pre_decision } : {}),
        ...(patch.active !== undefined ? { active: patch.active, retiredAt: patch.active ? null : new Date() } : {}),
      })
      .where(eq(s.statuses.id, id));
    await audit(tx, c, 'status.updated', 'status', id, JSON.stringify(patch));
  });
  return listStatuses(c);
}

/** Only an in-process status that nothing has ever used may be removed (N-4); used ones are deactivated instead. */
export async function removeStatus(c: ServiceContext, id: number): Promise<StatusRow[]> {
  requireAdmin(c);
  await c.db.transaction(async (tx) => {
    const [row] = await tx.select().from(s.statuses).where(eq(s.statuses.id, id)).for('update');
    if (!row) throw notFound('Status not found.');
    if (row.isSystem) throw businessRule('Statuses 1, 2, 7, 8 and 9 are system statuses and cannot be removed.');
    const usage = (await listStatuses({ db: tx as never })).find((r) => r.code === id)!;
    const used = usage.used_by.applications + usage.used_by.history + usage.used_by.workflows;
    if (used) throw conflict('This status has been used, so it is kept for the history. Deactivate it instead.');
    await tx.delete(s.statuses).where(eq(s.statuses.id, id));
    await audit(tx, c, 'status.removed', 'status', id, row.name);
  });
  return listStatuses(c);
}


