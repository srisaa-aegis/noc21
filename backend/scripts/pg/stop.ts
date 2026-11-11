/** npm run db:stop — stop the local cluster. */
import { PGDATA, clusterExists, fail, isRunning, ok, runPg } from './cluster.js';

if (!clusterExists() || !isRunning()) {
  ok('PostgreSQL is not running.');
  process.exit(0);
}
const r = runPg('pg_ctl', ['-D', PGDATA, '-m', 'fast', '-w', 'stop']);
if (r.status !== 0) fail(`pg_ctl stop failed:\n${r.stderr || r.stdout}`);
ok('PostgreSQL stopped.');
