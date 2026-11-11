/**
 * The application aggregate (legacy `noc_applications` and its children).
 *
 * Convention: `id` is the surrogate key, `*_id` are foreign keys, and the
 * parent-local counters the portal uses on the wire (`block_id`, `doc_id`,
 * `fileid`, `step_id`, …) are stored as `*_no` with a unique key inside the
 * parent.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { delegationLevel, docRequestStatus, hostKind, paymentMode, paymentStatus, revisionKind } from './enums.js';
import { files } from './files.js';
import { users } from './identity.js';
import {
  applicationTypeModes,
  applicationTypes,
  districts,
  fireStations,
  partyRoles,
  statuses,
} from './reference.js';
import { wfInstances, wfTasks } from './workflow.js';

const id = () => integer('id').generatedByDefaultAsIdentity().primaryKey();
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const measure = (name: string) => numeric(name, { precision: 12, scale: 3 });

export const applications = pgTable(
  'applications',
  {
    id: id(),
    applNumber: text('appl_number'),
    revision: smallint('revision').notNull().default(1),
    applicationTypeId: integer('application_type_id')
      .notNull()
      .references(() => applicationTypes.id),
    applicationTypeModeId: integer('application_type_mode_id').references(() => applicationTypeModes.id),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id),

    siteName: text('site_name').notNull().default(''),
    siteAddr: text('site_addr').notNull().default(''),
    corrAddr: text('corr_addr').notNull().default(''),
    districtId: integer('district_id').references(() => districts.id),
    fireStationId: integer('fire_station_id').references(() => fireStations.id),
    plotArea: measure('plot_area').notNull().default('0'),
    perimeter: measure('perimeter').notNull().default('0'),
    licAuth: text('lic_auth').notNull().default(''),
    licAddr: text('lic_addr').notNull().default(''),

    buildName: text('build_name').notNull().default(''),
    buildLandline: text('build_landline').notNull().default(''),
    buildMobile: text('build_mobile').notNull().default(''),
    buildEmail: text('build_email').notNull().default(''),
    buildAadhar: text('build_aadhar').notNull().default(''),

    refNo: text('ref_no').notNull().default(''),
    nocLevel: delegationLevel('noc_level'),
    lastInspectDate: date('last_inspect_date'),
    mcapproveDate: date('mcapprove_date'),
    appliedDate: date('applied_date'),
    finalDate: date('final_date'),
    validFrom: date('valid_from'),
    validTo: date('valid_to'),

    statusId: integer('status_id')
      .notNull()
      .references(() => statuses.id),
    delegationLevel: delegationLevel('delegation_level').notNull().default('DFO'),
    stageLabel: text('stage_label').notNull().default(''),
    reviewer: text('reviewer').notNull().default(''),

    locLat: numeric('loc_lat', { precision: 9, scale: 6 }).notNull().default('0'),
    locLng: numeric('loc_lng', { precision: 9, scale: 6 }).notNull().default('0'),
    hostName: hostKind('host_name'),

    parentApplicationId: integer('parent_application_id'),
    childApplicationId: integer('child_application_id'),

    declarationAccepted: boolean('declaration_accepted').notNull().default(false),
    currentWfInstanceId: integer('current_wf_instance_id').references(() => wfInstances.id),

    /** Cached aggregates, recomputed whenever blocks change. */
    builtAreaTotal: numeric('built_area_total', { precision: 14, scale: 3 }).notNull().default('0'),
    maxHeight: numeric('max_height', { precision: 8, scale: 3 }).notNull().default('0'),
    floorCount: integer('floor_count').notNull().default(0),
    blockCount: integer('block_count').notNull().default(0),

    /**
     * Lower-cased number, site name and address and builder, for the substring
     * search of every list (trigram GIN index, pg_trgm). Maintained by PostgreSQL.
     */
    searchText: text('search_text').generatedAlwaysAs(
      sql`lower(coalesce(appl_number, '') || ' ' || site_name || ' ' || site_addr || ' ' || build_name)`,
    ),

    rowVersion: integer('row_version').notNull().default(1),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    lastModified: timestamp('last_modified', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: integer('created_by').references(() => users.id),
    updatedBy: integer('updated_by').references(() => users.id),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('applications_number_uq')
      .on(t.applNumber)
      .where(sql`appl_number is not null and deleted_at is null`),
    index('applications_owner_idx').on(t.ownerUserId, t.statusId),
    // status + last change: the stale-draft and per-status lists sorted by idle days
    index('applications_status_idx').on(t.statusId, t.lastModified),
    index('applications_district_idx').on(t.districtId, t.statusId),
    index('applications_level_idx').on(t.delegationLevel, t.applicationTypeId, t.statusId),
    index('applications_modified_idx').on(t.lastModified),
    index('applications_applied_idx').on(t.appliedDate),
    index('applications_parent_idx').on(t.parentApplicationId),
    index('applications_search_trgm_idx').using('gin', t.searchText.op('gin_trgm_ops')),
    index('applications_current_wf_idx').on(t.currentWfInstanceId),
    index('applications_station_idx').on(t.fireStationId, t.statusId),
  ],
);

