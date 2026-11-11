/** npm run db:init — create the local cluster if it does not exist (idempotent). */
import { PGDATA, cfg, clusterExists, ensureDirs, fail, ok, ownerNote, prepareDataDir, runPg, say } from './cluster.js';

if (clusterExists()) {
  ok(`PostgreSQL cluster already initialised at ${PGDATA}`);
  process.exit(0);
}
ensureDirs();
prepareDataDir();
say(`Initialising a PostgreSQL cluster at ${PGDATA}${ownerNote()} …`);
const r = runPg('initdb', [
  '-D',
  PGDATA,
  '-U',
  cfg.DB_SUPERUSER,
  '-E',
  'UTF8',
  '--locale=C.UTF-8',
  '--auth-local=trust',
  '--auth-host=trust',
]);
if (r.status !== 0) fail(`initdb failed:\n${r.stderr || r.stdout}`);
ok(`Cluster created (database superuser "${cfg.DB_SUPERUSER}").`);
