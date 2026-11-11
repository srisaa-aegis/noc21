/**
 * The in-process job scheduler (phase B3). Enabled with ENABLE_SCHEDULER=true
 * on exactly one API process (a PostgreSQL advisory lock makes a second one
 * skip). Every run is recorded in `job_runs`.
 *
 *   escalations    daily at ESCALATION_HOUR (09:00 IST, every day — N-12)
 *   purge-files    daily at 02:00
 *   cleanup-tokens hourly
 *   purge-audit    daily at 03:00 (entries older than AUDIT_RETENTION_MONTHS)
 */
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { ReferenceCache } from '../cache/reference-cache.js';
import { config } from '../config/env.js';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { send as sendEscalations } from '../services/escalation.service.js';
import { cleanupTokens, purgeAudit, purgeFiles } from './maintenance.js';

export interface Job {
  name: string;
  /** Is the job due at `now`, given when it last ran? */
  due(now: Date, last: Date | null): boolean;
  run(now: Date): Promise<unknown>;
}

function localHour(now: Date): { hour: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: config().APP_TIMEZONE, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { hour: Number(get('hour')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

const daily = (hour: number) => (now: Date, last: Date | null) => {
  const n = localHour(now);
  if (n.hour < hour) return false;
  return !last || localHour(last).day !== n.day;
};

export function jobs(db: Database, cache: ReferenceCache): Job[] {
  return [
    { name: 'escalations', due: daily(config().ESCALATION_HOUR), run: (now) => sendEscalations(db, cache, 'scheduler', now) },
    { name: 'purge-files', due: daily(2), run: (now) => purgeFiles(db, now) },
    { name: 'cleanup-tokens', due: (now, last) => !last || now.getTime() - last.getTime() >= 3_600_000, run: (now) => cleanupTokens(db, now) },
    { name: 'purge-audit', due: daily(3), run: (now) => purgeAudit(db, now) },
  ];
}

/** A job's result for the log and `job_runs`: lists become their length (the escalation notices are stored on their own). */
function summarize(detail: unknown): unknown {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return detail;
  return Object.fromEntries(Object.entries(detail as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
}

/** Runs one job now and records it in `job_runs`. */
export async function runJob(
  db: Database,
  job: Job,
  log: Pick<FastifyBaseLogger, 'info' | 'error'>,
  now: Date = new Date(),
): Promise<{ status: 'succeeded' | 'failed'; detail: unknown }> {
  const [run] = await db.insert(s.jobRuns).values({ jobName: job.name, startedAt: now }).returning({ id: s.jobRuns.id });
  try {
    const detail = summarize(await job.run(now));
    await db.execute(sql`update job_runs set status = 'succeeded', finished_at = now(), detail = ${JSON.stringify(detail ?? {})}::jsonb where id = ${run.id}`);
    log.info({ job: job.name, detail }, 'job finished');
    return { status: 'succeeded', detail };
  } catch (e) {
    const detail = { error: (e as Error).message };
    await db.execute(sql`update job_runs set status = 'failed', finished_at = now(), detail = ${JSON.stringify(detail)}::jsonb where id = ${run.id}`);
    log.error({ job: job.name, err: (e as Error).message }, 'job failed');
    return { status: 'failed', detail };
  }
}

/**
 * Runs every job that is due, once. A transaction-scoped advisory lock (held
 * for the whole tick on one connection) keeps two API processes from running
 * the same job.
 */
export async function tick(db: Database, cache: ReferenceCache, log: FastifyBaseLogger, now: Date = new Date()): Promise<string[]> {
  return db.transaction(async (lockTx) => {
    const locked = await lockTx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(7700001) as ok`);
    if (!locked.rows[0]?.ok) return [];
    const ran: string[] = [];
    for (const job of jobs(db, cache)) {
      const last = await db.execute<{ started_at: Date }>(sql`select started_at from job_runs where job_name = ${job.name} and status = 'succeeded' order by started_at desc limit 1`);
      if (!job.due(now, last.rows[0]?.started_at ? new Date(last.rows[0].started_at) : null)) continue;
      if ((await runJob(db, job, log, now)).status === 'succeeded') ran.push(job.name);
    }
    return ran;
  });
}

export function startScheduler(db: Database, cache: ReferenceCache, log: FastifyBaseLogger, intervalMs = 60_000): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick(db, cache, log)
      .catch((e: Error) => log.warn({ err: e.message }, 'scheduler tick failed'))
      .finally(() => (busy = false));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
