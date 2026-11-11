/**
 * Runs lazily-built queries one after another. Inside a transaction there is one
 * connection anyway (pg queues, and warns about, concurrent queries on one client);
 * on the pool it keeps one request on one connection, so a burst of aggregate
 * loads cannot exhaust the pool (B3 load test: 100 concurrent users).
 */
async function inSequence<T extends readonly unknown[]>(queries: { [K in keyof T]: () => PromiseLike<T[K]> }): Promise<T> {
  const out: unknown[] = [];
  for (const q of queries) out.push(await q());
  return out as unknown as T;
}

/**
 * Reading the application aggregate and the list projections.
 *
 * The aggregate is loaded with one indexed query per child table and assembled
 * in memory — simpler and faster than one join that multiplies rows.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';

export type ApplicationRow = typeof s.applications.$inferSelect;
export type BlockRow = typeof s.blocks.$inferSelect;

export interface AggregateRows {
  application: ApplicationRow;
  typeCode: string;
  modeCode: string;
  ownerUsername: string;
  districtName: string;
  parties: (typeof s.applicationParties.$inferSelect)[];
  conditions: (typeof s.applicationConditions.$inferSelect)[];
  feedback: typeof s.applicationFeedback.$inferSelect | null;
  payment: typeof s.payments.$inferSelect | null;
  documents: ((typeof s.applicationDocuments.$inferSelect) & { originalName: string | null; sizeBytes: number | null })[];
  deptDocuments: ((typeof s.deptDocuments.$inferSelect) & { originalName: string | null })[];
  documentRequests: ((typeof s.documentRequests.$inferSelect) & { taskNo: number | null })[];
  sms: (typeof s.smsMessages.$inferSelect)[];
  processLog: (typeof s.processLog.$inferSelect)[];
  blocks: {
    block: BlockRow;
    sides: (typeof s.blockSides.$inferSelect)[];
    floors: (typeof s.blockFloors.$inferSelect)[];
    ospaces: (typeof s.blockOspaces.$inferSelect)[];
    escapes: (typeof s.blockEscapes.$inferSelect)[];
    exits: (typeof s.blockExits.$inferSelect)[];
    doors: (typeof s.blockDoors.$inferSelect)[];
    lifts: (typeof s.blockLifts.$inferSelect)[];
    refuges: (typeof s.blockRefuges.$inferSelect)[];
    carparks: (typeof s.blockCarparks.$inferSelect)[];
    roadWidening: (typeof s.blockRoadWidening.$inferSelect)[];
    ffe: (typeof s.blockFfeItems.$inferSelect)[];
  }[];
  instances: {
    instance: typeof s.wfInstances.$inferSelect;
    definitionCode: string;
    definitionVersion: number;
    definition: unknown;
    deciderUsername: string | null;
    tasks: ((typeof s.wfTasks.$inferSelect) & { assigneeUsername: string | null; formCode: string | null })[];
  }[];
}

export async function loadAggregate(db: Database, applicationId: number): Promise<AggregateRows | null> {
  const [row] = await db
    .select({
      application: s.applications,
      typeCode: s.applicationTypes.code,
      modeCode: s.applicationTypeModes.code,
      ownerUsername: s.users.username,
      districtName: s.districts.name,
    })
    .from(s.applications)
    .innerJoin(s.applicationTypes, eq(s.applicationTypes.id, s.applications.applicationTypeId))
    .leftJoin(s.applicationTypeModes, eq(s.applicationTypeModes.id, s.applications.applicationTypeModeId))
    .innerJoin(s.users, eq(s.users.id, s.applications.ownerUserId))
    .leftJoin(s.districts, eq(s.districts.id, s.applications.districtId))
    .where(and(eq(s.applications.id, applicationId), isNull(s.applications.deletedAt)))
    .limit(1);
  if (!row) return null;

  const [parties, conditions, feedback, payment, documents, deptDocuments, documentRequests, smsRows, log, blockRows] =
    await inSequence([
      () => db.select().from(s.applicationParties).where(eq(s.applicationParties.applicationId, applicationId)).orderBy(asc(s.applicationParties.slNo)),
      () => db.select().from(s.applicationConditions).where(eq(s.applicationConditions.applicationId, applicationId)).orderBy(asc(s.applicationConditions.checklistNo)),
      () => db.select().from(s.applicationFeedback).where(eq(s.applicationFeedback.applicationId, applicationId)).limit(1),
      () => db.select().from(s.payments).where(eq(s.payments.applicationId, applicationId)).limit(1),
      () => db
        .select({ doc: s.applicationDocuments, originalName: s.files.originalName, sizeBytes: s.files.sizeBytes })
        .from(s.applicationDocuments)
        .leftJoin(s.files, eq(s.files.id, s.applicationDocuments.fileId))
        .where(and(eq(s.applicationDocuments.applicationId, applicationId), isNull(s.applicationDocuments.deletedAt)))
        .orderBy(asc(s.applicationDocuments.docNo)),
      () => db
        .select({ doc: s.deptDocuments, originalName: s.files.originalName })
        .from(s.deptDocuments)
        .leftJoin(s.files, eq(s.files.id, s.deptDocuments.fileId))
        .where(eq(s.deptDocuments.applicationId, applicationId))
        .orderBy(asc(s.deptDocuments.docNo)),
      () => db
        .select({ request: s.documentRequests, taskNo: s.wfTasks.taskNo })
        .from(s.documentRequests)
        .leftJoin(s.wfTasks, eq(s.wfTasks.id, s.documentRequests.wfTaskId))
        .where(eq(s.documentRequests.applicationId, applicationId))
        .orderBy(asc(s.documentRequests.requestNo)),
      () => db.select().from(s.smsMessages).where(eq(s.smsMessages.applicationId, applicationId)).orderBy(asc(s.smsMessages.smsNo)),
      () => db.select().from(s.processLog).where(eq(s.processLog.applicationId, applicationId)).orderBy(asc(s.processLog.stepNo)),
      () => db.select().from(s.blocks).where(eq(s.blocks.applicationId, applicationId)).orderBy(asc(s.blocks.blockNo)),
    ]);

  const blockIds = blockRows.map((b) => b.id);
  const child = async <T>(table: { blockId: unknown }, order: unknown): Promise<T[]> =>
    blockIds.length
      ? ((await db
          .select()
          .from(table as never)
          .where(inArray((table as { blockId: never }).blockId, blockIds))
          .orderBy(order as never)) as T[])
      : [];

  const [sides, floors, ospaces, escapes, exits, doors, lifts, refuges, carparks, roadWidening, ffe] = await inSequence([
    () => child<typeof s.blockSides.$inferSelect>(s.blockSides, asc(s.blockSides.sideNo)),
    () => child<typeof s.blockFloors.$inferSelect>(s.blockFloors, asc(s.blockFloors.floorNo)),
    () => child<typeof s.blockOspaces.$inferSelect>(s.blockOspaces, asc(s.blockOspaces.ospaceNo)),
    () => child<typeof s.blockEscapes.$inferSelect>(s.blockEscapes, asc(s.blockEscapes.escapeNo)),
    () => child<typeof s.blockExits.$inferSelect>(s.blockExits, asc(s.blockExits.exitNo)),
    () => child<typeof s.blockDoors.$inferSelect>(s.blockDoors, asc(s.blockDoors.doorNo)),
    () => child<typeof s.blockLifts.$inferSelect>(s.blockLifts, asc(s.blockLifts.liftNo)),
    () => child<typeof s.blockRefuges.$inferSelect>(s.blockRefuges, asc(s.blockRefuges.refugeNo)),
    () => child<typeof s.blockCarparks.$inferSelect>(s.blockCarparks, asc(s.blockCarparks.cparkNo)),
    () => child<typeof s.blockRoadWidening.$inferSelect>(s.blockRoadWidening, asc(s.blockRoadWidening.id)),
    () => child<typeof s.blockFfeItems.$inferSelect>(s.blockFfeItems, asc(s.blockFfeItems.ordinal)),
  ]);

  const instanceRows = await db
    .select({
      instance: s.wfInstances,
      definitionCode: s.wfDefinitions.code,
      definitionVersion: s.wfDefinitionVersions.version,
      definition: s.wfDefinitionVersions.definition,
      deciderUsername: s.users.username,
    })
    .from(s.wfInstances)
    .innerJoin(s.wfDefinitions, eq(s.wfDefinitions.id, s.wfInstances.definitionId))
    .innerJoin(s.wfDefinitionVersions, eq(s.wfDefinitionVersions.id, s.wfInstances.definitionVersionId))
    .leftJoin(s.users, eq(s.users.id, s.wfInstances.deciderUserId))
    .where(and(eq(s.wfInstances.subjectType, 'noc_application'), eq(s.wfInstances.subjectId, applicationId)))
    .orderBy(asc(s.wfInstances.id));

  const taskRows = instanceRows.length
    ? await db
        .select({ task: s.wfTasks, assigneeUsername: s.users.username, formCode: s.wfForms.code })
        .from(s.wfTasks)
        .leftJoin(s.users, eq(s.users.id, s.wfTasks.assigneeUserId))
        .leftJoin(s.wfForms, eq(s.wfForms.id, s.wfTasks.formId))
        .where(inArray(s.wfTasks.instanceId, instanceRows.map((i) => i.instance.id)))
        .orderBy(asc(s.wfTasks.taskNo))
    : [];

  const byBlock = <T extends { blockId: number }>(rows: T[], blockId: number) => rows.filter((r) => r.blockId === blockId);

  return {
    application: row.application,
    typeCode: row.typeCode,
    modeCode: row.modeCode ?? '',
    ownerUsername: row.ownerUsername,
    districtName: row.districtName ?? '',
    parties,
    conditions,
    feedback: feedback[0] ?? null,
    payment: payment[0] ?? null,
    documents: documents.map((d) => ({ ...d.doc, originalName: d.originalName, sizeBytes: d.sizeBytes })),
    deptDocuments: deptDocuments.map((d) => ({ ...d.doc, originalName: d.originalName })),
    documentRequests: documentRequests.map((r) => ({ ...r.request, taskNo: r.taskNo })),
    sms: smsRows,
    processLog: log,
    blocks: blockRows.map((block) => ({
      block,
      sides: byBlock(sides, block.id),
      floors: byBlock(floors, block.id),
      ospaces: byBlock(ospaces, block.id),
      escapes: byBlock(escapes, block.id),
      exits: byBlock(exits, block.id),
      doors: byBlock(doors, block.id),
      lifts: byBlock(lifts, block.id),
      refuges: byBlock(refuges, block.id),
      carparks: byBlock(carparks, block.id),
      roadWidening: byBlock(roadWidening, block.id),
      ffe: byBlock(ffe, block.id),
    })),
    instances: instanceRows.map((i) => ({
      instance: i.instance,
      definitionCode: i.definitionCode,
      definitionVersion: i.definitionVersion,
      definition: i.definition,
      deciderUsername: i.deciderUsername,
      tasks: taskRows
        .filter((t) => t.task.instanceId === i.instance.id)
        .map((t) => ({ ...t.task, assigneeUsername: t.assigneeUsername, formCode: t.formCode })),
    })),
  };
}

// ---------------------------------------------------------------------------
// List / search
// ---------------------------------------------------------------------------

export interface ListQuery {
  ownerUserId?: number;
  submittedOnly?: boolean;
  draftsOnly?: boolean;
  type?: string;
  statusId?: number;
  level?: string;
  districtId?: number;
  text?: string;
  idleDays?: number;
  /** Department jurisdiction: the officer's stations, plus files he has worked on. */
  jurisdiction?: { stationIds: number[]; userId: number };
  page: number;
  pageSize: number;
  sort?: string;
}

