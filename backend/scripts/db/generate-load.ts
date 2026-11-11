/**
 * npm run db:load-test-data [-- --db noc_load] [--applications 21000] [--fresh]
 *
 * A large, realistic database for performance work (B3 hardening): the demo
 * applications are cloned — with their blocks, floors, FFE grids, parties,
 * documents, payments, process log and workflow runs — until the database
 * holds the requested number of applications (default 21 000: three years at the
 * expected 7 000 a year; phase B3 was also measured at 300 000).
 *
 *   - mix: ~95 % decided (mostly issued), ~3.5 % in process, ~2 % drafts —
 *     about two months of intake in process, as in a working department;
 *   - dates spread over five years (files in process over the last two months);
 *   - spread over every fire station and district; the district-level tasks
 *     (DFO, SFO) go to a synthetic officer of the file's district
 *     (load.dfo.<district>, load.sfo.<district>, password "demo"), the Head
 *     Office and regional ones to the demo officers;
 *   - one synthetic citizen per ~8 applications (password "demo", e-mail
 *     load<n>@example.com), so "My applications" stays realistic;
 *   - the retained snapshots and stored assessments are not cloned (size).
 *
 * It works on its own database (default noc_load, created, migrated and
 * seeded here) and refuses the development database unless --into-main.
 * Then: npm run perf:probe -- --db noc_load
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { config } from '../../src/config/env.js';
import { fail, isRunning, ok, psqlSuper, say } from '../pg/cluster.js';

const cfg = config();
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const target = opt('--db') ?? 'noc_load';
const wanted = Number(opt('--applications') ?? 21_000);
const BATCH = Number(opt('--batch') ?? 25_000);
const fresh = argv.includes('--fresh');

if (target === cfg.DB_NAME && !argv.includes('--into-main')) fail(`Refusing to fill the development database "${target}"; use --db noc_load (or --into-main).`);
if (/prod/i.test(target)) fail(`"${target}" looks like a production database.`);
if (!Number.isInteger(wanted) || wanted < 1) fail('--applications must be a positive number.');

const url = new URL(cfg.databaseUrl);
url.pathname = `/${target}`;
const targetUrl = url.toString();

function tsx(script: string, env: Record<string, string>): void {
  const r = spawnSync('npx', ['tsx', '--env-file-if-exists=.env', script], { stdio: 'inherit', env: { ...process.env, ...env }, cwd: `${cfg.repoRoot}/backend` });
  if (r.status !== 0) fail(`${script} failed.`);
}

interface Column {
  name: string;
  type: string;
  identity: boolean;
}

async function columnsOf(c: pg.Client, table: string): Promise<Column[]> {
  const r = await c.query<{ column_name: string; data_type: string; is_identity: string }>(
    `select column_name, data_type, is_identity from information_schema.columns
     where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`,
    [table],
  );
  return r.rows.map((x) => ({ name: x.column_name, type: x.data_type, identity: x.is_identity === 'YES' }));
}

/**
 * `insert into <table> (...) select ... from <table> c join <map> m on c.<fk> = m.<from>`:
 * every column copied, the key column re-pointed, dates shifted by `m.delta` days.
 */
async function copy(
  c: pg.Client,
  table: string,
  opts: { fk: string; map: string; from: string; to: string; set?: Record<string, string>; where?: string },
): Promise<number> {
  const cols = (await columnsOf(c, table)).filter((col) => col.name !== 'id' || opts.fk === 'id');
  const expr = (col: Column): string => {
    if (opts.set && col.name in opts.set) return opts.set[col.name];
    if (col.name === opts.fk) return `m.${opts.to}`;
    if (col.name === 'created_at' || col.name === 'updated_at') return 'now()';
    if (col.type === 'date') return `c.${col.name} + m.delta`;
    if (col.type.startsWith('timestamp')) return `c.${col.name} + make_interval(days => m.delta)`;
    return `c."${col.name}"`;
  };
  const sql = `insert into "${table}" (${cols.map((x) => `"${x.name}"`).join(', ')})
    overriding system value
    select ${cols.map(expr).join(', ')} from "${table}" c join ${opts.map} m on c."${opts.fk}" = m.${opts.from}${opts.where ? ` where ${opts.where}` : ''}`;
  return (await c.query(sql)).rowCount ?? 0;
}

