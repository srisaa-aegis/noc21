/** Re-seeds the test database so a mutating suite always starts from the demo state. */
import { sql } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { seedDemo } from '../../src/db/seed/seed-demo.js';
import { seedMaster } from '../../src/db/seed/seed-master.js';
import { testDatabaseUrl } from './db.js';

export async function reseed(): Promise<void> {
  const { db, close } = createDb(testDatabaseUrl(), 2);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local noc.suppress_cache_bump = 'on'`);
      await seedMaster(tx);
      await seedDemo(tx);
      await tx.execute(sql`set local noc.suppress_cache_bump = 'off'`);
      await tx.execute(sql`update cache_versions set version = version + 1, updated_at = now()`);
    });
  } finally {
    await close();
  }
}
