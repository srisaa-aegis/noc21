/**
 * npm run db:migrate — applies pending migrations under a PostgreSQL advisory
 * lock, so several API replicas starting at once apply them exactly once.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { resolve } from 'node:path';
import { config } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';

const MIGRATION_LOCK_ID = 864_213_001;

async function main(): Promise<void> {
  const cfg = config();
  const url = process.env.MIGRATE_DATABASE_URL ?? cfg.databaseUrl;
  const { db, close } = createDb(url, 2);
  const folder = resolve(cfg.repoRoot, 'backend', 'src', 'db', 'migrations');
  console.log(`  Migrating ${url.replace(/:[^:@]*@/, ':***@')}`);
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);
  try {
    await migrate(db, { migrationsFolder: folder });
    const tables = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    console.log(`  \u2713 Schema up to date (${tables.rows[0]?.count ?? '?'} tables).`);
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
    await close();
  }
}

main().catch((e) => {
  console.error('  \u2717 Migration failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
