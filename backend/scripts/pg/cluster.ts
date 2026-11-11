/**
 * Local PostgreSQL cluster control.
 *
 * The project runs its own cluster in `<repo>/.pgdata` with initdb / pg_ctl.
 *
 * PostgreSQL refuses to run as root ("pg_ctl: cannot be run as root"). When
 * these scripts are invoked by root, the server-side binaries (initdb, pg_ctl)
 * are executed through `runuser` as the cluster owner:
 *
 *   1. the owner of an existing `.pgdata` (so a cluster created by a normal
 *      user keeps working when root runs the scripts), otherwise
 *   2. `PG_OS_USER` from the environment, otherwise
 *   3. the `postgres` OS user that the PostgreSQL packages create.
 *
 * The data, socket and log directories are handed to that user. Clients
 * (psql, pg_isready, pg_dump, the API) connect over TCP and may run as anyone.
 */
import { spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../../src/config/env.js';

export const cfg = config();

export const PGDATA = cfg.PGDATA_DIR;
export const PGSOCKET = cfg.PG_SOCKET_DIR;
export const LOG_FILE = resolve(cfg.repoRoot, 'var', 'log', 'postgres.log');

/** Binaries that must never run as root. */
const SERVER_BINARIES = new Set(['initdb', 'pg_ctl', 'postgres']);

export const isRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;

export interface OsUser {
  name: string;
  uid: number;
  gid: number;
}

function passwdEntries(): OsUser[] {
  try {
    return readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, , uid, gid] = line.split(':');
        return { name, uid: Number(uid), gid: Number(gid) };
      });
  } catch {
    return [];
  }
}

export function osUserByName(name: string): OsUser | undefined {
  return passwdEntries().find((u) => u.name === name);
}

export function osUserByUid(uid: number): OsUser | undefined {
  return passwdEntries().find((u) => u.uid === uid);
}

/**
 * Which OS user owns (or will own) the cluster. `undefined` when the scripts
 * are not running as root: then the current user simply owns it.
 */
export function clusterOwner(opts: { root?: boolean; dataDir?: string; envUser?: string } = {}): OsUser | undefined {
  const root = opts.root ?? isRoot();
  if (!root) return undefined;
  const dataDir = opts.dataDir ?? PGDATA;
  if (existsSync(dataDir)) {
    const owner = osUserByUid(statSync(dataDir).uid);
    if (owner && owner.uid !== 0) return owner;
  }
  const wanted = opts.envUser ?? process.env.PG_OS_USER ?? 'postgres';
  const user = osUserByName(wanted);
  if (!user) {
    fail(
      `PostgreSQL cannot run as root and the OS user "${wanted}" does not exist.\n` +
        `    Create one (e.g. "useradd --system --home /var/lib/postgresql postgres"),\n` +
        `    or set PG_OS_USER in backend/.env to an existing unprivileged user.`,
    );
  }
  if (user.uid === 0) fail(`PG_OS_USER must not be root.`);
  return user;
}

/**
 * The exact argv used to run a PostgreSQL binary: unchanged for a normal user,
 * wrapped in `runuser -u <owner> --` for the server binaries when we are root.
 */
export function pgInvocation(
  binaryPath: string,
  args: string[],
  owner: OsUser | undefined,
): { command: string; args: string[] } {
  const name = binaryPath.split('/').pop() ?? binaryPath;
  if (owner && SERVER_BINARIES.has(name)) {
    return { command: 'runuser', args: ['-u', owner.name, '--', binaryPath, ...args] };
  }
  return { command: binaryPath, args };
}

export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    stdio: opts.quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'],
    cwd: '/', // the cluster owner may not be allowed to read the caller's working directory
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

/** Runs a PostgreSQL binary, as the cluster owner when we are root. */
export function runPg(name: string, args: string[], opts: { quiet?: boolean } = {}) {
  const inv = pgInvocation(binary(name), args, clusterOwner());
  return run(inv.command, inv.args, opts);
}