export interface SummaryRow extends Record<string, unknown> {
  appl_id: number;
  appl_number: string | null;
  appl_type: string;
  appl_mode: string;
  revision: number;
  owner: string;
  site_name: string;
  site_addr: string;
  site_type: string;
  height: string;
  flr_count: number;
  built_area: string;
  build_name: string;
  build_landline: string;
  build_mobile: string;
  build_email: string;
  challan_amt: string;
  applied_date: string | null;
  final_date: string | null;
  last_modified: Date;
  status_id: number;
  status_category: string;
  delegation_level: string;
  dist_name: string;
  district_id: number | null;
  fire_station_id: number | null;
  host_name: string | null;
  reviewer: string;
  parent_id: number;
  child_id: number;
  pending_requests: string;
  valid_to: string | null;
  rating: number | null;
  challan_paid: boolean | null;
  bank_guarantee: boolean;
  undertaking: boolean;
  form16: boolean;
  fire_draw_5: boolean;
  days_idle: number | null;
}

/** Sort keys of the list → expressions over `applications a` (the lean query sorts, the view only decorates a page). */
const SORTABLE: Record<string, string> = {
  appl_id: 'a.id',
  appl_number: 'a.appl_number',
  site_name: 'a.site_name',
  last_modified: 'a.last_modified',
  applied_date: 'a.applied_date',
  status_id: 'a.status_id',
  // days idle = today − last modified: sorted on the (indexed) timestamp, direction reversed below
  days_idle: 'a.last_modified',
};

