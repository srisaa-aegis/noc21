/**
 * Blocks (one physical building) and their children.
 *
 * The FFE grid is stored as one row per equipment item with its cells in
 * `jsonb`: the grid is always read and written as a whole for a block, and the
 * server recomputes it on every save — a cell table would add ~26 M rows a year
 * at 100 000 applications. The three summary columns keep the questions that
 * inspectors and reports actually ask indexable.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { applications } from './applications.js';
import { buildSubTypes, buildTypes, directions, equipments } from './reference.js';
import { equipmentLevel } from './enums.js';

const id = () => integer('id').generatedByDefaultAsIdentity().primaryKey();
const measure = (name: string) => numeric(name, { precision: 12, scale: 3 });

export const blocks = pgTable(
  'blocks',
  {
    id: id(),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Parent-local id (`block_id` on the wire). */
    blockNo: integer('block_no').notNull(),
    slNo: integer('sl_no').notNull().default(1),
    blockName: text('block_name').notNull().default(''),
    /** N = normal, T = tower, P = podium. */
    blockType: text('block_type').notNull().default('N'),
    buildTypeId: integer('build_type_id').references(() => buildTypes.id),
    siteType: text('site_type').notNull().default(''),
    buildSubTypeId: integer('build_sub_type_id').references(() => buildSubTypes.id),
    siteSType: text('site_stype').notNull().default(''),
    isMixed: boolean('is_mixed').notNull().default(false),
    isMultiplex: boolean('is_multiplex').notNull().default(false),
    isMiniplex: boolean('is_miniplex').notNull().default(false),
    beds: text('beds').notNull().default(''),
    height: measure('height').notNull().default('0'),
    permissibleHeight: measure('permissible_height').notNull().default('0'),
    roadWide: boolean('road_wide').notNull().default(false),
    xferSbak: boolean('xfer_sbak').notNull().default(false),
    frontDirectionId: integer('front_direction_id').references(() => directions.id),
    frontDir: text('front_dir').notNull().default(''),
    taDist: measure('ta_dist').notNull().default('0'),
    taDead: measure('ta_dead').notNull().default('0'),
    hrclear: measure('hrclear').notNull().default('0'),
    ffeNoteKeys: text('ffe_note_keys').array().notNull().default(sql`'{}'::text[]`),
    ffeAgreeReqt: boolean('ffe_agree_reqt').notNull().default(false),
    builtAreaTotal: numeric('built_area_total', { precision: 14, scale: 3 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('blocks_local_uq').on(t.applicationId, t.blockNo),
    index('blocks_application_idx').on(t.applicationId),
  ],
);

export const blockRoadWidening = pgTable(
  'block_road_widening',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    direc: text('rw_direc').notNull(),
    rwReqd: measure('rw_reqd').notNull().default('0'),
  },
  (t) => [uniqueIndex('block_road_widening_uq').on(t.blockId, t.direc)],
);

export const blockSides = pgTable(
  'block_sides',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    sideNo: integer('side_no').notNull(),
    direc: text('direc').notNull().default(''),
    /** R = road, B = building, S = open space, O = others. */
    ptype: text('ptype').notNull().default(''),
    pname: text('pname').notNull().default(''),
    width: measure('width').notNull().default('0'),
  },
  (t) => [uniqueIndex('block_sides_uq').on(t.blockId, t.sideNo)],
);

export const blockFloors = pgTable(
  'block_floors',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    floorNo: integer('floor_no').notNull(),
    ordinal: integer('ordinal').notNull().default(0),
    /** B = basement, S = stilt, G = ground, F = floor, T = terrace. */
    flrType: text('flr_type').notNull().default('F'),
    flrName: text('flr_name').notNull().default(''),
    builtArea: measure('built_area').notNull().default('0'),
    occType: text('occ_type').notNull().default(''),
    occCApp: integer('occ_c_app').notNull().default(0),
    seatsNum: integer('seats_num').notNull().default(0),
    parentBuiltArea: measure('parent_built_area'),
    parentOccCApp: integer('parent_occ_c_app'),
  },
  (t) => [uniqueIndex('block_floors_uq').on(t.blockId, t.floorNo), index('block_floors_block_idx').on(t.blockId)],
);

