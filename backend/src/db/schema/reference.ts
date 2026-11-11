/**
 * Reference / master data. Every table is keyed by `id integer` (identity);
 * the legacy code of a row is a unique column, never the key.
 *
 * Rows whose legacy id is already an integer (districts, statuses, dept roles,
 * equipments, fire stations) are seeded with those ids, so every reference in
 * the historical data stays valid.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { statusCategory, equipmentLevel } from './enums.js';

const id = () => integer('id').generatedByDefaultAsIdentity().primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const regions = pgTable('regions', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const districts = pgTable('districts', {
  id: id(),
  name: text('name').notNull(),
  ddoCode: text('ddo_code').notNull().default(''),
  distCode: text('dist_code').notNull().default(''),
  regionId: integer('region_id').references(() => regions.id),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const fireStations = pgTable(
  'fire_stations',
  {
    id: id(),
    name: text('name').notNull(),
    districtId: integer('district_id')
      .notNull()
      .references(() => districts.id),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('fire_stations_district_idx').on(t.districtId)],
);

export const applicationTypes = pgTable('application_types', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  shortLabel: text('short_label').notNull().default(''),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default(''),
  instructions: jsonb('instructions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const applicationTypeModes = pgTable(
  'application_type_modes',
  {
    id: id(),
    applicationTypeId: integer('application_type_id')
      .notNull()
      .references(() => applicationTypes.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ffeColumns: jsonb('ffe_columns')
      .$type<{ tag: string; head: string; type: 'text' | 'input' }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('application_type_modes_uq').on(t.applicationTypeId, t.code)],
);

export const buildTypes = pgTable('build_types', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  minHeight: numeric('min_height', { precision: 8, scale: 3 }).notNull().default('0'),
  maxHeight: numeric('max_height', { precision: 8, scale: 3 }).notNull().default('0'),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const buildSubTypes = pgTable(
  'build_sub_types',
  {
    id: id(),
    buildTypeId: integer('build_type_id')
      .notNull()
      .references(() => buildTypes.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('build_sub_types_uq').on(t.buildTypeId, t.code)],
);

export const directions = pgTable('directions', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const hazards = pgTable('hazards', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  hazardCode: text('hazard_code').notNull().default(''),
});

export const mappedCodes = pgTable(
  'mapped_codes',
  {
    id: id(),
    activityDtcpCode: text('activity_dtcp_code').notNull(),
    dtcpDesc: text('dtcp_desc').notNull().default(''),
    activityNbcCode: text('activity_nbc_code').notNull().default(''),
    useDtcpCode: text('use_dtcp_code').notNull().default(''),
    useNbcCode: text('use_nbc_code').notNull().default(''),
  },
  (t) => [index('mapped_codes_dtcp_idx').on(t.activityDtcpCode)],
);

export const equipments = pgTable('equipments', {
  id: id(),
  description: text('description').notNull(),
  shortName: text('short_name').notNull().default(''),
  level: equipmentLevel('level').notNull(),
  suffix: text('suffix').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const ffeNotes = pgTable('ffe_notes', {
  id: id(),
  key: text('key').notNull().unique(),
  text: text('text').notNull(),
});

/**
 * Statuses 1, 2, 7, 8 and 9 are system statuses: they can never be removed or
 * reinterpreted. In-process statuses (3–6 today) may be added to; an in-process
 * status that has been used is retained but can be dropped from the workflows
 * (`active = false`). Code must never hard-code 3–6: use `category`,
 * `sort_order` and `is_pre_decision`.
 */
export const statuses = pgTable('statuses', {
  id: id(),
  name: text('name').notNull(),
  category: statusCategory('category').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  isPreDecision: boolean('is_pre_decision').notNull().default(false),
  badge: text('badge').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

export const deptRoles = pgTable('dept_roles', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  scope: text('scope').notNull().default('hq'),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
});

export const partyRoles = pgTable('party_roles', {
  id: id(),
  name: text('name').notNull().unique(),
  requiredFor: text('required_for').array().notNull().default(sql`'{}'::text[]`),
  sortOrder: integer('sort_order').notNull().default(0),
});

/** Block types, floor types, floor occupancies, escape types, side property types, lift types. */
export const blockOptionValues = pgTable(
  'block_option_values',
  {
    id: id(),
    groupKey: text('group_key').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('block_option_values_uq').on(t.groupKey, t.code)],
);

export const documentRequirements = pgTable('document_requirements', {
  id: id(),
  applicationTypeId: integer('application_type_id').references(() => applicationTypes.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull().default('general'),
  code: text('code').notNull(),
  label: text('label').notNull(),
  condition: text('condition').notNull().default('always'),
  optional: boolean('optional').notNull().default(false),
  appliesTo: text('applies_to').array().notNull().default(sql`'{}'::text[]`),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const occupancyConditions = pgTable('occupancy_conditions', {
  id: id(),
  checklistNo: integer('checklist_no').notNull().unique(),
  itemDesc: text('item_desc').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const undertakings = pgTable(
  'undertakings',
  {
    id: id(),
    applicationTypeId: integer('application_type_id')
      .notNull()
      .references(() => applicationTypes.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    text: text('text').notNull(),
    required: boolean('required').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('undertakings_uq').on(t.applicationTypeId, t.code)],
);

/** Verbatim legal / reference content (NOC conditions, NBC Table 7). */
export const referenceDocuments = pgTable('reference_documents', {
  id: id(),
  key: text('key').notNull().unique(),
  title: text('title').notNull().default(''),
  contentKind: text('content_kind').notNull().default('json'),
  payload: jsonb('payload').notNull(),
  source: text('source').notNull().default(''),
  version: integer('version').notNull().default(1),
  updatedAt: updatedAt(),
});

/** SMS / e-mail templates recovered from NOC-base/uploads/templates. */
export const notificationTemplates = pgTable('notification_templates', {
  id: id(),
  key: text('key').notNull().unique(),
  channel: text('channel').notNull().default('sms'),
  subject: text('subject').notNull().default(''),
  body: text('body').notNull(),
  placeholders: text('placeholders').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
});
