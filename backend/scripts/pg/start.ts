/** npm run db:start — start the local cluster (idempotent) and wait until it accepts connections. */
import { LOG_FILE, PGDATA, PGSOCKET, cfg, clusterExists, ensureDirs, fail, isRunning, ok, ownerNote, runPg, say, waitReady } from './cluster.js';

if (!clusterExists()) fail(`No cluster at ${PGDATA}. Run: npm run db:init`);
if (isRunning()) {
  ok(`PostgreSQL already running on port ${cfg.DB_PORT}`);
  process.exit(0);
}
ensureDirs();
say(`Starting PostgreSQL on port ${cfg.DB_PORT}${ownerNote()} …`);
const r = runPg('pg_ctl', [
  '-D',
  PGDATA,
  '-l',
  LOG_FILE,
  '-o',
  `-p ${cfg.DB_PORT} -k ${PGSOCKET} -c listen_addresses=127.0.0.1 ${cfg.PG_SERVER_OPTIONS}`,
  '-w',
  'start',
]);
if (r.status !== 0) fail(`pg_ctl start failed:\n${r.stderr || r.stdout}\nSee ${LOG_FILE}`);
if (!waitReady()) fail(`PostgreSQL did not become ready. See ${LOG_FILE}`);
ok(`PostgreSQL ready on 127.0.0.1:${cfg.DB_PORT} (log: ${LOG_FILE})`);
