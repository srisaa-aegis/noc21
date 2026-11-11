/**
 * Prepares the integration-test database: starts the cluster if needed,
 * creates the databases, migrates and seeds `<db>_test`.
 */
import { spawnSync } from 'node:child_process';
import { config } from '../../src/config/env.js';

const cfg = config();
const testUrl = process.env.TEST_DATABASE_URL ?? cfg.TEST_DATABASE_URL ?? cfg.databaseUrl.replace(/\/([^/?]+)(\?|$)/, `/${cfg.DB_NAME}_test$2`);

function run(args: string[], env: NodeJS.ProcessEnv = {}): void {
  const r = spawnSync('npx', ['tsx', '--env-file-if-exists=.env', ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(['scripts/pg/start.ts']);
run(['scripts/pg/create-databases.ts']);
run(['scripts/db/migrate.ts'], { MIGRATE_DATABASE_URL: testUrl });
run(['scripts/db/seed.ts'], { SEED_DATABASE_URL: testUrl });
console.log(`  \u2713 Test database ready: ${testUrl.replace(/:[^:@]*@/, ':***@')}`);
