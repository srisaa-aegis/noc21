/** Operational tables: cache versioning, audit, outbox, jobs, numbering, seed state. */
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './identity.js';

const id = () => integer('id').generatedByDefaultAsIdentity().primaryKey();

/**
 * One row per cache bundle. Statement-level triggers on every source table bump
 * `version` and NOTIFY 'noc_cache', which is how API processes and browsers
 * learn that reference data, rules or workflow configuration changed.
 */
export const cacheVersions = pgTable('cache_versions', {
  id: id(),
  bundle: text('bundle').notNull().unique(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    requestId: text('request_id').notNull().default(''),
    actorUserId: integer('actor_user_id').references(() => users.id),
    actorUsername: text('actor_username').notNull().default(''),
    actorPortal: text('actor_portal').notNull().default(''),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull().default(''),
    entityId: text('entity_id').notNull().default(''),
    summary: text('summary').notNull().default(''),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId, t.at), index('audit_log_actor_idx').on(t.actorUserId, t.at)],
);

export const configChangeLog = pgTable('config_change_log', {
  id: id(),
  area: text('area').notNull(),
  entityId: text('entity_id').notNull().default(''),
  before: jsonb('before'),
  after: jsonb('after'),
  changedBy: integer('changed_by').references(() => users.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: id(),
    kind: text('kind').notNull(),
    toAddress: text('to_address').notNull(),
    templateKey: text('template_key').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error').notNull().default(''),
    applicationId: integer('application_id'),
    userId: integer('user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('notification_outbox_status_idx').on(t.status, t.createdAt)],
);

export const jobRuns = pgTable('job_runs', {
  id: id(),
  jobName: text('job_name').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull().default('running'),
  detail: jsonb('detail'),
});

/** Gap-free `yyyymm` + sequence numbering, allocated atomically inside the submit transaction. */
export const applicationNumberSequence = pgTable('application_number_sequence', {
  id: id(),
  prefix: text('prefix').notNull().unique(),
  lastSeq: integer('last_seq').notNull().default(0),
});

export const seedState = pgTable('seed_state', {
  id: id(),
  name: text('name').notNull().unique(),
  checksum: text('checksum').notNull().default(''),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});
