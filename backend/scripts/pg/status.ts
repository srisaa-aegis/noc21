/** npm run db:status — cluster state, version and databases. */
import { PGDATA, cfg, clusterExists, clusterOwner, isRoot, isRunning, ok, psqlSuper, say, serverVersion } from './cluster.js';

say(`PGDATA      ${PGDATA}`);
say(`Port        ${cfg.DB_PORT}`);
if (isRoot()) say(`OS user     ${clusterOwner()?.name} (PostgreSQL never runs as root)`);
say(`Cluster     ${clusterExists() ? `initialised (PostgreSQL ${serverVersion()})` : 'NOT initialised — run: npm run db:init'}`);
if (!isRunning()) {
  say('Server      stopped — run: npm run db:start');
  process.exit(0);
}
ok(`Server      running`);
const dbs = psqlSuper("select datname from pg_database where datistemplate = false order by 1");
say(`Databases   ${dbs.stdout.trim().split('\n').filter(Boolean).join(', ') || '(none)'}`);
const tables = psqlSuper(
  "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  cfg.DB_NAME,
);
if (tables.status === 0) say(`Tables      ${tables.stdout.trim()} in "${cfg.DB_NAME}".public`);
