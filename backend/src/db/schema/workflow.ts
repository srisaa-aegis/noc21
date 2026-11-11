/**
 * Storage for @srisaa/workflow-engine (the engine core lands in phase B2).
 *
 * Generic: a workflow runs over a "subject" identified by `subject_type` +
 * `subject_id`, and actors/roles are opaque integer ids. The NOC-specific link
 * (type × level → definition, and the application the instance belongs to) is
 * the `noc_workflow_bindings` table at the bottom.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { applicationTypes, deptRoles } from './reference.js';
import { files } from './files.js';
import { users } from './identity.js';
import { delegationLevel, wfEscalationKind, wfFormKind, wfInstanceStatus, wfTaskState } from './enums.js';

const id = () => integer('id').generatedByDefaultAsIdentity().primaryKey();

/** Note / report forms a workflow task can use. */
export const wfForms = pgTable('wf_forms', {
  id: id(),
  code: text('code').notNull().unique(),
  kind: wfFormKind('kind').notNull(),
  name: text('name').notNull(),
  definition: jsonb('definition').notNull().default(sql`'{}'::jsonb`),
  /** SLA class, e.g. "inspection" — maps to wf_sla_policies.class_days. */
  slaClass: text('sla_class'),
  isDecision: boolean('is_decision').notNull().default(false),
  legacy: text('legacy').notNull().default(''),
  summary: text('summary').notNull().default(''),
  active: boolean('active').notNull().default(true),
});

export const wfDefinitions = pgTable('wf_definitions', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  subjectType: text('subject_type').notNull().default('noc_application'),
  currentVersionId: integer('current_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
});

