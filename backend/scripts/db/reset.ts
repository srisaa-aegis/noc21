/**
 * npm run db:reset — drop the schema, migrate and seed again.
 * Refused outside development, against a non-local database, or on a
 * protected database name.
 */
import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { config } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';

const cfg = config();
const url = new URL(cfg.databaseUrl);
const local = ['localhost', '127.0.0.1', '::1', ''].includes(url.hostname);

if (cfg.NODE_ENV === 'production') {
  console.error('  \u2717 db:reset is not available in production.');
  process.exit(1);
}
if (!local) {
  console.error(`  \u2717 Refusing to reset a non-local database (${url.hostname}).`);
  process.exit(1);
}
if (/prod/i.test(url.pathname)) {
  console.error(`  \u2717 Refusing to reset a protected database name (${url.pathname}).`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { db, close } = createDb(cfg.databaseUrl, 2);
  console.log(`  Dropping and recreating schema "public" in ${url.pathname.slice(1)} …`);
  await db.execute(sql`drop schema public cascade`);
  await db.execute(sql`create schema public`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await close();
  for (const script of ['scripts/db/migrate.ts', 'scripts/db/seed.ts']) {
    const r = spawnSync('npx', ['tsx', '--env-file-if-exists=.env', script], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  console.log('  \u2713 Database reset.');
}

void main();
