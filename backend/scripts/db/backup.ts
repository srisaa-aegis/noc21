/**
 * npm run db:backup [-- --out <dir>] [--no-files]
 *
 * A consistent copy of everything the portal stores:
 *
 *   <dir>/database.dump    pg_dump custom format (restore with pg_restore)
 *   <dir>/storage.tar.gz   the uploaded files (FS_STORAGE_ROOT)
 *   <dir>/manifest.json    what was backed up: database, row counts, files,
 *                          migrations, SHA-256 of the two archives
 *
 * Default directory: var/backups/<timestamp>. The database is dumped first and
 * the files second, so every file the dump refers to is in the archive (files
 * are only added, never changed; a file uploaded in between is harmless).
 * Restore with `npm run db:restore -- --from <dir>`.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';
import { binary, fail, ok, run, say } from '../pg/cluster.js';
import { sha256 } from './checksum.js';

const cfg = config();
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const url = new URL(cfg.databaseUrl);
const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// --out is relative to where `npm run` was typed (npm runs the script in backend/).
const outDir = opt('--out') ? resolve(process.env.INIT_CWD ?? process.cwd(), opt('--out')!) : join(cfg.repoRoot, 'var', 'backups', stamp);
const withFiles = !argv.includes('--no-files');

function walk(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files++;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

async function main(): Promise<void> {
  if (existsSync(join(outDir, 'manifest.json'))) fail(`${outDir} already holds a backup.`);
  mkdirSync(outDir, { recursive: true });
  say(`Backing up database "${dbName}" and ${withFiles ? 'the uploaded files' : 'no files (--no-files)'} to ${outDir}`);

  // 1. Facts for the manifest (and a connectivity check before the dump).
  const { db, close } = createDb(cfg.databaseUrl, 2);
  const counts: Record<string, number> = {};
  let migrations: number;
  let serverVersion: string;
  try {
    for (const table of ['applications', 'blocks', 'users', 'files', 'wf_instances', 'wf_tasks', 'audit_log']) {
      const exists = await db.execute<{ t: string | null }>(sql`select to_regclass(${`public.${table}`})::text as t`);
      if (!exists.rows[0]?.t) continue;
      const exact = await db.execute<{ n: string }>(sql.raw(`select count(*)::text as n from "${table}"`));
      counts[table] = Number(exact.rows[0].n);
    }
    const m = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`).catch(() => ({ rows: [{ n: '0' }] }));
    migrations = Number(m.rows[0].n);
    serverVersion = (await db.execute<{ v: string }>(sql`show server_version`)).rows[0].v;
  } finally {
    await close();
  }

  // 2. Database.
  const dump = join(outDir, 'database.dump');
  const r = run(binary('pg_dump'), ['-Fc', '--no-owner', '-h', url.hostname || '127.0.0.1', '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', dbName, '-f', dump], {
    env: { PGPASSWORD: decodeURIComponent(url.password) },
  });
  if (r.status !== 0) fail(`pg_dump failed: ${r.stderr.trim()}`);
  ok(`Database dumped (${(statSync(dump).size / 1024).toFixed(0)} KB).`);

  // 3. Files.
  let storage: { archive: string | null; files: number; bytes: number; sha256?: string } = { archive: null, files: 0, bytes: 0 };
  if (withFiles) {
    const stats = walk(cfg.FS_STORAGE_ROOT);
    const archive = join(outDir, 'storage.tar.gz');
    if (existsSync(cfg.FS_STORAGE_ROOT)) {
      const t = run('tar', ['-czf', archive, '-C', cfg.FS_STORAGE_ROOT, '.']);
      if (t.status !== 0) fail(`tar failed: ${t.stderr.trim()}`);
    } else {
      const t = run('tar', ['-czf', archive, '--files-from', '/dev/null']);
      if (t.status !== 0) fail(`tar failed: ${t.stderr.trim()}`);
    }
    storage = { archive: 'storage.tar.gz', ...stats, sha256: await sha256(archive) };
    ok(`Files archived: ${stats.files} file(s), ${(stats.bytes / 1024 / 1024).toFixed(1)} MB.`);
  }

  const manifest = {
    format: 'noc-backup/1',
    createdAt: new Date().toISOString(),
    database: { name: dbName, serverVersion, migrations, dump: 'database.dump', sha256: await sha256(dump), rows: counts },
    storage: { root: cfg.FS_STORAGE_ROOT, ...storage },
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  ok(`Backup complete: ${outDir}`);
  say(`Restore with: npm run db:restore -- --from ${outDir}`);
}

void main();