/** Immutable snapshot of one version of a process definition. */
export const wfDefinitionVersions = pgTable(
  'wf_definition_versions',
  {
    id: id(),
    definitionId: integer('definition_id')
      .notNull()
      .references(() => wfDefinitions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    checksum: text('checksum').notNull().default(''),
    notes: text('notes').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: integer('created_by').references(() => users.id),
  },
  (t) => [uniqueIndex('wf_definition_versions_uq').on(t.definitionId, t.version)],
);

/** Roles and forms referenced by a version — extracted on save for integrity and usage queries. */
export const wfVersionRoles = pgTable(
  'wf_version_roles',
  {
    id: id(),
    versionId: integer('version_id')
      .notNull()
      .references(() => wfDefinitionVersions.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => deptRoles.id),
  },
  (t) => [uniqueIndex('wf_version_roles_uq').on(t.versionId, t.roleId)],
);

export const wfVersionForms = pgTable(
  'wf_version_forms',
  {
    id: id(),
    versionId: integer('version_id')
      .notNull()
      .references(() => wfDefinitionVersions.id, { onDelete: 'cascade' }),
    formId: integer('form_id')
      .notNull()
      .references(() => wfForms.id),
  },
  (t) => [uniqueIndex('wf_version_forms_uq').on(t.versionId, t.formId)],
);

export const wfSlaPolicies = pgTable('wf_sla_policies', {
  id: id(),
  definitionId: integer('definition_id')
    .notNull()
    .references(() => wfDefinitions.id, { onDelete: 'cascade' })
    .unique(),
  totalDays: integer('total_days').notNull(),
  classDays: jsonb('class_days').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  taskDays: jsonb('task_days').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
});

export const wfEscalationSettings = pgTable('wf_escalation_settings', {
  id: integer('id').primaryKey(),
  notifyAssignee: boolean('notify_assignee').notNull().default(true),
  notifyDecider: boolean('notify_decider').notNull().default(true),
  remindEveryDays: integer('remind_every_days').notNull().default(7),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by').references(() => users.id),
});

export const wfInstances = pgTable(
  'wf_instances',
  {
    id: id(),
    definitionId: integer('definition_id')
      .notNull()
      .references(() => wfDefinitions.id),
    definitionVersionId: integer('definition_version_id')
      .notNull()
      .references(() => wfDefinitionVersions.id),
    subjectType: text('subject_type').notNull(),
    subjectId: integer('subject_id').notNull(),
    /** NOC: the application revision this run belongs to. */
    cycle: integer('cycle').notNull().default(1),
    status: wfInstanceStatus('status').notNull().default('running'),
    outcome: text('outcome'),
    deciderUserId: integer('decider_user_id').references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lockVersion: integer('lock_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wf_instances_subject_idx').on(t.subjectType, t.subjectId),
    index('wf_instances_version_idx').on(t.definitionVersionId),
    // the runs in process, longest pending first (monitoring, pendency, escalations)
    index('wf_instances_open_idx')
      .on(t.startedAt)
      .where(sql`completed_at is null`),
    uniqueIndex('wf_instances_live_uq')
      .on(t.subjectType, t.subjectId)
      .where(sql`status <> 'archived'`),
  ],
);

export const wfTasks = pgTable(
  'wf_tasks',
  {
    id: id(),
    instanceId: integer('instance_id')
      .notNull()
      .references(() => wfInstances.id, { onDelete: 'cascade' }),
    /** Parent-local task number (the `task_id` the portal shows). */
    taskNo: integer('task_no').notNull(),
    stageKey: text('stage_key').notNull(),
    taskKey: text('task_key').notNull(),
    name: text('name').notNull(),
    roleId: integer('role_id').references(() => deptRoles.id),
    assigneeUserId: integer('assignee_user_id').references(() => users.id),
    assigneeName: text('assignee_name').notNull().default(''),
    state: wfTaskState('state').notNull().default('waiting'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** Computed from the SLA policy when the task is activated — drives the overdue scan. */
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    formId: integer('form_id').references(() => wfForms.id),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    draft: boolean('draft').notNull().default(false),
    remarks: text('remarks').notNull().default(''),
    /** Form-specific short result, e.g. the inspection recommendation Y/N. */
    resultCode: text('result_code'),
    outcome: text('outcome'),
    sentBackToStage: text('sent_back_to_stage'),
    supersedesTaskId: integer('supersedes_task_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wf_tasks_instance_no_uq').on(t.instanceId, t.taskNo),
    // instance_id included: "the files I worked on" is an index-only scan (monitoring scope)
    index('wf_tasks_assignee_idx').on(t.assigneeUserId, t.state, t.instanceId),
    index('wf_tasks_instance_idx').on(t.instanceId, t.stageKey, t.taskKey),
    index('wf_tasks_due_idx').on(t.state, t.dueAt),
  ],
);

export const wfTaskAttachments = pgTable('wf_task_attachments', {
  id: id(),
  taskId: integer('task_id')
    .notNull()
    .references(() => wfTasks.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id')
    .notNull()
    .references(() => files.id),
  purpose: text('purpose').notNull().default('attachment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only event log of the engine. */
export const wfEvents = pgTable(
  'wf_events',
  {
    id: id(),
    instanceId: integer('instance_id')
      .notNull()
      .references(() => wfInstances.id, { onDelete: 'cascade' }),
    taskId: integer('task_id'),
    type: text('type').notNull(),
    actorUserId: integer('actor_user_id').references(() => users.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('wf_events_instance_idx').on(t.instanceId, t.at)],
);

export const wfReminders = pgTable(
  'wf_reminders',
  {
    id: id(),
    instanceId: integer('instance_id')
      .notNull()
      .references(() => wfInstances.id, { onDelete: 'cascade' }),
    taskId: integer('task_id'),
    kind: wfEscalationKind('kind').notNull(),
    lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('wf_reminders_uq').on(t.instanceId, t.taskId, t.kind)],
);

export const wfEscalationRuns = pgTable('wf_escalation_runs', {
  id: id(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  triggeredBy: text('triggered_by').notNull().default('scheduler'),
  noticesCount: integer('notices_count').notNull().default(0),
  recipientsCount: integer('recipients_count').notNull().default(0),
  dryRun: boolean('dry_run').notNull().default(false),
});

export const wfEscalationNotices = pgTable('wf_escalation_notices', {
  id: id(),
  runId: integer('run_id')
    .notNull()
    .references(() => wfEscalationRuns.id, { onDelete: 'cascade' }),
  instanceId: integer('instance_id').notNull(),
  taskId: integer('task_id'),
  kind: wfEscalationKind('kind').notNull(),
  taskName: text('task_name').notNull().default(''),
  daysPending: integer('days_pending').notNull().default(0),
  slaDays: integer('sla_days').notNull().default(0),
  recipientUserIds: integer('recipient_user_ids').array().notNull().default(sql`'{}'::integer[]`),
});

/** NOC binding: application type × approval level → workflow definition. */
export const nocWorkflowBindings = pgTable(
  'noc_workflow_bindings',
  {
    id: id(),
    applicationTypeId: integer('application_type_id')
      .notNull()
      .references(() => applicationTypes.id),
    level: delegationLevel('level').notNull(),
    definitionId: integer('definition_id')
      .notNull()
      .references(() => wfDefinitions.id),
  },
  (t) => [uniqueIndex('noc_workflow_bindings_uq').on(t.applicationTypeId, t.level)],
);
