/**
 * npm run jobs:run -- <job|due|list>
 *
 * Runs a background job by hand (the API's scheduler runs them when
 * ENABLE_SCHEDULER=true). Every run is recorded in `job_runs`.
 *
 *   escalations      send the reminders that are due now (SLA escalations)
 *   purge-files      delete files unused for FILE_PURGE_AFTER_DAYS
 *   cleanup-tokens   delete expired refresh / reset / download tokens
 *   due              run whatever the scheduler would run now
 *   list             the jobs and their last runs
 */
import { sql } from 'drizzle-orm';
import { ReferenceCache } from '../../src/cache/reference-cache.js';
import { config } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';
import { jobs, runJob, tick } from '../../src/jobs/scheduler.js';

const cfg = config();
const what = process.argv[2] ?? 'list';
const log = {
  info: (o: unknown, m?: string) => console.log(`  \u2713 ${m ?? ''} ${JSON.stringify(o)}`),
  error: (o: unknown, m?: string) => console.error(`  \u2717 ${m ?? ''} ${JSON.stringify(o)}`),
  warn: (o: unknown, m?: string) => console.warn(`  ! ${m ?? ''} ${JSON.stringify(o)}`),
};

async function main(): Promise<number> {
  const { db, close } = createDb(cfg.databaseUrl, 4);
  const cache = new ReferenceCache({ db, connectionString: cfg.databaseUrl, pollIntervalMs: 3_600_000 });
  try {
    const all = jobs(db, cache);
    if (what === 'list') {
      const last = await db.execute<{ job_name: string; status: string; started_at: Date; detail: unknown }>(sql`
        select distinct on (job_name) job_name, status, started_at, detail from job_runs order by job_name, started_at desc`);
      for (const j of all) {
        const r = last.rows.find((x) => x.job_name === j.name);
        console.log(`  ${j.name.padEnd(15)} ${r ? `${r.status} at ${new Date(r.started_at).toISOString()} ${JSON.stringify(r.detail)}` : 'never run'}`);
      }
      console.log(`\n  Scheduler in the API: ${cfg.ENABLE_SCHEDULER ? 'on' : 'off'} (ENABLE_SCHEDULER); escalations daily at ${cfg.ESCALATION_HOUR}:00 ${cfg.APP_TIMEZONE}.`);
      return 0;
    }
    await cache.warm();
    if (what === 'due') {
      const ran = await tick(db, cache, log as never);
      console.log(ran.length ? `  Ran: ${ran.join(', ')}` : '  Nothing was due (or another process holds the scheduler lock).');
      return 0;
    }
    const job = all.find((j) => j.name === what);
    if (!job) {
      console.error(`  Unknown job "${what}". Jobs: ${all.map((j) => j.name).join(', ')}, due, list.`);
      return 1;
    }
    return (await runJob(db, job, log)).status === 'succeeded' ? 0 : 1;
  } finally {
    await cache.close();
    await close();
  }
}

main().then((code) => process.exit(code));
