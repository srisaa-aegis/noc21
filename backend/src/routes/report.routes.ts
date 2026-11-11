/** /dept/reports/:id — the ten department reports, JSON or CSV (phase B3). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reportJurisdiction } from './helpers.js';
import { REPORT_IDS, reportCsv, runReport } from '../services/report.service.js';

const query = z.object({
  level: z.enum(['', 'MSB', 'RFO', 'DFO']).optional(),
  type: z.enum(['', 'P', 'O', 'R', 'D']).optional(),
  region: z.string().optional(),
  status: z.coerce.number().int().optional(),
  /** '*' or absent = every portal; '' = the Fire portal; 'SDP' / 'MAUD'. */
  host: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(5000).optional(),
  format: z.enum(['json', 'csv']).optional(),
  /** Bypass the 60-second memo (N-16). */
  fresh: z.enum(['true', 'false']).optional(),
});

/**
 * N-16: a report is computed at most once a minute per report + filter (they
 * aggregate every application; at 300 000 that is 0.3–0.5 s each). `?fresh=true`
 * recomputes. The memo is per API process and bounded.
 */
const MEMO_MS = 60_000;
const MEMO_MAX = 200;
const memo = new Map<string, { at: number; value: unknown }>();

async function memoised(key: string, fresh: boolean, compute: () => Promise<unknown>): Promise<{ value: unknown; at: number }> {
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit;
  const entry = { at: Date.now(), value: await compute() };
  memo.delete(key);
  memo.set(key, entry);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  return entry;
}

/** Empties the memo (tests, and after a demo reset in the same process). */
export function clearReportMemo(): void {
  memo.clear();
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: app.requirePortal('dept', 'admin') };

  app.get('/dept/reports', staff, async () => ({ items: REPORT_IDS }));

  // Reports are jurisdictional (a district or station officer sees the files of his fire stations).
  app.get('/dept/reports/:id', staff, async (req, reply) => {
    const { id } = z.object({ id: z.enum(REPORT_IDS) }).parse(req.params);
    const q = query.parse(req.query);
    const filter = {
      ...q,
      host: q.host === undefined || q.host === '*' ? undefined : q.host,
      from: q.from || undefined,
      to: q.to || undefined,
      stationIds: await reportJurisdiction(app, req),
    };
    void reply.header('cache-control', 'private, no-store');
    if (q.format === 'csv') {
      const csv = await reportCsv(app.ctx.db, app.ctx.cache, id, filter);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="noc-${id}-report.csv"`)
        .send(`\ufeff${csv}`);
    }
    const { fresh: _fresh, format: _format, ...rest } = q;
    const key = `${id}:${JSON.stringify(Object.entries({ ...rest, host: filter.host, stations: filter.stationIds ?? 'all' }).sort())}`;
    const { value, at } = await memoised(key, q.fresh === 'true', () => runReport(app.ctx.db, app.ctx.cache, id, filter));
    void reply.header('x-report-computed-at', new Date(at).toISOString());
    return value;
  });
}
