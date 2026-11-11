/** npm run db:create — application role and databases (idempotent). */
import { cfg, fail, isRunning, ok, psqlSuper, say } from './cluster.js';

if (!isRunning()) fail('PostgreSQL is not running. Run: npm run db:start');

const role = cfg.DB_USER;
const exists = psqlSuper(`select 1 from pg_roles where rolname = '${role}'`);
if (exists.stdout.trim() !== '1') {
  const r = psqlSuper(`create role "${role}" login password '${cfg.DB_PASSWORD}' createdb`);
  if (r.status !== 0) fail(`Could not create role "${role}": ${r.stderr}`);
  ok(`Role "${role}" created.`);
} else {
  ok(`Role "${role}" already exists.`);
}

for (const db of [cfg.DB_NAME, `${cfg.DB_NAME}_test`]) {
  const has = psqlSuper(`select 1 from pg_database where datname = '${db}'`);
  if (has.stdout.trim() !== '1') {
    const r = psqlSuper(`create database "${db}" owner "${role}"`);
    if (r.status !== 0) fail(`Could not create database "${db}": ${r.stderr}`);
    ok(`Database "${db}" created.`);
  } else {
    ok(`Database "${db}" already exists.`);
  }
}
say('Connection string: ' + cfg.databaseUrl);
