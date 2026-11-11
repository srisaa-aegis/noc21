/**
 * Authentication: login, refresh-token rotation, logout, registration, forgot
 * password and self-service password change.
 *
 * Passwords are argon2id. Refresh tokens are random, stored hashed, rotated on
 * every use, and a whole token family is revoked when an old one is replayed.
 * The user-facing messages are the portal's existing ones.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { passwordPolicyProblems } from '@srisaa/noc-domain';
import { config } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { AppError, assert, forbidden, unauthenticated } from '../errors/app-error.js';
import { businessDate } from '../lib/dates.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE = /^[6-9]\d{9}$/;

export interface PublicUser {
  id: number;
  username: string;
  email: string;
  displayName: string;
  portal: 'citizen' | 'dept' | 'admin';
  mobile: string;
  active: boolean;
  must_change_password: boolean;
  created_on: string;
  role_id?: number;
  role_code?: string;
  district_id?: number | null;
  all_stations?: boolean;
  fire_station_ids?: number[];
  gender?: string;
  dob?: string;
  address?: string;
  aadhar_last4?: string;
}

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export function landingFor(portal: PublicUser['portal']): string {
  return portal === 'citizen' ? '/citizen/dashboard' : portal === 'dept' ? '/dept/dashboard' : '/admin/dashboard';
}

export async function publicUser(db: Database, userId: number): Promise<PublicUser> {
  const [row] = await db
    .select({
      user: s.users,
      roleId: s.deptProfiles.roleId,
      roleCode: s.deptRoles.code,
      districtId: s.deptProfiles.districtId,
      allStations: s.deptProfiles.allStations,
      gender: s.citizenProfiles.gender,
      dob: s.citizenProfiles.dob,
      address: s.citizenProfiles.address,
      aadharLast4: s.citizenProfiles.aadharLast4,
    })
    .from(s.users)
    .leftJoin(s.deptProfiles, eq(s.deptProfiles.userId, s.users.id))
    .leftJoin(s.deptRoles, eq(s.deptRoles.id, s.deptProfiles.roleId))
    .leftJoin(s.citizenProfiles, eq(s.citizenProfiles.userId, s.users.id))
    .where(eq(s.users.id, userId))
    .limit(1);
  assert(row, 'Account not found.', 404);
  const stations =
    row.user.portal === 'dept'
      ? (await db.select().from(s.deptUserStations).where(eq(s.deptUserStations.userId, userId))).map((x) => x.fireStationId)
      : undefined;
  return {
    id: row.user.id,
    username: row.user.username,
    email: row.user.email,
    displayName: row.user.displayName,
    portal: row.user.portal,
    mobile: row.user.mobile,
    active: row.user.active,
    must_change_password: row.user.mustChangePassword,
    created_on: row.user.createdOn ?? '',
    ...(row.roleId ? { role_id: row.roleId, role_code: row.roleCode ?? '', district_id: row.districtId, all_stations: row.allStations ?? false, fire_station_ids: stations ?? [] } : {}),
    ...(row.gender !== null && row.gender !== undefined
      ? { gender: row.gender, dob: row.dob ?? '', address: row.address ?? '', aadhar_last4: row.aadharLast4 ?? '' }
      : {}),
  };
}

export interface LoginResult {
  user: PublicUser;
  refreshToken: string;
  landing: string;
}

export async function login(db: Database, usernameOrEmail: string, password: string, meta: { ip: string; userAgent: string }): Promise<LoginResult> {
  const key = usernameOrEmail.trim().toLowerCase();
  const cfg = config();
  const [row] = await db
    .select()
    .from(s.users)
    .where(and(or(sql`lower(username) = ${key}`, sql`lower(email) = ${key}`), isNull(s.users.deletedAt)))
    .limit(1);

  const invalid = new AppError(401, 'unauthenticated', 'Invalid username or password.');
  if (!row) throw invalid;
  if (row.lockedUntil && row.lockedUntil > new Date()) {
    throw new AppError(429, 'rate-limited', 'Too many failed attempts. Please try again in a few minutes.');
  }
  const ok = await argon2.verify(row.passwordHash, password).catch(() => false);
  if (!ok) {
    const failures = row.failedLoginCount + 1;
    await db
      .update(s.users)
      .set({
        failedLoginCount: failures,
        lockedUntil: failures >= cfg.LOGIN_MAX_FAILURES ? new Date(Date.now() + cfg.LOGIN_LOCK_MINUTES * 60_000) : null,
      })
      .where(eq(s.users.id, row.id));
    throw invalid;
  }
  if (!row.active) {
    throw forbidden('This account has been deactivated. Please contact the portal administrator.');
  }
  await db.update(s.users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(s.users.id, row.id));
  const refreshToken = await issueRefreshToken(db, row.id, randomBytes(8).toString('hex'), { ...meta, portal: row.portal });
  return { user: await publicUser(db, row.id), refreshToken, landing: landingFor(row.portal) };
}

/**
 * Refresh-token lifetime: a sliding idle window — every refresh (which an
 * active browser does at least every 15 minutes) pushes it forward, so only a
 * genuinely idle session expires — capped by an absolute limit counted from
 * the first sign-in of the session.
 *
 *   citizens              idle CITIZEN_IDLE_TIMEOUT_HOURS (1 day), absolute REFRESH_TOKEN_TTL_DAYS
 *   officers and admins   idle STAFF_IDLE_TIMEOUT_HOURS (8 h),     absolute STAFF_ABSOLUTE_HOURS (12 h)
 */