const escapeLike = (t: string) => t.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * Free-text search over `applications a`: number, site name and address and
 * builder (one trigram-indexed column, `search_text`), the district name, the
 * owner (username, name or e-mail) and the exact application id. The matching
 * districts and owners are looked up first, so the condition is a plain OR of
 * indexed predicates that PostgreSQL can combine (BitmapOr) — fast at hundreds of
 * thousands of applications. LIKE wildcards typed by the user are literal.
 */
export async function applicationTextFilter(db: Database, text: string): Promise<SQL> {
  const t = text.trim().toLowerCase();
  const like = `%${escapeLike(t)}%`;
  const OWNERS_MAX = 2000;
  const [districts, owners] = await Promise.all([
    db.execute<{ id: number }>(sql`select id from districts where lower(name) like ${like}`),
    db.execute<{ id: number }>(sql`select id from users where lower(username || ' ' || display_name || ' ' || email) like ${like} limit ${OWNERS_MAX + 1}`),
  ]);
  const parts: SQL[] = [sql`a.search_text like ${like}`];
  const districtIds = districts.rows.map((r) => Number(r.id));
  if (districtIds.length) parts.push(sql`a.district_id in ${districtIds}`);
  const ownerIds = owners.rows.map((r) => Number(r.id));
  if (ownerIds.length > OWNERS_MAX) {
    // a very common word: the sub-select is as good as a list here
    parts.push(sql`a.owner_user_id in (select id from users where lower(username || ' ' || display_name || ' ' || email) like ${like})`);
  } else if (ownerIds.length) {
    parts.push(sql`a.owner_user_id in ${ownerIds}`);
  }
  if (/^\d{1,9}$/.test(t)) parts.push(sql`a.id = ${Number(t)}`);
  return sql`(${sql.join(parts, sql` or `)})`;
}