export const blockOspaces = pgTable(
  'block_ospaces',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    ospaceNo: integer('ospace_no').notNull(),
    direc: text('direc').notNull().default(''),
    proposed: measure('proposed').notNull().default('0'),
    projection: measure('projection'),
    parentProposed: measure('parent_proposed'),
    osPreqd: measure('os_preqd'),
  },
  (t) => [uniqueIndex('block_ospaces_uq').on(t.blockId, t.ospaceNo)],
);

export const blockEscapes = pgTable(
  'block_escapes',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    escapeNo: integer('escape_no').notNull(),
    /** I = internal stair, E = external stair, R = ramp, C = basement ramp. */
    etype: text('etype').notNull().default(''),
    description: text('description').notNull().default(''),
    width: measure('width').notNull().default('0'),
    location: text('location').notNull().default(''),
    fromFloorNo: integer('from_floor_no'),
    toFloorNo: integer('to_floor_no'),
  },
  (t) => [uniqueIndex('block_escapes_uq').on(t.blockId, t.escapeNo)],
);

export const blockExits = pgTable(
  'block_exits',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    exitNo: integer('exit_no').notNull(),
    ename: text('ename').notNull().default(''),
    width: measure('width').notNull().default('0'),
    awidth: measure('awidth').notNull().default('0'),
    direc: text('direc').notNull().default(''),
  },
  (t) => [uniqueIndex('block_exits_uq').on(t.blockId, t.exitNo)],
);

export const blockDoors = pgTable(
  'block_doors',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    doorNo: integer('door_no').notNull(),
    description: text('description').notNull().default(''),
    width: measure('width').notNull().default('0'),
    location: text('location').notNull().default(''),
  },
  (t) => [uniqueIndex('block_doors_uq').on(t.blockId, t.doorNo)],
);

export const blockLifts = pgTable(
  'block_lifts',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    liftNo: integer('lift_no').notNull(),
    ltype: text('ltype').notNull().default(''),
    lname: text('lname').notNull().default(''),
    capacity: integer('capacity').notNull().default(0),
  },
  (t) => [uniqueIndex('block_lifts_uq').on(t.blockId, t.liftNo)],
);

export const blockRefuges = pgTable(
  'block_refuges',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    refugeNo: integer('refuge_no').notNull(),
    floorNo: integer('floor_no'),
    area: measure('area').notNull().default('0'),
  },
  (t) => [uniqueIndex('block_refuges_uq').on(t.blockId, t.refugeNo)],
);

export const blockCarparks = pgTable(
  'block_carparks',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    cparkNo: integer('cpark_no').notNull(),
    floor: text('floor').notNull().default(''),
    capacity: integer('capacity').notNull().default(0),
  },
  (t) => [uniqueIndex('block_carparks_uq').on(t.blockId, t.cparkNo)],
);

export interface FfeCellValue {
  reqt: number | string | null;
  prop: number | string | null;
  prov: number | null;
}

export interface FfeCells {
  floors: Record<string, FfeCellValue>;
  block: FfeCellValue;
}

export const blockFfeItems = pgTable(
  'block_ffe_items',
  {
    id: id(),
    blockId: integer('block_id')
      .notNull()
      .references(() => blocks.id, { onDelete: 'cascade' }),
    equipmentId: integer('equipment_id')
      .notNull()
      .references(() => equipments.id),
    level: equipmentLevel('level').notNull(),
    noteKeys: text('note_keys').array().notNull().default(sql`'{}'::text[]`),
    added: boolean('added').notNull().default(false),
    remarks: text('remarks').notNull().default(''),
    ordinal: integer('ordinal').notNull().default(0),
    cells: jsonb('cells').$type<FfeCells>().notNull(),
    /** Summary columns for reporting ("where is provided < required?"). */
    reqtTotal: numeric('reqt_total', { precision: 12, scale: 2 }),
    provTotal: numeric('prov_total', { precision: 12, scale: 2 }),
    hasShortfall: boolean('has_shortfall').notNull().default(false),
  },
  (t) => [
    uniqueIndex('block_ffe_items_uq').on(t.blockId, t.equipmentId),
    index('block_ffe_items_shortfall_idx').on(t.hasShortfall),
  ],
);
