/**
 * PostgreSQL pool + Drizzle instance. The pool is created once per process;
 * tests create their own against TEST_DATABASE_URL.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config/env.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(connectionString = config().databaseUrl, max = config().DB_POOL_MAX): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max,
    statement_timeout: config().DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'noc-api',
    // Short OLTP queries: JIT compilation costs more than it saves (B3 performance
    // review: 0.5–0.8 s of JIT on 1 s monitoring queries at 300 000 applications).
    options: '-c jit=off -c max_parallel_workers_per_gather=0',
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}

let shared: DbHandle | undefined;

export function sharedDb(): DbHandle {
  shared ??= createDb();
  return shared;
}

export async function closeSharedDb(): Promise<void> {
  if (shared) {
    await shared.close();
    shared = undefined;
  }
}

export { schema };