export function refreshExpiry(portal: string, familyStartedAt: Date, now = Date.now()): Date {
  const cfg = config();
  const staff = portal === 'dept' || portal === 'admin';
  const absolute = familyStartedAt.getTime() + (staff ? cfg.STAFF_ABSOLUTE_HOURS * 3_600_000 : cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const idle = now + (staff ? cfg.STAFF_IDLE_TIMEOUT_HOURS : cfg.CITIZEN_IDLE_TIMEOUT_HOURS) * 3_600_000;
  return new Date(Math.min(absolute, idle));
}

async function issueRefreshToken(
  db: Database,
  userId: number,
  family: string,
  meta: { ip: string; userAgent: string; portal: string; familyStartedAt?: Date },
  replacesId?: number,
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = refreshExpiry(meta.portal, meta.familyStartedAt ?? new Date());
  const [row] = await db
    .insert(s.refreshTokens)
    .values({ userId, tokenHash: hashToken(raw), family, expiresAt, ip: meta.ip, userAgent: meta.userAgent })
    .returning({ id: s.refreshTokens.id });
  if (replacesId) await db.update(s.refreshTokens).set({ replacedById: row.id }).where(eq(s.refreshTokens.id, replacesId));
  return raw;
}

export async function refresh(db: Database, raw: string, meta: { ip: string; userAgent: string }): Promise<LoginResult> {
  const [token] = await db.select().from(s.refreshTokens).where(eq(s.refreshTokens.tokenHash, hashToken(raw))).limit(1);
  if (!token) throw unauthenticated('Your session has expired. Please sign in again.');
  if (token.revokedAt) {
    // Replay of a rotated token: someone else may hold the family — drop all of it.
    await db.update(s.refreshTokens).set({ revokedAt: new Date() }).where(eq(s.refreshTokens.family, token.family));
    throw unauthenticated('Your session has expired. Please sign in again.');
  }
  if (token.expiresAt < new Date()) {
    throw unauthenticated('You were signed out after a period of inactivity. Please sign in again.');
  }
  const [user] = await db.select().from(s.users).where(eq(s.users.id, token.userId)).limit(1);
  assert(user, 'Account not found.', 404);
  if (!user.active) throw forbidden('This account has been deactivated. Please contact the portal administrator.');
  await db.update(s.refreshTokens).set({ revokedAt: new Date() }).where(eq(s.refreshTokens.id, token.id));
  const [first] = await db
    .select({ issuedAt: s.refreshTokens.issuedAt })
    .from(s.refreshTokens)
    .where(eq(s.refreshTokens.family, token.family))
    .orderBy(s.refreshTokens.issuedAt)
    .limit(1);
  const next = await issueRefreshToken(db, user.id, token.family, { ...meta, portal: user.portal, familyStartedAt: first?.issuedAt ?? token.issuedAt }, token.id);
  return { user: await publicUser(db, user.id), refreshToken: next, landing: landingFor(user.portal) };
}

export async function logout(db: Database, raw: string | undefined): Promise<void> {
  if (!raw) return;
  const [token] = await db.select().from(s.refreshTokens).where(eq(s.refreshTokens.tokenHash, hashToken(raw))).limit(1);
  if (token) await db.update(s.refreshTokens).set({ revokedAt: new Date() }).where(eq(s.refreshTokens.family, token.family));
}

export interface RegistrationInput {
  name: string;
  mobile: string;
  email: string;
  gender?: string;
  dob?: string;
  aadhar?: string;
  address?: string;
}

/**
 * Citizen self-registration (B2-4): the account is created without a usable
 * password and a single-use "set your password" link is e-mailed — no
 * temporary password exists anywhere.
 */
export async function register(db: Database, input: RegistrationInput): Promise<{ username: string; setPasswordUrl: string }> {
  const email = input.email.trim().toLowerCase();
  assert(input.name.trim().length > 1, 'Name is required.');
  assert(EMAIL.test(email), 'Enter a valid e-mail address.');
  assert(MOBILE.test(input.mobile), 'Enter a valid 10-digit mobile number.');
  const existing = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(or(sql`lower(email) = ${email}`, sql`lower(username) = ${email}`))
    .limit(1);
  assert(existing.length === 0, 'An account with this e-mail already exists.', 409);

  const cfg = config();
  const unusable = await argon2.hash(randomBytes(48).toString('base64url'), { type: argon2.argon2id });
  const raw = randomBytes(32).toString('base64url');
  const setPasswordUrl = `${cfg.PORTAL_URL}/auth/reset-password?token=${raw}&welcome=1`;
  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(s.users)
      .values({
        username: email,
        email,
        passwordHash: unusable,
        portal: 'citizen',
        displayName: input.name.trim(),
        mobile: input.mobile,
        active: true,
        mustChangePassword: false,
        createdOn: businessDate(),
      })
      .returning({ id: s.users.id });
    await tx.insert(s.citizenProfiles).values({
      userId: user.id,
      gender: input.gender ?? '',
      dob: input.dob && input.dob.trim() ? input.dob : null,
      aadharLast4: (input.aadhar ?? '').replace(/\D/g, '').slice(-4),
      aadharHash: input.aadhar ? createHash('sha256').update(input.aadhar.replace(/\D/g, '')).digest('hex') : '',
      address: input.address ?? '',
    });
    await tx.insert(s.passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(raw),
      purpose: 'set',
      expiresAt: new Date(Date.now() + cfg.SET_PASSWORD_LINK_HOURS * 3_600_000),
    });
    await tx.insert(s.notificationOutbox).values({
      kind: 'email',
      toAddress: email,
      templateKey: 'registered',
      payload: { name: input.name.trim(), username: email, set_password_link: setPasswordUrl, hours: cfg.SET_PASSWORD_LINK_HOURS },
      userId: user.id,
    });
  });
  return { username: email, setPasswordUrl };
}

