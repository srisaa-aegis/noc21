#!/usr/bin/env node
/**
 * Development server management.
 *
 *   node scripts/servers.mjs check    refuse to start if :3000 / :4200 are taken, and say by what
 *   node scripts/servers.mjs stop     stop the API and web dev servers (not the database)
 *   node scripts/servers.mjs status   what is running: database, API, web
 *   node scripts/servers.mjs env      create backend/.env from .env.example if missing; list settings
 *                                     that .env.example has and .env lacks (an older copy)
 *
 * Works without ss / lsof / fuser (not installed in every sandbox): listening
 * sockets are read from /proc/net/tcp{,6} and matched to processes through
 * /proc/<pid>/fd. Root sees every process; an ordinary user sees their own.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const API_PORT = Number(process.env.PORT ?? 3000);
const WEB_PORT = Number(process.env.WEB_PORT ?? 4200);
const DB_PORT = Number(process.env.DB_PORT ?? 5432);

/** inodes of sockets listening on `port` (IPv4 and IPv6). */
function listeningInodes(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const [, local, , state] = cols;
      if (state === '0A' && local.endsWith(`:${hex}`)) inodes.add(cols[9]);
    }
  }
  return inodes;
}

/** Processes that own a listening socket on `port`. */
function processesOnPort(port) {
  const inodes = listeningInodes(port);
  if (!inodes.size) return { listening: false, pids: [] };
  const pids = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // not ours, or gone
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m && inodes.has(m[1])) {
          pids.push(Number(pid));
          break;
        }
      } catch {
        /* raced */
      }
    }
  }
  return { listening: true, pids };
}

function commandOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '?';
  }
}

function ownerOf(pid) {
  try {
    const uid = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1];
    const passwd = readFileSync('/etc/passwd', 'utf8');
    return passwd.split('\n').find((l) => l.split(':')[2] === uid)?.split(':')[0] ?? uid;
  } catch {
    return '?';
  }
}

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return { ok: true, status: res.status, body: await res.text() };
  } catch {
    return { ok: false };
  }
}

async function describe(name, port, url) {
  const { listening, pids } = processesOnPort(port);
  if (!listening) return { name, port, running: false };
  const answer = url ? await probe(url) : { ok: true };
  return {
    name,
    port,
    running: true,
    pids,
    who: pids.map((p) => `${p} (${ownerOf(p)}): ${commandOf(p).slice(0, 90)}`),
    ours: answer.ok && (!url || /noc-api|NOC Portal|"ready"/.test(answer.body ?? '')),
  };
}

async function state() {
  return [
    await describe('API', API_PORT, `http://127.0.0.1:${API_PORT}/version`),
    await describe('Web', WEB_PORT, `http://127.0.0.1:${WEB_PORT}/`),
    await describe('PostgreSQL', DB_PORT),
  ];
}

/** Children first, so the watcher does not restart what we just stopped. */
function descendants(pid) {
  const out = [];
  for (const p of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const ppid = readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1]?.split(' ')[1];
      if (Number(ppid) === pid) out.push(...descendants(Number(p)), Number(p));
    } catch {
      /* gone */
    }
  }
  return out;
}

function parentChain(pid) {
  // The dev servers are started through `npm` → `sh -c` → `ng`/`tsx watch` →
  // node; stop the whole chain rooted at the watcher so nothing respawns.
  const chain = [];
  let current = pid;
  for (let i = 0; i < 6; i++) {
    let ppid;
    try {
      ppid = Number(readFileSync(`/proc/${current}/stat`, 'utf8').split(') ')[1]?.split(' ')[1]);
    } catch {
      break;
    }
    if (!ppid || ppid <= 1) break;
    const cmd = commandOf(ppid);
    if (!/tsx|ng serve|node_modules\/\.bin|npm|concurrently|sh -c/.test(cmd)) break;
    if (/concurrently/.test(cmd)) {
      chain.push(ppid);
      break;
    }
    chain.push(ppid);
    current = ppid;
  }
  return chain;
}

function kill(pids) {
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      killed++;
    } catch {
      /* already gone or not permitted */
    }
  }
  return killed;
}

const command = process.argv[2] ?? 'status';

if (command === 'env') {
  const env = resolve(ROOT, 'backend', '.env');
  const example = resolve(ROOT, 'backend', '.env.example');
  if (!existsSync(env)) {
    copyFileSync(example, env);
    console.log('  \u2713 backend/.env created from backend/.env.example');
    process.exit(0);
  }
  const keys = (file) =>
    new Set(
      readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => /^\s*#?\s*([A-Z][A-Z0-9_]+)=/.exec(l)?.[1])
        .filter(Boolean),
    );
  const have = keys(env);
  const missing = [...keys(example)].filter((k) => !have.has(k));
  if (missing.length) {
    console.log(`  ! backend/.env is older than backend/.env.example and lacks: ${missing.join(', ')}`);
    console.log('    The built-in defaults apply to those. Compare the two files (or copy .env.example over .env).');
  }
  process.exit(0);
}

if (command === 'status') {
  for (const s of await state()) {
    if (!s.running) console.log(`  ${s.name.padEnd(11)} stopped (port ${s.port} free)`);
    else {
      console.log(`  ${s.name.padEnd(11)} running on :${s.port}${s.ours === false ? '  (NOT this project)' : ''}`);
      for (const w of s.who) console.log(`              pid ${w}`);
      if (!s.pids.length) console.log('              (owned by another user — run as that user or as root to see it)');
    }
  }
  process.exit(0);
}

if (command === 'check') {
  const busy = (await state()).filter((s) => s.running && s.name !== 'PostgreSQL');
  if (!busy.length) process.exit(0);
  console.error('\n  Cannot start the dev servers: a port is already in use.\n');
  for (const s of busy) {
    console.error(`  • ${s.name} port ${s.port}: ${s.ours ? 'the NOC ' + s.name + ' is already running' : 'used by another program'}`);
    for (const w of s.who) console.error(`      pid ${w}`);
  }
  if (busy.every((s) => s.ours)) {
    console.error('\n  The servers from an earlier `npm run dev` are still running and serve this codebase.');
    console.error(`  Either keep using them (http://localhost:${WEB_PORT}), or restart them:\n`);
  }
  console.error('      npm run stop      # stops the API and web servers (the database keeps running)');
  console.error('      npm run dev\n');
  process.exit(1);
}

if (command === 'stop') {
  let stopped = 0;
  for (const s of await state()) {
    if (!s.running || s.name === 'PostgreSQL') continue;
    if (!s.pids.length) {
      console.log(`  ! ${s.name} on :${s.port} belongs to another user; stop it as that user (or as root).`);
      continue;
    }
    const targets = new Set();
    for (const pid of s.pids) {
      for (const p of parentChain(pid)) targets.add(p);
      for (const d of descendants(pid)) targets.add(d);
      targets.add(pid);
    }
    stopped += kill([...targets]);
    console.log(`  ✓ ${s.name} stopped (port ${s.port})`);
  }
  if (!stopped) console.log('  Nothing to stop: the API and web servers are not running.');
  await new Promise((r) => setTimeout(r, 800));
  process.exit(0);
}

console.error(`Unknown command "${command}". Use: check | stop | status`);
process.exit(2);

void ROOT;