export const applicationParties = pgTable(
  'application_parties',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    slNo: integer('sl_no').notNull(),
    partyRoleId: integer('party_role_id').references(() => partyRoles.id),
    roleName: text('role_name').notNull(),
    partyName: text('party_name').notNull().default(''),
    phoneNumber: text('phone_number').notNull().default(''),
    email: text('email').notNull().default(''),
    licenseNo: text('license_no').notNull().default(''),
  },
  (t) => [uniqueIndex('application_parties_uq').on(t.applicationId, t.slNo)],
);

export const applicationConditions = pgTable(
  'application_conditions',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    checklistNo: integer('checklist_no').notNull(),
    itemDesc: text('item_desc').notNull(),
    selected: boolean('selected'),
  },
  (t) => [uniqueIndex('application_conditions_uq').on(t.applicationId, t.checklistNo)],
);

export const applicationFeedback = pgTable('application_feedback', {
  id: id(),
  applicationId: integer('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' })
    .unique(),
  rating: smallint('rating').notNull(),
  remarks: text('remarks').notNull().default(''),
  ratedOn: date('rated_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payments = pgTable('payments', {
  id: id(),
  applicationId: integer('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' })
    .unique(),
  mode: paymentMode('mode'),
  amount: money('amount').notNull().default('0'),
  status: paymentStatus('status').notNull().default('pending'),
  challanNum: text('challan_num').notNull().default(''),
  challanDate: date('challan_date'),
  challanBank: text('challan_bank').notNull().default(''),
  challanBranch: text('challan_branch').notNull().default(''),
  txnRef: text('txn_ref').notNull().default(''),
  paidOn: date('paid_on'),
  /** The fee breakdown frozen at payment, with the rule version that produced it. */
  feeBreakdown: jsonb('fee_breakdown'),
  feeRuleVersionId: integer('fee_rule_version_id'),
  idempotencyKey: text('idempotency_key'),
  gatewayPayload: jsonb('gateway_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const paymentEvents = pgTable('payment_events', {
  id: id(),
  paymentId: integer('payment_id')
    .notNull()
    .references(() => payments.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  payload: jsonb('payload'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

/** The citizen-visible timeline (legacy process steps). Append-only. */
export const processLog = pgTable(
  'process_log',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    stepNo: integer('step_no').notNull(),
    actorUserId: integer('actor_user_id').references(() => users.id),
    reviewerName: text('reviewer_name').notNull().default(''),
    role: text('role').notNull().default(''),
    statusId: integer('status_id').references(() => statuses.id),
    action: text('action').notNull(),
    remarks: text('remarks').notNull().default(''),
    atDate: date('at_date'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('process_log_uq').on(t.applicationId, t.stepNo)],
);

export const smsMessages = pgTable(
  'sms_messages',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    smsNo: integer('sms_no').notNull(),
    message: text('message').notNull(),
    sentByUserId: integer('sent_by_user_id').references(() => users.id),
    sentByName: text('sent_by_name').notNull().default(''),
    sentOn: date('sent_on'),
    deliveryStatus: text('delivery_status').notNull().default('simulated'),
  },
  (t) => [uniqueIndex('sms_messages_uq').on(t.applicationId, t.smsNo)],
);

export const documentRequests = pgTable(
  'document_requests',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    requestNo: integer('request_no').notNull(),
    wfTaskId: integer('wf_task_id').references(() => wfTasks.id),
    fileName: text('file_name').notNull(),
    fileDesc: text('file_desc').notNull(),
    status: docRequestStatus('status').notNull().default('R'),
    citizenComment: text('citizen_comment').notNull().default(''),
    requestedByUserId: integer('requested_by_user_id').references(() => users.id),
    requestedByName: text('requested_by_name').notNull().default(''),
    requestedOn: date('requested_on'),
    respondedOn: date('responded_on'),
    responseFileId: uuid('response_file_id').references(() => files.id),
  },
  (t) => [uniqueIndex('document_requests_uq').on(t.applicationId, t.requestNo)],
);

export const applicationDocuments = pgTable(
  'application_documents',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    docNo: integer('doc_no').notNull(),
    /** Requirement code, e.g. ChallanCopy, SitePlan:1, FloorPlan:1:3, Requested:…, FinalDoc. */
    code: text('code').notNull(),
    fileId: uuid('file_id').references(() => files.id),
    category: text('category').notNull().default(''),
    uploadedOn: date('uploaded_on'),
    uploadedBy: integer('uploaded_by').references(() => users.id),
    blockNo: integer('block_no'),
    floorNo: integer('floor_no'),
    /** Kept for the seeded demo data, where only the metadata of the legacy upload exists. */
    fileNameFallback: text('file_name_fallback').notNull().default(''),
    sizeFallback: integer('size_fallback'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('application_documents_no_uq').on(t.applicationId, t.docNo),
    uniqueIndex('application_documents_code_uq')
      .on(t.applicationId, t.code)
      .where(sql`deleted_at is null`),
  ],
);

export const deptDocuments = pgTable(
  'dept_documents',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    docNo: integer('doc_no').notNull(),
    fileId: uuid('file_id').references(() => files.id),
    fileNameFallback: text('file_name_fallback').notNull().default(''),
    description: text('description').notNull().default(''),
    uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id),
    uploadedByName: text('uploaded_by_name').notNull().default(''),
    uploadedOn: date('uploaded_on'),
  },
  (t) => [uniqueIndex('dept_documents_uq').on(t.applicationId, t.docNo)],
);

/** Immutable snapshot of the aggregate at submit / decision / archive (Q-39). */
export const applicationRevisions = pgTable(
  'application_revisions',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    revision: smallint('revision').notNull(),
    kind: revisionKind('kind').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    assessment: jsonb('assessment'),
    ruleVersions: jsonb('rule_versions'),
    wfInstanceId: integer('wf_instance_id').references(() => wfInstances.id),
    checksum: text('checksum').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: integer('created_by').references(() => users.id),
  },
  (t) => [uniqueIndex('application_revisions_uq').on(t.applicationId, t.revision, t.kind)],
);

/** The latest server-side calculation (fee, level, renewal period, issues). */
export const applicationAssessments = pgTable('application_assessments', {
  id: id(),
  applicationId: integer('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' })
    .unique(),
  assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull().defaultNow(),
  feeTotal: money('fee_total').notNull().default('0'),
  feeBreakdown: jsonb('fee_breakdown'),
  approvalLevel: delegationLevel('approval_level'),
  renewalYears: smallint('renewal_years'),
  issues: jsonb('issues'),
  errorCount: integer('error_count').notNull().default(0),
  ruleVersions: jsonb('rule_versions'),
});
