/**
 * npm run perf:probe [-- --db noc_load] [--runs 3] [--budget 500] [--only <path text>] [--plans <ms>]
 *                     [--users 100] [--seconds 60] [--think 5000] [--workers 2] [--sections reads,writes,load]
 *
 * Times the hot API calls of every portal against a (large) database and
 * explains the SQL behind them:
 *
 *   - each call runs once to warm up, then --runs times; the median is reported;
 *   - the SQL of one run is captured and every SELECT is re-run with
 *     EXPLAIN (ANALYZE, BUFFERS); sequential scans of large tables are flagged;
 *   - calls slower than their budget are listed at the end and the exit code
 *     is 1. Budgets: screens 500 ms (--budget), reports and the escalation
 *     preview (aggregations over every file) 1 500 ms, CSV exports 15 s.
 *
 * Then (unless --only) the write path is timed — a citizen saves, pays, uploads
 * and submits a new application, every officer submits his task and the issuing
 * authority decides — and a mixed workload of --users concurrent virtual users
 * runs for --seconds over HTTP (p50 / p95 / p99, errors, pool waits). Each user
 * pauses --think ms on average between requests (0 = back to back, a stress test).
 *
 * The report is printed and written to var/perf/probe-<time>.md.
 * Build the large database first: npm run db:load-test-data
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { requiredDocuments, type Application, type DocumentRequirements, type FormDef } from '@srisaa/noc-domain';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { PDF, UNDERTAKINGS, multipart, validFormData } from '../../tests/helpers/journey.js';

const cfg = config();
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const target = opt('--db') ?? 'noc_load';
const runs = Number(opt('--runs') ?? 3);
const budget = Number(opt('--budget') ?? 500);
/** Only the calls whose path contains this text. */
const only = opt('--only');
/** Print the text plan of every statement slower than this many ms. */
const plansOver = opt('--plans') !== undefined ? Number(opt('--plans')) : null;
const users = Number(opt('--users') ?? 100);
const seconds = Number(opt('--seconds') ?? 60);
/** Mean pause of a virtual user between two requests (a person reading the page), ms. */
const think = Number(opt('--think') ?? 5000);
/** API processes for the workload (API_WORKERS). */
const workers = Number(opt('--workers') ?? 2);
/** Which parts to run: reads, writes, load (default all). */
const sections = new Set((opt('--sections') ?? 'reads,writes,load').split(','));
const url = new URL(cfg.databaseUrl);
url.pathname = `/${target}`;

// ── SQL capture (every query of the pg driver while `capturing`) ─────────────
interface Captured {
  text: string;
  values: unknown[];
}
let capturing: Captured[] | null = null;
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function patched(this: pg.Client, ...args: unknown[]) {
  const [first, second] = args as [string | { text: string; values?: unknown[] }, unknown[] | undefined];
  if (capturing) {
    const text = typeof first === 'string' ? first : first?.text;
    const values = (typeof first === 'string' ? second : (first?.values ?? second)) ?? [];
    if (text && /^\s*(select|with)\b/i.test(text)) capturing.push({ text, values: Array.isArray(values) ? values : [] });
  }
  return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
} as typeof pg.Client.prototype.query;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

function seqScans(node: PlanNode, big: Set<string>, out: string[] = []): string[] {
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] && big.has(node['Relation Name'])) out.push(node['Relation Name']);
  for (const p of node.Plans ?? []) seqScans(p, big, out);
  return out;
}

