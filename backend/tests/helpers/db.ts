/**
 * Test database helpers. Integration and parity suites run against a real
 * PostgreSQL; they skip (with a message) when none is reachable.
 */
import pg from 'pg';
import { config } from '../../src/config/env.js';

/**
 * The integration-test database: TEST_DATABASE_URL, else `<DB_NAME>_test` on the
 * configured server. It is never the development database — suites re-seed it —
 * so any URL whose database name does not end in `_test` is refused.
 */
export function testDatabaseUrl(): string {
  const cfg = config();
  const url = process.env.TEST_DATABASE_URL ?? cfg.TEST_DATABASE_URL ?? cfg.databaseUrl.replace(/\/([^/?]+)(\?|$)/, `/${cfg.DB_NAME}_test$2`);
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run the integration tests against "${name}": the test database name must end in "_test" (set TEST_DATABASE_URL).`);
  }
  return url;
}

export async function databaseReachable(url = testDatabaseUrl()): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
