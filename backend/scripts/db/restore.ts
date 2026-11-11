/**
 * npm run db:restore -- --from <backup dir> [--db <name>] [--storage-root <dir>] [--no-files] [--yes]
 *
 * Restores a backup made by `npm run db:backup`:
 *
 *   1. checks the manifest and the SHA-256 of both archives;
 *   2. asks for the database name (unless --yes);
 *   3. drops and re-creates the database (default DB_NAME) and pg_restores it;
 *   4. restores the uploaded files: the current storage directory is moved
 *      aside (var/backups/storage-before-restore-<time>), never deleted;
 *   5. compares the row counts with the manifest.
 *
 * Restoring the main database needs the API stopped (`npm run stop`). Restoring
 * into another database (--db noc_restore_check) is a safe way to test a backup;
 * its files go to --storage-root, or are skipped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { config } from '../../src/config/env.js';
import { binary, fail, isRunning, ok, psqlSuper, run, say } from '../pg/cluster.js';
import { sha256 } from './checksum.js';

const cfg = config();
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const from = opt('--from');
const target = opt('--db') ?? cfg.DB_NAME;
const restoringMain = target === cfg.DB_NAME;
const storageRoot = opt('--storage-root') ? resolve(opt('--storage-root')!) : restoringMain ? cfg.FS_STORAGE_ROOT : null;
const withFiles = !argv.includes('--no-files') && storageRoot !== null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

interface Manifest {
  format: string;
  createdAt: string;
  database: { name: string; dump: string; sha256: string; rows: Record<string, number>; migrations: number };
  storage: { archive: string | null; files: number; bytes: number; sha256?: string };
}

async function apiIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.PORT}/version`, { signal: AbortSignal.timeout(1000) });
    return /noc-api/.test(await res.text());
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!from) fail('Say which backup to restore: npm run db:restore -- --from var/backups/<time>');
  // Relative to where `npm run` was typed (npm runs the script in backend/).
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), from);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`${dir} has no manifest.json (not a backup made by npm run db:backup).`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  if (manifest.format !== 'noc-backup/1') fail(`Unknown backup format "${manifest.format}".`);
  if (/prod/i.test(target) && !argv.includes('--i-know-this-is-production')) fail(`"${target}" looks like a production database; add --i-know-this-is-production.`);
  if (!isRunning()) fail('PostgreSQL is not running. Run: npm run db:start');
  if (restoringMain && (await apiIsUp())) fail('The API is running on this database. Stop it first: npm run stop');

  // 1. Integrity.
  const dump = join(dir, manifest.database.dump);
  if ((await sha256(dump)) !== manifest.database.sha256) fail('database.dump does not match its checksum (damaged or altered).');
  const archive = manifest.storage.archive ? join(dir, manifest.storage.archive) : null;
  if (withFiles && archive && (await sha256(archive)) !== manifest.storage.sha256) fail('storage.tar.gz does not match its checksum (damaged or altered).');
  ok(`Backup of ${manifest.createdAt} verified (database "${manifest.database.name}", ${manifest.storage.files} file(s)).`);

  // 2. Confirmation.
  if (!argv.includes('--yes')) {
    if (!process.stdin.isTTY) fail('Not an interactive terminal: add --yes to confirm.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`  This replaces every row of "${target}"${withFiles ? ` and the files in ${storageRoot}` : ''}.\n  Type the database name to continue: `);
    rl.close();
    if (answer.trim() !== target) fail('The database name was not confirmed.');
  }

  // 3. Database.
  const terminate = psqlSuper(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${target}' and pid <> pg_backend_pid()`);
  if (terminate.status !== 0) fail(`Could not close the connections to "${target}": ${terminate.stderr.trim()}`);
  for (const statement of [`drop database if exists "${target}"`, `create database "${target}" owner "${cfg.DB_USER}"`]) {
    const r = psqlSuper(statement);
    if (r.status !== 0) fail(`${statement} failed: ${r.stderr.trim()}`);
  }
  const restore = run(
    binary('pg_restore'),
    ['--no-owner', '--exit-on-error', '-h', cfg.DB_HOST, '-p', String(cfg.DB_PORT), '-U', cfg.DB_USER, '-d', target, dump],
    { env: { PGPASSWORD: cfg.DB_PASSWORD } },
  );
  if (restore.status !== 0) fail(`pg_restore failed: ${restore.stderr.trim()}`);
  ok(`Database "${target}" restored.`);

  // 4. Files.
  if (withFiles && archive && storageRoot) {
    if (existsSync(storageRoot)) {
      const aside = join(cfg.repoRoot, 'var', 'backups', `storage-before-restore-${stamp}`);
      mkdirSync(join(cfg.repoRoot, 'var', 'backups'), { recursive: true });
      renameSync(storageRoot, aside);
      say(`The previous files were moved to ${aside}`);
    }
    mkdirSync(storageRoot, { recursive: true });
    const t = run('tar', ['-xzf', archive, '-C', storageRoot]);
    if (t.status !== 0) fail(`tar failed: ${t.stderr.trim()}`);
    ok(`${manifest.storage.files} file(s) restored to ${storageRoot}`);
  } else {
    say(withFiles ? 'The backup has no files.' : 'Files not restored (--no-files, or another database without --storage-root).');
  }

  // 5. Verification.
  const url = new URL(cfg.databaseUrl);
  url.pathname = `/${target}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const wrong: string[] = [];
    for (const [table, expected] of Object.entries(manifest.database.rows)) {
      const n = Number((await client.query(`select count(*)::int as n from "${table}"`)).rows[0].n);
      if (n !== expected) wrong.push(`${table}: ${n} rows, backup had ${expected}`);
    }
    if (wrong.length) fail(`Row counts differ:\n    ${wrong.join('\n    ')}`);
    ok(`Row counts match the backup (${Object.entries(manifest.database.rows).map(([t, n]) => `${t} ${n}`).join(', ')}).`);
    // Sessions of the restored copy start afresh; caches are rebuilt from the restored data.
    await client.query('update refresh_tokens set revoked_at = now() where revoked_at is null');
    await client.query('update cache_versions set version = version + 1, updated_at = now()');
  } finally {
    await client.end();
  }
  ok('Restore complete. Start the portal with: npm start');
}

void main();