async function main(): Promise<void> {
  if (!isRunning()) fail('PostgreSQL is not running. Run: npm run db:start');

  // 1. The database: created, migrated and seeded with the demo data (the templates).
  const exists = psqlSuper(`select 1 from pg_database where datname = '${target}'`).stdout.trim() === '1';
  if (exists && fresh) {
    psqlSuper(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${target}' and pid <> pg_backend_pid()`);
    if (psqlSuper(`drop database "${target}"`).status !== 0) fail(`Could not drop "${target}".`);
  }
  if (!exists || fresh) {
    const r = psqlSuper(`create database "${target}" owner "${cfg.DB_USER}"`);
    if (r.status !== 0) fail(`Could not create "${target}": ${r.stderr}`);
    ok(`Database "${target}" created.`);
  }
  tsx('scripts/db/migrate.ts', { MIGRATE_DATABASE_URL: targetUrl });

  const c = new pg.Client({ connectionString: targetUrl });
  await c.connect();
  try {
    const count = async () => Number((await c.query(`select count(*)::int as n from applications where deleted_at is null`)).rows[0].n);
    if ((await count()) === 0) {
      tsx('scripts/db/seed.ts', { SEED_DATABASE_URL: targetUrl });
    }
    const have = await count();
    if (have >= wanted) {
      ok(`"${target}" already holds ${have} applications (asked for ${wanted}).`);
      return;
    }

    // 2. Templates: the demo applications, weighted to a realistic mix.
    await c.query(`drop table if exists load_tpl; create table load_tpl (rn serial primary key, template_id int not null, status_id int not null)`);
    await c.query(`
      insert into load_tpl (template_id, status_id)
      select a.id, a.status_id from applications a
      cross join lateral generate_series(1, case when a.status_id = 7 then 30 when a.status_id in (8, 9) then 6 else 1 end)
      where a.deleted_at is null and a.id <= 1000
      order by a.id`);
    const templates = Number((await c.query(`select count(*)::int as n from load_tpl`)).rows[0].n);

    // 3. Synthetic citizens (password "demo", copied from citizen1).
    const citizensWanted = Math.ceil(wanted / 8);
    const haveCitizens = Number((await c.query(`select count(*)::int as n from users where username like 'load%@example.com'`)).rows[0].n);
    if (haveCitizens < citizensWanted) {
      say(`Creating ${citizensWanted - haveCitizens} synthetic citizens …`);
      await c.query(
        `insert into users (username, email, password_hash, password_algo, portal, display_name, mobile, active, must_change_password, created_on)
         select 'load' || n || '@example.com', 'load' || n || '@example.com', u.password_hash, u.password_algo, 'citizen', 'Load Citizen ' || n,
                '9' || lpad((n % 1000000000)::text, 9, '0'), true, false, u.created_on
         from generate_series($1::int + 1, $2::int) n cross join (select * from users where username = 'citizen1') u`,
        [haveCitizens, citizensWanted],
      );
    }
    await c.query(`drop table if exists load_citizens; create table load_citizens as select row_number() over (order by id) - 1 as k, id from users where username like 'load%@example.com'`);
    await c.query(`drop table if exists load_stations; create table load_stations as select row_number() over (order by id) - 1 as k, id, district_id from fire_stations`);

    // District officers (DFO, SFO) of every district, with the district's fire stations.
    await c.query(`
      insert into users (username, email, password_hash, password_algo, portal, display_name, mobile, active, must_change_password, created_on)
      select 'load.' || lower(r.code) || '.' || d.id, 'load.' || lower(r.code) || '.' || d.id || '@fire.example.gov.in', u.password_hash, u.password_algo, 'dept',
             r.code || ' - ' || d.name, '9000000' || lpad((r.id * 100 + d.id)::text, 3, '0'), true, false, u.created_on
        from districts d cross join dept_roles r cross join (select * from users where username = 'dfs.officer') u
       where r.code in ('DFO', 'SFO')
      on conflict do nothing`);
    await c.query(`
      insert into dept_profiles (user_id, role_id, district_id, all_stations)
      select u.id, r.id, d.id, false from users u join dept_roles r on u.username like 'load.' || lower(r.code) || '.%'
        join districts d on u.username = 'load.' || lower(r.code) || '.' || d.id
       where not exists (select 1 from dept_profiles p where p.user_id = u.id)`);
    await c.query(`
      insert into dept_user_stations (user_id, fire_station_id)
      select p.user_id, fs.id from dept_profiles p join users u on u.id = p.user_id and u.username like 'load.%'
        join fire_stations fs on fs.district_id = p.district_id
       where not exists (select 1 from dept_user_stations x where x.user_id = p.user_id)`);
    await c.query(`drop table if exists load_officers; create table load_officers as
      select p.user_id, p.role_id, p.district_id, u.display_name from dept_profiles p join users u on u.id = p.user_id where u.username like 'load.%'`);
    const stations = Number((await c.query(`select count(*)::int as n from load_stations`)).rows[0].n);

    // 4. Clone in batches.
    let next = Number((await c.query(`select coalesce(max(id), 0)::int as m from applications`)).rows[0].m);
    let made = 0;
    const total = wanted - have;
    const started = Date.now();
    while (made < total) {
      const n = Math.min(BATCH, total - made);
      await c.query('begin');
      await c.query(`
        create temp table app_map on commit drop as
        select g, $1::int + g as new_id, t.template_id, t.status_id,
          (case
             when t.status_id between 2 and 6 then current_date - (g % 60)
             when t.status_id = 1 then current_date - (g % 365)
             else current_date - ((g::bigint * 7919) % 1825)::int
           end) - coalesce(a.applied_date, a.last_modified::date) as delta,
          lc.id as owner, ls.id as fs, ls.district_id as district
        from generate_series(1, $2::int) g
        join load_tpl t on t.rn = ((g + $3::int) % $4::int) + 1
        join applications a on a.id = t.template_id
        join load_citizens lc on lc.k = (g + $3::int) % $5::int
        join load_stations ls on ls.k = ((g + $3::int)::bigint * 31 % $6::int)`,
        [next, n, made, templates, citizensWanted, stations],
      );
      await c.query(`create index on app_map (template_id)`);

      await copy(c, 'applications', {
        fk: 'id',
        map: 'app_map',
        from: 'template_id',
        to: 'new_id',
          set: {
          appl_number: `case when c.appl_number is null then null else to_char(c.applied_date + m.delta, 'YYYY') || lpad(m.new_id::text, 6, '0') end`,
          owner_user_id: 'm.owner',
          fire_station_id: 'm.fs',
          district_id: 'm.district',
          site_name: `c.site_name || ' ' || m.new_id`,
          parent_application_id: 'null',
          child_application_id: 'null',
          current_wf_instance_id: 'null',
          created_by: 'm.owner',
          updated_by: 'm.owner',
        },
      });
      for (const table of ['payments', 'application_feedback', 'process_log', 'sms_messages', 'application_parties', 'application_conditions', 'application_documents', 'dept_documents']) {
        await copy(c, table, { fk: 'application_id', map: 'app_map', from: 'template_id', to: 'new_id' });
      }
      await copy(c, 'document_requests', { fk: 'application_id', map: 'app_map', from: 'template_id', to: 'new_id', set: { wf_task_id: 'null', response_file_id: 'null' } });

      // Blocks (and their rows) keep their structure under new ids.
      await c.query(`
        create temp table block_map on commit drop as
        select nextval(pg_get_serial_sequence('blocks', 'id'))::int as new_id, b.id as template_id, m.new_id as app_id, m.delta
        from blocks b join app_map m on b.application_id = m.template_id`);
      await c.query(`create index on block_map (template_id)`);
      await copy(c, 'blocks', { fk: 'id', map: 'block_map', from: 'template_id', to: 'new_id', set: { application_id: 'm.app_id' } });
      for (const table of ['block_floors', 'block_ffe_items', 'block_sides', 'block_road_widening', 'block_ospaces', 'block_escapes', 'block_exits', 'block_doors', 'block_lifts', 'block_refuges', 'block_carparks']) {
        await copy(c, table, { fk: 'block_id', map: 'block_map', from: 'template_id', to: 'new_id' });
      }

      // Workflow runs: instances, tasks and events.
      await c.query(`
        create temp table inst_map on commit drop as
        select nextval(pg_get_serial_sequence('wf_instances', 'id'))::int as new_id, i.id as template_id, m.new_id as app_id, m.delta
        from wf_instances i join app_map m on i.subject_type = 'noc_application' and i.subject_id = m.template_id`);
      await c.query(`create index on inst_map (template_id)`);
      await copy(c, 'wf_instances', { fk: 'id', map: 'inst_map', from: 'template_id', to: 'new_id', set: { subject_id: 'm.app_id' } });
      await copy(c, 'wf_tasks', { fk: 'instance_id', map: 'inst_map', from: 'template_id', to: 'new_id', set: { supersedes_task_id: 'null' } });
      await copy(c, 'wf_events', { fk: 'instance_id', map: 'inst_map', from: 'template_id', to: 'new_id', set: { task_id: 'null' } });
      // District-level tasks belong to the officers of the file's district.
      await c.query(`
        update wf_tasks t set assignee_user_id = o.user_id, assignee_name = o.display_name
          from inst_map im join applications a on a.id = im.app_id join load_officers o on o.district_id = a.district_id
         where t.instance_id = im.new_id and o.role_id = t.role_id`);
      await c.query(`
        update applications a set current_wf_instance_id = im.new_id
        from inst_map im join applications t on t.current_wf_instance_id = im.template_id
        where a.id = im.app_id`);
      await c.query('commit');

      next += n;
      made += n;
      const rate = made / ((Date.now() - started) / 1000);
      say(`${have + made} / ${wanted} applications (${Math.round(rate)}/s)`);
    }

    // 5. Identity sequences past the explicit ids, statistics, caches.
    for (const table of ['applications', 'blocks', 'wf_instances']) {
      await c.query(`select setval(pg_get_serial_sequence('${table}', 'id'), (select max(id) from "${table}"))`);
    }
    await c.query(`drop table if exists load_tpl, load_citizens, load_stations, load_officers`);
    say('VACUUM (ANALYZE) …');
    // Fresh statistics, and the visibility map for index-only scans (as autovacuum would do later).
    await c.query('vacuum (analyze)');
    await c.query('update cache_versions set version = version + 1, updated_at = now()');
    const sizes = await c.query<{ relname: string; rows: string; size: string }>(`
      select relname, n_live_tup::text as rows, pg_size_pretty(pg_total_relation_size(relid)) as size
      from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 10`);
    say('Largest tables:');
    for (const r of sizes.rows) say(`  ${r.relname.padEnd(24)} ${r.rows.padStart(10)} rows  ${r.size}`);
    const db = await c.query<{ size: string }>(`select pg_size_pretty(pg_database_size(current_database())) as size`);
    ok(`"${target}" holds ${await count()} applications (${db.rows[0].size}). Try it: npm run perf:probe -- --db ${target}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`  \u2717 ${(e as Error).message}`);
  process.exit(1);
});
