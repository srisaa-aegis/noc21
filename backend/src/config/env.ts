/**
 * Process configuration. Validated once at boot with Zod; nothing else in the
 * backend reads `process.env`.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

/**
 * Repository root. `import.meta.dirname` is undefined when this module is
 * bundled by a tool (drizzle-kit does that with the config file), so fall back
 * to walking up from the working directory until the workspace root is found.
 */
function findRepoRoot(): string {
  const fromModule = import.meta.dirname ? resolve(import.meta.dirname, '..', '..', '..') : undefined;
  if (fromModule && existsSync(resolve(fromModule, 'package.json'))) return fromModule;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'packages')) && existsSync(resolve(dir, 'backend'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: int(3000),
  /**
   * API processes sharing the port (node:cluster). One Node process serves ~20–25
   * heavy requests a second on this sandbox; production runs one per spare core.
   */
  API_WORKERS: int(1),
  API_PREFIX: z.string().default('/api/v1'),

  // NB: deliberately NOT named PGHOST/PGPORT/… — libpq reads those from the
  // ambient environment, which would silently override the project settings.
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: int(5432),
  DB_USER: z.string().default('noc'),
  DB_PASSWORD: z.string().default('noc'),
  DB_NAME: z.string().default('noc'),
  DB_SUPERUSER: z.string().default('postgres'),
  PGDATA_DIR: z.string().default(resolve(REPO_ROOT, '.pgdata')),
  PG_SOCKET_DIR: z.string().default(resolve(REPO_ROOT, 'var', 'run')),
  /**
   * Server settings of the local cluster (npm run db:start), sized for a
   * developer machine and the 300 000-application load test: more shared
   * buffers than the 128 MB default, SSD costs, no JIT for short queries.
   */
  PG_SERVER_OPTIONS: z
    .string()
    .default('-c shared_buffers=512MB -c work_mem=16MB -c maintenance_work_mem=256MB -c effective_cache_size=4GB -c random_page_cost=1.1 -c jit=off'),
  DATABASE_URL: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),
  DB_POOL_MAX: int(20),
  DB_STATEMENT_TIMEOUT_MS: int(15_000),

  JWT_ACCESS_SECRET: z.string().default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().default('dev-refresh-secret-change-me'),
  ACCESS_TOKEN_TTL_SECONDS: int(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: int(30),
  /** Officers and administrators are signed out after this long without activity (Q-11). */
  STAFF_IDLE_TIMEOUT_HOURS: int(8),
  /** ...and must sign in again at least this often (B2-6: a daily sign-in). */
  STAFF_ABSOLUTE_HOURS: int(12),
  /** Citizens are signed out after this long without activity (B2-5). */
  CITIZEN_IDLE_TIMEOUT_HOURS: int(24),
  /** Validity of a password-reset link (B2-7: one hour, single use). */
  RESET_LINK_MINUTES: int(60),
  /** Validity of the "set your password" link e-mailed at registration (B2-4). */
  SET_PASSWORD_LINK_HOURS: int(24),
  /**
   * Accounts created by the seed must choose their own password at first sign-in
   * (B2-8). Defaults to true in production, false for the demo.
   */
  SEED_FORCE_PASSWORD_CHANGE: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
  COOKIE_SECURE: bool(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  LOGIN_MAX_FAILURES: int(5),
  LOGIN_LOCK_MINUTES: int(15),

  CORS_ORIGINS: z.string().default('http://localhost:4200'),
  /** Public address of the portal, used in links sent by e-mail / SMS. */
  PORTAL_URL: z.string().default('http://localhost:4200'),

  STORAGE_DRIVER: z.enum(['fs']).default('fs'),
  FS_STORAGE_ROOT: z.string().default(resolve(REPO_ROOT, 'var', 'storage')),
  DOWNLOAD_LINK_TTL_SECONDS: int(120),
  /** B2-10: 10 MB per file, 250 MB per application, PDF only. */
  UPLOAD_MAX_BYTES: int(10 * 1024 * 1024),
  UPLOAD_MAX_PER_APPLICATION_BYTES: int(250 * 1024 * 1024),
  UPLOAD_ALLOWED_MIME: z.string().default('application/pdf'),
  /** B2-9: replaced / removed / orphaned files are purged this many days after they stop being used. */
  FILE_PURGE_AFTER_DAYS: int(30),
  /** Audit entries are deleted after this many months (decided after B3: 3). */
  AUDIT_RETENTION_MONTHS: int(3),

  API_DATE_FORMAT: z.enum(['legacy', 'iso']).default('legacy'),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  CACHE_POLL_INTERVAL_MS: int(60_000),

  /** OpenAPI document and Swagger UI at /docs. Unset: on outside production, off in production (decided after B3). */
  ENABLE_DOCS: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
  /**
   * Trust X-Forwarded-For (the client address behind a reverse proxy). No proxy is
   * used (decided after B3), so the address of the connection is the client's.
   */
  TRUST_PROXY: bool(false),
  ENABLE_SCHEDULER: bool(false),
  /** Local hour (APP_TIMEZONE) of the daily escalation run (N-12: 09:00 IST, every day). */
  ESCALATION_HOUR: int(9),
  ALLOW_DEMO_RESET: bool(false),
  SEED_DEMO_PASSWORD: z.string().default('demo'),
  /** The demo dates are moved so that the newest file is from the last days (false: the dates of the JSON). */
  SEED_REDATE: bool(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('debug'),
  RATE_LIMIT_GLOBAL_PER_MINUTE: int(300),
  RATE_LIMIT_LOGIN_PER_MINUTE: int(10),
});

export type RawEnv = z.infer<typeof schema>;

export interface AppConfig extends RawEnv {
  repoRoot: string;
  databaseUrl: string;
  corsOrigins: string[];
  allowedMime: string[];
  isProduction: boolean;
  isTest: boolean;
}

function buildDatabaseUrl(e: RawEnv): string {
  if (e.DATABASE_URL && e.DATABASE_URL.trim()) return e.DATABASE_URL;
  const auth = `${encodeURIComponent(e.DB_USER)}:${encodeURIComponent(e.DB_PASSWORD)}`;
  return `postgresql://${auth}@${e.DB_HOST}:${e.DB_PORT}/${e.DB_NAME}`;
}

/** Refuses a storage root that sits inside anything the web server serves. */
function assertStorageRootOutsideWebRoot(root: string): void {
  const served = [
    resolve(REPO_ROOT, 'frontend', 'public'),
    resolve(REPO_ROOT, 'frontend', 'dist'),
    resolve(REPO_ROOT, 'frontend', 'src'),
    resolve(REPO_ROOT, 'NOC-base'),
  ];
  const abs = isAbsolute(root) ? root : resolve(process.cwd(), root);
  for (const dir of served) {
    if (abs === dir || abs.startsWith(dir + '/')) {
      throw new Error(`FS_STORAGE_ROOT (${abs}) must not be inside a served directory (${dir}).`);
    }
  }
}

let cached: AppConfig | undefined;

export function loadConfig(overrides: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(overrides);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const storageRoot = isAbsolute(e.FS_STORAGE_ROOT) ? e.FS_STORAGE_ROOT : resolve(process.cwd(), e.FS_STORAGE_ROOT);
  assertStorageRootOutsideWebRoot(storageRoot);
  if (e.NODE_ENV === 'production') {
    if (e.JWT_ACCESS_SECRET.startsWith('dev-') || e.JWT_REFRESH_SECRET.startsWith('dev-')) {
      throw new Error('Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in production.');
    }
    if (e.ALLOW_DEMO_RESET) throw new Error('ALLOW_DEMO_RESET must be false in production.');
  }
  return {
    ...e,
    FS_STORAGE_ROOT: storageRoot,
    repoRoot: REPO_ROOT,
    databaseUrl: buildDatabaseUrl(e),
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    allowedMime: e.UPLOAD_ALLOWED_MIME.split(',').map((s) => s.trim()).filter(Boolean),
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
  };
}

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

export function repoPath(...parts: string[]): string {
  return resolve(REPO_ROOT, ...parts);
}

export function envFileExists(): boolean {
  return existsSync(resolve(REPO_ROOT, 'backend', '.env'));
}