async function main(): Promise<void> {
  const app = await buildApp({ databaseUrl: url.toString(), logger: false, limits: { global: 1_000_000, auth: 1_000 } });
  await app.ready();
  const explainer = new pg.Client({ connectionString: url.toString() });
  await explainer.connect();
  const lines: string[] = [];
  const say = (s: string) => {
    console.log(s);
    lines.push(s);
  };
  const slow: string[] = [];

  try {
    const big = new Set(
      (
        await explainer.query<{ relname: string }>(`select relname from pg_stat_user_tables where n_live_tup > 20000`)
      ).rows.map((r) => r.relname),
    );
    const appCount = Number((await explainer.query(`select count(*)::int as n from applications`)).rows[0].n);
    say(`# Performance probe — ${target} (${appCount} applications), ${new Date().toISOString()}`);
    say('');

    const login = async (username: string) => {
      const res = await app.inject({ method: 'POST', url: `${cfg.API_PREFIX}/auth/login`, payload: { username, password: cfg.SEED_DEMO_PASSWORD } });
      if (res.statusCode !== 200) throw new Error(`login ${username}: ${res.statusCode} ${res.body}`);
      return { authorization: `Bearer ${(res.json() as { accessToken: string }).accessToken}` };
    };
    const pick = async (sql: string) => (await explainer.query(sql)).rows[0]?.id as number | undefined;

    const citizen = await login((await explainer.query(`select username from users where username like 'load%' order by id limit 1`)).rows[0]?.username ?? 'citizen1');
    const citizenApp = await pick(`select a.id from applications a join users u on u.id = a.owner_user_id where u.username like 'load%' order by u.id, a.id limit 1`);
    // a realistic search: an application number (the broad 'tower' search is the worst case)
    const number = ((await explainer.query(`select appl_number from applications where appl_number is not null order by id desc limit 1`)).rows[0]?.appl_number as string) ?? '2026';
    const dfs = await login('dfs.officer');
    const dfsApp = await pick(`select i.subject_id as id from wf_tasks t join wf_instances i on i.id = t.instance_id join users u on u.id = t.assignee_user_id where u.username = 'dfs.officer' and t.state = 'active' limit 1`);
    // The busiest district officer (a synthetic load.dfo.<district> in the load database).
    const dfoName =
      (
        await explainer.query(`
          select u.username from wf_tasks t join users u on u.id = t.assignee_user_id join dept_profiles p on p.user_id = u.id
            join dept_roles r on r.id = p.role_id where t.state = 'active' and r.code = 'DFO' group by 1 order by count(*) desc limit 1`)
      ).rows[0]?.username ?? 'dfo.visakhapatnam';
    const dfo = await login(dfoName);
    const monitor = await login('monitor.hq');
    const admin = await login('admin');

    const calls: { who: string; headers: Record<string, string>; path: string }[] = [
      { who: 'citizen', headers: citizen, path: '/applications?scope=mine&pageSize=all' },
      { who: 'citizen', headers: citizen, path: `/applications/${citizenApp}` },
      { who: 'dfs.officer', headers: dfs, path: '/dept/tasks' },
      { who: 'dfs.officer', headers: dfs, path: '/dept/monitoring' },
      { who: 'dfs.officer', headers: dfs, path: '/dept/monitoring?includeDecided=true&page=3' },
      { who: 'dfs.officer', headers: dfs, path: `/dept/applications/${dfsApp}` },
      { who: 'dfs.officer', headers: dfs, path: '/applications?scope=dept&text=tower&pageSize=50' },
      { who: 'dfs.officer', headers: dfs, path: `/applications?scope=dept&text=${number}&pageSize=50` },
      { who: dfoName, headers: dfo, path: '/dept/tasks' },
      { who: dfoName, headers: dfo, path: '/dept/monitoring' },
      { who: dfoName, headers: dfo, path: '/dept/monitoring?includeDecided=true&page=2' },
      { who: 'monitor.hq', headers: monitor, path: '/dept/monitoring?overdueOnly=true' },
      { who: 'monitor.hq', headers: monitor, path: '/dept/feedback-summary?months=12' },
      ...['pendency', 'statistics', 'consolidated', 'applications', 'overdue', 'sms', 'feedback', 'challan', 'district', 'levels'].map((r) => ({
        who: 'monitor.hq',
        headers: monitor,
        // fresh=true: time the computation, not the one-minute memo (N-16)
        path: `/dept/reports/${r}?fresh=true`,
      })),
      { who: 'monitor.hq', headers: monitor, path: '/dept/reports/statistics?level=MSB&from=2025-01-01&to=2025-12-31&fresh=true' },
      { who: 'monitor.hq', headers: monitor, path: '/dept/reports/applications?format=csv' },
      { who: 'admin', headers: admin, path: '/applications?scope=all&draftsOnly=true&sort=-days_idle&pageSize=100' },
      { who: 'admin', headers: admin, path: '/applications?scope=all&idleDays=90&pageSize=1' },
      { who: 'admin', headers: admin, path: '/admin/accounts?portal=citizen&q=load12&pageSize=100' },
      { who: 'admin', headers: admin, path: '/admin/statuses' },
      { who: 'admin', headers: admin, path: '/admin/unassigned-tasks' },
      { who: 'admin', headers: admin, path: '/admin/escalations/preview' },
      { who: 'admin', headers: admin, path: '/config/workflows/usage' },
    ];

    say('| call | who | status | median ms | SQL | slowest SQL ms | seq scans of large tables |');
    say('|---|---|---|---|---|---|---|');
    for (const c of calls.filter((x) => sections.has('reads') && (!only || x.path.includes(only)))) {
      const request = () => app.inject({ method: 'GET', url: `${cfg.API_PREFIX}${c.path}`, headers: c.headers });
      await request(); // warm-up
      const times: number[] = [];
      let status = 0;
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        status = (await request()).statusCode;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      capturing = [];
      await request();
      const captured = capturing;
      capturing = null;
      let slowestSql = 0;
      const scans = new Set<string>();
      for (const q of captured) {
        try {
          const plan = await explainer.query(`explain (analyze, buffers, format json) ${q.text}`, q.values);
          const root = (plan.rows[0]['QUERY PLAN'] as { Plan: PlanNode; 'Execution Time': number }[])[0];
          slowestSql = Math.max(slowestSql, root['Execution Time']);
          for (const t of seqScans(root.Plan, big)) scans.add(t);
          if (plansOver !== null && root['Execution Time'] >= plansOver) {
            const text = await explainer.query(`explain (analyze, buffers) ${q.text}`, q.values);
            console.log(`\n--- ${c.path} (${c.who}) ${root['Execution Time'].toFixed(1)} ms\n${q.text}\n${JSON.stringify(q.values)}\n${text.rows.map((r) => r['QUERY PLAN']).join('\n')}\n`);
          }
        } catch (e) {
          if (process.env.PROBE_DEBUG) console.error('explain failed:', (e as Error).message, q.text.slice(0, 200), q.values);
        }
      }
      say(`| ${c.path} | ${c.who} | ${status} | ${median.toFixed(0)} | ${captured.length} | ${slowestSql.toFixed(1)} | ${[...scans].join(', ') || '—'} |`);
      const limit = c.path.includes('format=csv') ? 15_000 : /\/dept\/reports\/|\/admin\/escalations\//.test(c.path) ? Math.max(budget, 1500) : budget;
      if (median > limit || status >= 500) slow.push(`${c.path} (${c.who}): ${median.toFixed(0)} ms (budget ${limit} ms), status ${status}`);
    }
    say('');

    if (!only && sections.has('writes')) {
      // ── Writes: one application from draft to decision ─────────────────────
      const timed = async (label: string, budgetMs: number, run: () => Promise<{ statusCode: number; json: () => unknown }>) => {
        const t0 = performance.now();
        const res = await run();
        const ms = performance.now() - t0;
        say(`| ${label} | ${res.statusCode} | ${ms.toFixed(0)} | ${budgetMs} |`);
        if (ms > budgetMs || res.statusCode >= 400) slow.push(`${label}: ${ms.toFixed(0)} ms (budget ${budgetMs} ms), status ${res.statusCode}`);
        return res.json() as Record<string, unknown>;
      };
      const call = (method: string, path: string, headers: Record<string, string>, payload?: unknown) =>
        app.inject({ method: method as 'GET', url: `${cfg.API_PREFIX}${path}`, headers, payload: payload as never });
      say('| write | status | ms | budget ms |');
      say('|---|---|---|---|');
      const template = (await call('GET', '/applications/101', await login('citizen1'))).json() as Application;
      const rules = (await call('GET', '/lookups/document-requirements', citizen)).json() as DocumentRequirements;
      const created = (await timed('create a draft (POST /applications)', 300, () =>
        call('POST', '/applications', citizen, { appl_type: 'P', site_name: 'Probe Towers', site_addr: 'Plot 9, Probe Nagar' }),
      )).application as Application;
      const saved = (await timed('save the whole application with the server assessment (PUT)', 300, () =>
        call('PUT', `/applications/${created.appl_id}`, citizen, {
          ...created,
          district: template.district,
          fire_station_id: template.fire_station_id,
          corr_addr: template.corr_addr,
          plot_area: template.plot_area,
          perimeter: template.perimeter,
          lic_auth: template.lic_auth,
          lic_addr: template.lic_addr,
          parties: template.parties,
          blocks: template.blocks,
          declaration_accepted: true,
        }),
      )).application as Application;
      await timed('pay online (POST …/payment)', 300, () => call('POST', `/applications/${saved.appl_id}/payment`, { ...citizen, 'idempotency-key': `probe-${saved.appl_id}` }, { mode: 'online' }));
      const docs = requiredDocuments(saved, rules).filter((d) => !d.optional && d.code !== 'ChallanCopy');
      const t0 = performance.now();
      for (const d of docs) {
        const m = multipart({ code: d.code }, { name: `${d.code}.pdf`, content: PDF });
        await app.inject({ method: 'POST', url: `${cfg.API_PREFIX}/applications/${saved.appl_id}/documents`, headers: { ...citizen, ...m.headers }, payload: m.payload });
      }
      say(`| upload ${docs.length} documents (mean per upload) | 201 | ${((performance.now() - t0) / docs.length).toFixed(0)} | 300 |`);
      let app1 = (await timed('submit (validation, number, workflow start)', 500, () =>
        call('POST', `/applications/${saved.appl_id}/submit`, citizen, { undertakings: UNDERTAKINGS }),
      )).application as Application;
      const forms = (await call('GET', '/config/forms', monitor)).json() as FormDef[];
      const tokens: Record<string, Record<string, string>> = {};
      const as = async (u: string) => (tokens[u] ??= await login(u));
      const finalStage = () => app1.workflow!.stages.at(-1)!.key;
      for (let round = 0; round < 30; round++) {
        const open = app1.workflow!.tasks.filter((t) => t.state === 'active' && t.stage_key !== finalStage());
        if (!open.length) break;
        let moved = false;
        for (const t of open) {
          const form = forms.find((f) => f.id === t.form)!;
          const r = await call('POST', `/dept/applications/${saved.appl_id}/tasks/${t.task_id}/submit`, await as(t.assignee!), { data: validFormData(form, app1, t.assignee_name ?? '') });
          if (r.statusCode === 200) {
            app1 = (r.json() as { application: Application }).application;
            moved = true;
            break;
          }
        }
        if (!moved) break;
      }
      const decision = app1.workflow!.tasks.find((t) => t.state === 'active' && t.stage_key === finalStage());
      if (decision) {
        const approver = await as(decision.assignee!);
        const m = multipart({}, { name: 'signed.pdf', content: PDF });
        await app.inject({ method: 'POST', url: `${cfg.API_PREFIX}/dept/applications/${saved.appl_id}/tasks/${decision.task_id}/signed-copy`, headers: { ...approver, ...m.headers }, payload: m.payload });
        await timed('decide: approve (workflow transition + snapshot)', 500, () =>
          call('POST', `/dept/applications/${saved.appl_id}/tasks/${decision.task_id}/decide`, approver, { outcome: 'approve', input: { remark: 'Probe.' } }),
        );
      }
      // one more transition, timed: a task of another file in process
      const other = (await explainer.query(`
        select i.subject_id as id, t.task_no, u.username from wf_tasks t join wf_instances i on i.id = t.instance_id and i.status = 'running'
          join users u on u.id = t.assignee_user_id join wf_forms f on f.id = t.form_id
         where t.state = 'active' and f.code = 'dfs_note' limit 1`)).rows[0] as { id: number; task_no: number; username: string } | undefined;
      if (other) {
        const who = await as(other.username);
        const view = (await call('GET', `/dept/applications/${other.id}`, who)).json() as { application: Application };
        await timed('workflow transition: submit a DFS note (POST …/tasks/:n/submit)', 200, () =>
          call('POST', `/dept/applications/${other.id}/tasks/${other.task_no}/submit`, who, {
            data: validFormData(forms.find((f) => f.id === 'dfs_note')!, view.application, 'DFS'),
          }),
        );
      }
      say('');
    }
    {
      // ── Concurrency: a mixed workload over HTTP ──────────────────────────────
      if (!only && sections.has('load') && users > 0 && seconds > 0) {
        // The API under test runs in its own process (as in production); this
        // process only plays the users, so the two do not share an event loop.
        const port = 3900 + Math.floor(Math.random() * 90);
        const server = spawn('npx', ['tsx', '--env-file-if-exists=.env', 'src/main.ts'], {
          cwd: join(cfg.repoRoot, 'backend'),
          env: {
            ...process.env,
            DATABASE_URL: url.toString(),
            PORT: String(port),
            LOG_LEVEL: 'warn',
            ENABLE_SCHEDULER: 'false',
            API_WORKERS: String(workers),
            RATE_LIMIT_LOGIN_PER_MINUTE: '100000',
            RATE_LIMIT_GLOBAL_PER_MINUTE: '10000000',
          },
          stdio: 'ignore',
          detached: true,
        });
        const base = `http://127.0.0.1:${port}${cfg.API_PREFIX}`;
        for (let i = 0; i < 120; i++) {
          const ok = await fetch(`http://127.0.0.1:${port}/ready`).then((r) => r.ok).catch(() => false);
          if (ok) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        // Weighted like a working day: opening files and queues dominates, reports are rare.
        const weighted = (n: number, e: { headers: Record<string, string>; path: string }) => Array.from({ length: n }, () => e);
        const mix: { headers: Record<string, string>; path: string }[] = [
          ...weighted(3, { headers: citizen, path: '/applications?scope=mine&pageSize=all' }),
          ...weighted(3, { headers: citizen, path: `/applications/${citizenApp}` }),
          ...weighted(3, { headers: dfo, path: '/dept/tasks' }),
          ...weighted(2, { headers: dfo, path: '/dept/monitoring' }),
          ...weighted(3, { headers: dfs, path: '/dept/tasks' }),
          ...weighted(3, { headers: dfs, path: `/dept/applications/${dfsApp}` }),
          ...weighted(1, { headers: dfs, path: `/applications?scope=dept&text=${number}&pageSize=25` }),
          ...weighted(1, { headers: monitor, path: '/dept/reports/statistics' }),
          ...weighted(2, { headers: {}, path: '/meta/versions' }),
        ];
        const latencies: number[] = [];
        let errors = 0;
        const failures = new Map<string, number>();
        const perPath = new Map<string, number[]>();
        // Busy API connections, sampled from PostgreSQL.
        let maxBusy = 0;
        const sampler = setInterval(() => {
          void explainer
            .query(`select count(*)::int as n from pg_stat_activity where application_name = 'noc-api' and state = 'active'`)
            .then((r) => (maxBusy = Math.max(maxBusy, Number(r.rows[0].n))))
            .catch(() => undefined);
        }, 100);
        const until = Date.now() + seconds * 1000;
        await Promise.all(
          Array.from({ length: users }, async (_, u) => {
            let i = u;
            // ramp up: the users arrive over one pause, not all in the same millisecond
            await new Promise((r) => setTimeout(r, (u / users) * think));
            while (Date.now() < until) {
              const c = mix[i++ % mix.length];
              const t1 = performance.now();
              try {
                const res = await fetch(`${base}${c.path}`, { headers: c.headers });
                await res.arrayBuffer();
                if (res.status >= 400) {
                  errors++;
                  failures.set(`${res.status} ${c.path}`, (failures.get(`${res.status} ${c.path}`) ?? 0) + 1);
                }
              } catch (e) {
                errors++;
                failures.set(`${(e as Error).message} ${c.path}`, (failures.get(`${(e as Error).message} ${c.path}`) ?? 0) + 1);
              }
              latencies.push(performance.now() - t1);
              perPath.set(c.path, [...(perPath.get(c.path) ?? []), performance.now() - t1]);
              if (think > 0) await new Promise((r) => setTimeout(r, think * (0.5 + ((i * 7919) % 100) / 100)));
            }
          }),
        );
        clearInterval(sampler);
        try {
          process.kill(-server.pid!, 'SIGTERM');
        } catch {
          /* already gone */
        }
        latencies.sort((a, b) => a - b);
        const q = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
        say(`Mixed workload: ${users} concurrent users (${think} ms average pause) for ${seconds} s over HTTP against ${workers} API process(es) — ${latencies.length} requests (${(latencies.length / seconds).toFixed(0)}/s), ` +
          `p50 ${q(0.5).toFixed(0)} ms, p95 ${q(0.95).toFixed(0)} ms, p99 ${q(0.99).toFixed(0)} ms, errors ${errors}, ` +
          `at most ${maxBusy} of the ${cfg.DB_POOL_MAX} pooled database connections busy at once.`);
        for (const [path, ms] of perPath) {
          ms.sort((a, b) => a - b);
          say(`  - ${path}: ${ms.length} requests, median ${ms[Math.floor(ms.length / 2)].toFixed(0)} ms`);
        }
        if (errors) slow.push(`mixed workload: ${errors} error(s): ${[...failures.entries()].map(([k, n]) => `${k} ×${n}`).join('; ')}`);
        if (think > 0 && q(0.95) > 1000) slow.push(`mixed workload: p95 ${q(0.95).toFixed(0)} ms (budget 1 000 ms)`);
        say('');
      }
    }

    say(slow.length ? `Over budget:\n${slow.map((s) => `- ${s}`).join('\n')}` : `Every call is within its budget (screens ${budget} ms, reports 1 500 ms, exports 15 s, writes as listed).`);
  } finally {
    await explainer.end();
    await app.close();
  }
  const dir = join(cfg.repoRoot, 'var', 'perf');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(file, lines.join('\n') + '\n');
  console.log(`\nReport: ${file}`);
  process.exit(slow.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`  \u2717 ${(e as Error).message}`);
  process.exit(1);
});