export function binary(name: string): string {
  const r = run('which', [name], { quiet: true });
  if (r.status === 0) return r.stdout.trim();
  for (const dir of ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/15/bin']) {
    if (existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
  }
  throw new Error(
    `PostgreSQL binary "${name}" not found on PATH. Install PostgreSQL 16 (or add /usr/lib/postgresql/16/bin to PATH).`,
  );
}

export function clusterExists(): boolean {
  return existsSync(resolve(PGDATA, 'PG_VERSION'));
}

export function isRunning(): boolean {
  if (!clusterExists()) return false;
  // pg_isready is a client: it works for any user, root included.
  const r = run(binary('pg_isready'), ['-h', '127.0.0.1', '-p', String(cfg.DB_PORT)], { quiet: true });
  if (r.status === 0) return true;
  return runPg('pg_ctl', ['-D', PGDATA, 'status'], { quiet: true }).status === 0;
}

export function serverVersion(): string {
  if (!clusterExists()) return 'n/a';
  try {
    return readFileSync(resolve(PGDATA, 'PG_VERSION'), 'utf8').trim();
  } catch {
    return 'n/a';
  }
}

function giveTo(path: string, owner: OsUser | undefined): void {
  if (!owner) return;
  try {
    chownSync(path, owner.uid, owner.gid);
  } catch (e) {
    fail(`Could not hand ${path} to ${owner.name}: ${(e as Error).message}`);
  }
}

/** Log and socket directories, writable by the cluster owner. */
export function ensureDirs(): void {
  const owner = clusterOwner();
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  mkdirSync(PGSOCKET, { recursive: true });
  if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '');
  giveTo(dirname(LOG_FILE), owner);
  giveTo(LOG_FILE, owner);
  giveTo(PGSOCKET, owner);
}

/** Creates an empty data directory owned by the cluster owner (before initdb). */
export function prepareDataDir(): void {
  const owner = clusterOwner();
  if (!owner) return; // initdb creates it itself for a normal user
  mkdirSync(PGDATA, { recursive: true, mode: 0o700 });
  giveTo(PGDATA, owner);
  assertTraversable(PGDATA, owner);
}

/** The owner must be able to reach the data directory through every parent. */
function assertTraversable(path: string, owner: OsUser): void {
  let dir = dirname(path);
  while (dir !== dirname(dir)) {
    const st = statSync(dir);
    const others = st.mode & 0o001;
    const group = st.gid === owner.gid && st.mode & 0o010;
    const own = st.uid === owner.uid && st.mode & 0o100;
    if (!others && !group && !own) {
      fail(`The user "${owner.name}" cannot reach ${path}: ${dir} is not searchable. Run: chmod o+x ${dir}`);
    }
    dir = dirname(dir);
  }
}

/** psql as the cluster superuser (over TCP, so it works for any OS user). */
export function psqlSuper(sql: string, database = 'postgres') {
  return run(binary('psql'), [
    '-v',
    'ON_ERROR_STOP=1',
    '-h',
    '127.0.0.1',
    '-p',
    String(cfg.DB_PORT),
    '-U',
    cfg.DB_SUPERUSER,
    '-d',
    database,
    '-tAc',
    sql,
  ]);
}

export function waitReady(timeoutMs = 30_000): boolean {
  const isready = binary('pg_isready');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = run(isready, ['-h', '127.0.0.1', '-p', String(cfg.DB_PORT)], { quiet: true });
    if (r.status === 0) return true;
    spawnSync('sleep', ['0.3']);
  }
  return false;
}

export const say = (msg: string) => console.log(`  ${msg}`);
export const ok = (msg: string) => console.log(`  \u2713 ${msg}`);
export function fail(msg: string): never {
  console.error(`  \u2717 ${msg}`);
  process.exit(1);
}

/** One-line description of who runs the server, for the scripts' output. */
export function ownerNote(): string {
  const owner = clusterOwner();
  return owner ? ` as OS user "${owner.name}" (running as root)` : '';
}
