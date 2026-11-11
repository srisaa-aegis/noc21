/**
 * Storage for @srisaa/rules-engine. Generic: no NOC columns, so another
 * application can reuse these tables (and the engine) unchanged.
 *
 * A published version is immutable (enforced by a trigger) and is what every
 * calculation records, so any fee or approval level can be explained years
 * later with the exact rule that produced it.
 */
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { reRuleKind, reVersionStatus } from './enums.js';

const id = () => integer('id').generatedByDefaultAsIdentity().primaryKey();

export const reRuleSets = pgTable('re_rule_sets', {
  id: id(),
  code: text('code').notNull().unique(),
  kind: reRuleKind('kind').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** Admin-editable through the portal (tables and parameters), or seed-managed (trees). */
  editable: boolean('editable').notNull().default(false),
  inputSchema: jsonb('input_schema'),
  outputSchema: jsonb('output_schema'),
  currentVersionId: integer('current_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reRuleSetVersions = pgTable(
  're_rule_set_versions',
  {
    id: id(),
    ruleSetId: integer('rule_set_id')
      .notNull()
      .references(() => reRuleSets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    checksum: text('checksum').notNull().default(''),
    status: reVersionStatus('status').notNull().default('draft'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: integer('published_by'),
    notes: text('notes').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: integer('created_by'),
  },
  (t) => [uniqueIndex('re_rule_set_versions_uq').on(t.ruleSetId, t.version)],
);

/** Regression cases that must pass before a version may be published. */
export const reRuleTestCases = pgTable('re_rule_test_cases', {
  id: id(),
  ruleSetId: integer('rule_set_id')
    .notNull()
    .references(() => reRuleSets.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  facts: jsonb('facts').notNull(),
  expected: jsonb('expected'),
  source: text('source').notNull().default(''),
});
