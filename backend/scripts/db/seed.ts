/**
 * npm run db:seed            — master data + demo accounts and applications
 * npm run db:seed -- --only=master
 *
 * Everything runs in one transaction: the database is either fully seeded or
 * untouched. Master data is upserted (safe in any environment); demo data is
 * replaced.
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { seedChecksum } from '../../src/db/seed/inputs.js';
import { seedDemo } from '../../src/db/seed/seed-demo.js';
import { seedMaster } from '../../src/db/seed/seed-master.js';
import * as s from '../../src/db/schema/index.js';

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? 'all';

async function main(): Promise<void> {
  const { db, close } = createDb(process.env.SEED_DATABASE_URL ?? undefined, 4);
  const started = Date.now();
  try {
    await db.transaction(async (tx) => {
      // One cache bump for the whole seed instead of one per statement.
      await tx.execute(sql`set local noc.suppress_cache_bump = 'on'`);
      const master = await seedMaster(tx);
      let counts = master.counts;
      let notes = master.notes;
      if (only === 'all') {
        const demo = await seedDemo(tx);
        counts = { ...counts, ...demo.counts };
        notes = [...notes, ...demo.notes];
      }
      await tx
        .insert(s.seedState)
        .values({ name: only === 'all' ? 'seed:all' : 'seed:master', checksum: seedChecksum() })
        .onConflictDoUpdate({ target: s.seedState.name, set: { checksum: seedChecksum(), appliedAt: new Date() } });

      console.log('  Seeded:');
      for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(24)} ${v}`);
      if (notes.length) {
        console.log('  Recorded corrections:');
        for (const n of notes) console.log(`    - ${n}`);
      }
      await tx.execute(sql`set local noc.suppress_cache_bump = 'off'`);
      await tx.execute(sql`
        update cache_versions set version = version + 1, updated_at = now()`);
      await tx.execute(sql`select pg_notify('noc_cache', bundle || ':' || version) from cache_versions`);
    });
    console.log(`  \u2713 Seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  } catch (e) {
    console.error('  \u2717 Seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

void main();