export async function forgotPassword(db: Database, email: string): Promise<void> {
  const key = email.trim().toLowerCase();
  const [user] = await db.select().from(s.users).where(sql`lower(email) = ${key}`).limit(1);
  if (!user || !user.active) return; // never reveal whether an account exists
  const raw = randomBytes(32).toString('base64url');
  await db.insert(s.passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(raw),
    purpose: 'reset',
    expiresAt: new Date(Date.now() + config().RESET_LINK_MINUTES * 60_000),
  });
  await db.insert(s.notificationOutbox).values({
    kind: 'email',
    toAddress: user.email,
    templateKey: 'password_reset',
    payload: { name: user.displayName, reset_link: `${config().PORTAL_URL}/auth/reset-password?token=${raw}` },
    userId: user.id,
  });
}

export async function changeOwnPassword(db: Database, userId: number, current: string, next: string): Promise<void> {
  const [user] = await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1);
  assert(user, 'Account not found.', 404);
  assert(user.active, 'This account has been deactivated.', 403);
  const ok = await argon2.verify(user.passwordHash, current).catch(() => false);
  assert(ok, 'The current password is incorrect.');
  assert(next !== current, 'The new password must be different from the current password.');
  const problems = passwordPolicyProblems(next, { username: user.username, email: user.email });
  assert(!problems.length, `The new password does not meet the policy: ${problems.join(' ')}`);
  await db
    .update(s.users)
    .set({ passwordHash: await argon2.hash(next, { type: argon2.argon2id }), mustChangePassword: false, updatedAt: new Date() })
    .where(eq(s.users.id, userId));
}

export async function resetPassword(db: Database, rawToken: string, newPassword: string): Promise<void> {
  const [token] = await db
    .select()
    .from(s.passwordResetTokens)
    .where(eq(s.passwordResetTokens.tokenHash, hashToken(rawToken)))
    .limit(1);
  assert(
    token && !token.usedAt && token.expiresAt > new Date(),
    'This link is no longer valid. Use "Forgot password" on the sign-in page to get a new one.',
  );
  const [owner] = await db.select().from(s.users).where(eq(s.users.id, token.userId)).limit(1);
  const problems = passwordPolicyProblems(newPassword, { username: owner?.username, email: owner?.email });
  assert(!problems.length, `The new password does not meet the policy: ${problems.join(' ')}`);
  await db.transaction(async (tx) => {
    await tx
      .update(s.users)
      .set({ passwordHash: await argon2.hash(newPassword, { type: argon2.argon2id }), mustChangePassword: false })
      .where(eq(s.users.id, token.userId));
    await tx.update(s.passwordResetTokens).set({ usedAt: new Date() }).where(eq(s.passwordResetTokens.id, token.id));
    await tx.update(s.refreshTokens).set({ revokedAt: new Date() }).where(eq(s.refreshTokens.userId, token.userId));
  });
}
