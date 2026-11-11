/**
 * npm run dev:reset-demo — development-only demo reset (decision Q-67).
 *
 * There is deliberately no API endpoint and no Admin UI button for this: it
 * must be run from a shell on the machine that hosts the database.
 *
 * Guards (all must pass):
 *   1. NODE_ENV=development
 *   2. ALLOW_DEMO_RESET=true in the local .env
 *   3. the database host is local (socket, localhost or 127.0.0.1)
 *   4. the database name is not protected (anything containing "prod")
 *   5. an interactive confirmation, unless --yes --i-understand-this-deletes-data
 *
 * It takes a backup first, moves the demo storage objects aside (never deletes
 * them), re-seeds, revokes every session and bumps the cache versions so that
 * running API processes and open browsers pick the new data up.
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';

const cfg = config();
const url = new URL(cfg.databaseUrl);
const dbName = url.pathname.replace('/', '');
const args = new Set(process.argv.slice(2));
const nonInteractive = args.has('--yes') && args.has('--i-understand-this-deletes-data');

function refuse(reason: string): never {
  console.error(`  \u2717 Refusing to reset the demo data: ${reason}`);
  process.exit(1);
}

if (cfg.NODE_ENV !== 'development') refuse(`NODE_ENV is "${cfg.NODE_ENV}" (development only).`);
if (!cfg.ALLOW_DEMO_RESET) refuse('ALLOW_DEMO_RESET is not true in backend/.env.');
if (!['localhost', '127.0.0.1', '::1', ''].includes(url.hostname)) refuse(`the database host "${url.hostname}" is not local.`);
if (/prod/i.test(dbName)) refuse(`"${dbName}" looks like a protected database.`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = resolve(cfg.repoRoot, 'var', 'backups');

async function confirm(): Promise<void> {
  if (nonInteractive) return;
  if (!process.stdin.isTTY) {
    refuse('not an interactive terminal (use --yes --i-understand-this-deletes-data in a script).');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  This deletes all data in "${dbName}" and re-seeds the demo.\n  Type the database name to continue: `);
  rl.close();
  if (answer.trim() !== dbName) refuse('the database name was not confirmed.');
}

function run(cmd: string, argv: string[]): void {
  const r = spawnSync(cmd, argv, { stdio: 'inherit' });
  if (r.status !== 0) refuse(`${cmd} ${argv.join(' ')} failed.`);
}

async function main(): Promise<void> {
  await confirm();

  mkdirSync(backupDir, { recursive: true });
  const dump = resolve(backupDir, `pre-reset-${dbName}-${stamp}.dump`);
  console.log(`  Backing up to ${dump} …`);
  const pgDump = spawnSync('pg_dump', ['-Fc', '-h', url.hostname || '127.0.0.1', '-p', url.port || '5432', '-U', cfg.DB_USER, '-d', dbName, '-f', dump], {
    stdio: 'inherit',
    env: { ...process.env, PGPASSWORD: cfg.DB_PASSWORD },
  });
  if (pgDump.status !== 0) {
    console.warn('  ! pg_dump failed; continuing without a backup is not allowed.');
    process.exit(1);
  }

  // Move the demo storage objects aside rather than deleting them.
  if (existsSync(cfg.FS_STORAGE_ROOT) && readdirSync(cfg.FS_STORAGE_ROOT).length) {
    const moved = resolve(backupDir, `storage-${stamp}`);
    renameSync(cfg.FS_STORAGE_ROOT, moved);
    mkdirSync(cfg.FS_STORAGE_ROOT, { recursive: true });
    console.log(`  Uploaded files moved to ${moved}`);
  }

  run('npx', ['tsx', '--env-file-if-exists=.env', 'scripts/db/seed.ts']);

  const { db, close } = createDb(cfg.databaseUrl, 2);
  try {
    await db.execute(sql`update refresh_tokens set revoked_at = now() where revoked_at is null`);
    await db.execute(sql`update cache_versions set version = version + 1, updated_at = now()`);
    await db.execute(sql`select pg_notify('noc_cache', bundle || ':' || version) from cache_versions`);
    const counts = await db.execute<{ table_name: string; rows: string }>(sql`
      select relname as table_name, n_live_tup::text as rows
      from pg_stat_user_tables
      where n_live_tup > 0
      order by n_live_tup desc
      limit 12`);
    console.log('  Largest tables after the reset:');
    for (const r of counts.rows) console.log(`    ${r.table_name.padEnd(28)} ${r.rows}`);
  } finally {
    await close();
  }
  console.log('  \u2713 Demo data reset. Every session was signed out and the caches were refreshed.');
}

void main();