/** The flat list rows (v_application_summary) of the given ids, in that order. */
export async function summariesByIds(db: Database, ids: number[]): Promise<SummaryRow[]> {
  if (!ids.length) return [];
  const rows = await db.execute<SummaryRow>(sql`
    select *, (now()::date - last_modified::date) as days_idle
    from v_application_summary where appl_id in ${ids}`);
  const byId = new Map(rows.rows.map((r) => [Number(r.appl_id), r]));
  return ids.map((id) => byId.get(id)).filter((r): r is SummaryRow => !!r);
}

export async function listSummaries(
  db: Database,
  q: ListQuery,
): Promise<{ items: SummaryRow[]; total: number }> {
  // Filter and sort on `applications` alone (indexed columns); the summary view
  // — joins, document flags, counts — is evaluated for the rows of one page only.
  // Status and type ids are resolved first: literal ids let the planner use the column statistics
  // (a sub-select hides them — B3 performance review: drafts sorted by idle days went from 0.6 s to ms).
  const draftIds = q.submittedOnly || q.draftsOnly ? (await db.execute<{ id: number }>(sql`select id from statuses where category = 'draft'`)).rows.map((r) => Number(r.id)) : [];
  const where: SQL[] = [sql`a.deleted_at is null`];
  if (q.ownerUserId !== undefined) where.push(sql`a.owner_user_id = ${q.ownerUserId}`);
  if (q.submittedOnly && draftIds.length) where.push(sql`a.status_id not in ${draftIds}`);
  if (q.draftsOnly) where.push(draftIds.length ? sql`a.status_id in ${draftIds}` : sql`false`);
  if (q.type) {
    const typeIds = (await db.execute<{ id: number }>(sql`select id from application_types where code = ${q.type}`)).rows.map((r) => Number(r.id));
    where.push(typeIds.length ? sql`a.application_type_id in ${typeIds}` : sql`false`);
  }
  if (q.statusId) where.push(sql`a.status_id = ${q.statusId}`);
  if (q.level) where.push(sql`a.delegation_level = ${q.level}`);
  if (q.districtId) where.push(sql`a.district_id = ${q.districtId}`);
  if (q.idleDays) where.push(sql`a.last_modified <= now() - (${q.idleDays} || ' days')::interval`);
  if (q.jurisdiction) {
    const stations = q.jurisdiction.stationIds.length ? sql`a.fire_station_id in ${q.jurisdiction.stationIds}` : sql`false`;
    where.push(sql`(${stations} or a.id in (select i.subject_id from wf_tasks t join wf_instances i on i.id = t.instance_id
                                             where t.assignee_user_id = ${q.jurisdiction.userId} and i.subject_type = 'noc_application'))`);
  }
  if (q.text?.trim()) where.push(await applicationTextFilter(db, q.text));
  const whereSql = sql.join(where, sql` and `);
  const sort = q.sort ?? '-appl_id';
  const key = sort.replace(/^-/, '');
  const orderColumn = SORTABLE[key] ?? 'a.id';
  const descending = sort.startsWith('-') !== (key === 'days_idle');
  const direction = sql.raw(descending ? 'desc' : 'asc');
  const offset = (q.page - 1) * q.pageSize;

  const [page, totalRows] = await Promise.all([
    db.execute<{ id: number }>(sql`
      select a.id from applications a
      where ${whereSql}
      order by ${sql.raw(orderColumn)} ${direction} nulls last, a.id ${direction}
      limit ${q.pageSize} offset ${offset}`),
    db.execute<{ count: string }>(sql`select count(*)::text as count from applications a where ${whereSql}`),
  ]);
  const items = await summariesByIds(db, page.rows.map((r) => Number(r.id)));
  return { items, total: Number(totalRows.rows[0]?.count ?? 0) };
}

/** Applications in the jurisdiction of an officer (dept scope). */
export async function officerScope(
  db: Database,
  userId: number,
): Promise<{ allStations: boolean; stationIds: number[]; roleId: number; monitoring: boolean } | null> {
  const [profile] = await db
    .select({ roleId: s.deptProfiles.roleId, allStations: s.deptProfiles.allStations, roleCode: s.deptRoles.code })
    .from(s.deptProfiles)
    .innerJoin(s.deptRoles, eq(s.deptRoles.id, s.deptProfiles.roleId))
    .where(eq(s.deptProfiles.userId, userId))
    .limit(1);
  if (!profile) return null;
  const stations = await db.select().from(s.deptUserStations).where(eq(s.deptUserStations.userId, userId));
  return {
    allStations: profile.allStations,
    stationIds: stations.map((x) => x.fireStationId),
    roleId: profile.roleId,
    monitoring: profile.roleCode === 'VIEW',
  };
}

export const dateFilters = { and, or, gte, lte, desc };
