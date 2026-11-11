/** Fails fast with a helpful message when the test database is not prepared. */
import { databaseReachable, testDatabaseUrl } from './helpers/db.js';

if (!(await databaseReachable())) {
  throw new Error(
    `Cannot reach the test database (${testDatabaseUrl()}).\n` +
      `Run:  npm run db:start && npm run db:migrate && npm run db:seed\n` +
      `or:   npm -w @srisaa/noc-api run db:setup`,
  );
}
