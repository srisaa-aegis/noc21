/**
 * Accounts and sessions. One `users` row per login (citizen, officer, admin),
 * with a profile table per portal — the shape the portal already uses.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { deptRoles, districts, fireStations } from './reference.js';
import { portalKind } from './enums.js';
import { files } from './files.js';

const id = () => integer('id').generatedByDefaultAsIdentity().primaryKey();

export const users = pgTable(
  'users',
  {
    id: id(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordAlgo: text('password_algo').notNull().default('argon2id'),
    portal: portalKind('portal').notNull(),
    displayName: text('display_name').notNull(),
    mobile: text('mobile').notNull().default(''),
    active: boolean('active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdOn: date('created_on'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    uniqueIndex('users_email_uq').on(t.email),
    index('users_portal_idx').on(t.portal, t.active),
    // substring search of the account lists and of "owner" in the application search (pg_trgm)
    index('users_search_trgm_idx').using('gin', sql`(lower(${t.username} || ' ' || ${t.displayName} || ' ' || ${t.email})) gin_trgm_ops`),
  ],
);

export const citizenProfiles = pgTable('citizen_profiles', {
  id: id(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  gender: text('gender').notNull().default(''),
  dob: date('dob'),
  /** Aadhaar is never stored in the clear. */
  aadharLast4: text('aadhar_last4').notNull().default(''),
  aadharHash: text('aadhar_hash').notNull().default(''),
  address: text('address').notNull().default(''),
});

export const deptProfiles = pgTable(
  'dept_profiles',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .unique(),
    roleId: integer('role_id')
      .notNull()
      .references(() => deptRoles.id),
    districtId: integer('district_id').references(() => districts.id),
    allStations: boolean('all_stations').notNull().default(false),
  },
  (t) => [index('dept_profiles_role_idx').on(t.roleId)],
);

export const deptUserStations = pgTable(
  'dept_user_stations',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fireStationId: integer('fire_station_id')
      .notNull()
      .references(() => fireStations.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('dept_user_stations_uq').on(t.userId, t.fireStationId),
    index('dept_user_stations_station_idx').on(t.fireStationId),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    family: text('family').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: integer('replaced_by_id'),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip').notNull().default(''),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId), index('refresh_tokens_family_idx').on(t.family)],
);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: id(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  /** 'reset' (forgot password) or 'set' (the link e-mailed at registration). */
  purpose: text('purpose').notNull().default('reset'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One-time, short-lived links so a PDF can open in a new tab without a bearer token. */
export const downloadTokens = pgTable('download_tokens', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  fileId: uuid('file_id')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
