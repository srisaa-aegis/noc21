/**
 * buildApp() — the Fastify instance, exported so tests can drive it with
 * `app.inject()` without binding a socket.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { config, type AppConfig } from './config/env.js';
import { corePlugin } from './plugins/core.js';
import { contextPlugin, type ContextOptions } from './plugins/context.js';
import { authPlugin } from './plugins/auth.js';
import { openApiPlugin } from './plugins/openapi.js';
import { authRoutes } from './routes/auth.routes.js';
import { referenceRoutes } from './routes/reference.routes.js';
import { applicationRoutes } from './routes/application.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { fileRoutes } from './routes/file.routes.js';
import { deptRoutes } from './routes/dept.routes.js';
import { configRoutes } from './routes/config.routes.js';
import { reportRoutes } from './routes/report.routes.js';
import { startOutboxDispatcher } from './jobs/outbox.js';
import { startScheduler } from './jobs/scheduler.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered (method + full URL) — the portal contract test reads it. */
    routeTable: { method: string; url: string }[];
  }
}

export interface BuildOptions extends ContextOptions {
  cfg?: AppConfig;
  logger?: boolean;
  /** Requests per minute and address; defaults to the configuration (relaxed under NODE_ENV=test). */
  limits?: { global: number; auth: number };
}

/** Migrations shipped with this build (drizzle journal) — compared with the applied ones by /ready. */
function shippedMigrations(repoRoot: string): number {
  try {
    const journal = JSON.parse(readFileSync(resolve(repoRoot, 'backend', 'src', 'db', 'migrations', 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
    return journal.entries.length;
  } catch {
    return 0;
  }
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const cfg = opts.cfg ?? config();
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash', '*.aadhar'],
            ...(cfg.isProduction ? {} : { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } } }),
          },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: cfg.TRUST_PROXY,
  });

  const routeTable: { method: string; url: string }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') routeTable.push({ method, url: r.url });
  });

  await app.register(corePlugin);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: cfg.corsOrigins, credentials: true, exposedHeaders: ['x-request-id', 'x-data-versions'] });
  // Tests drive hundreds of requests from one address; the limits themselves
  // are covered by tests/integration/rate-limit.spec.ts with small numbers.
  const limits = opts.limits ?? {
    global: cfg.isTest ? 10_000 : cfg.RATE_LIMIT_GLOBAL_PER_MINUTE,
    auth: cfg.isTest ? 10_000 : cfg.RATE_LIMIT_LOGIN_PER_MINUTE,
  };
  await app.register(rateLimit, { max: limits.global, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: cfg.UPLOAD_MAX_BYTES, files: 1, fields: 10, fieldSize: 10_000 },
  });
  await app.register(contextPlugin, opts);
  await app.register(authPlugin);
  if (cfg.ENABLE_DOCS ?? !cfg.isProduction) await app.register(openApiPlugin, { prefix: cfg.API_PREFIX });

  // ── Operational endpoints (outside the API prefix) ────────────────────────
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));
  const shipped = shippedMigrations(cfg.repoRoot);
  const appliedMigrations = async (): Promise<number> => {
    const r = await app.ctx.db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    return Number(r.rows[0]?.n ?? 0);
  };
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, boolean> = { database: false, migrations: false, cache: app.ctx.cache.isWarm(), storage: true };
    let migrations = { shipped, applied: 0 };
    try {
      await app.ctx.db.execute(sql`select 1`);
      checks.database = true;
      migrations = { shipped, applied: await appliedMigrations() };
      checks.migrations = migrations.applied >= shipped;
    } catch {
      /* reported by the checks */
    }
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ ready, checks, migrations, dataVersions: app.ctx.cache.versions() });
  });
  app.addHook('onReady', async () => {
    const applied = await appliedMigrations().catch(() => 0);
    if (applied < shipped) app.log.warn(`The database is missing ${shipped - applied} migration(s): run "npm run db:migrate".`);
  });
  app.get('/version', async () => ({
    name: 'noc-api',
    phase: 'B3',
    node: process.version,
    environment: cfg.NODE_ENV,
    dateFormat: cfg.API_DATE_FORMAT,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  }));

  // ── API ───────────────────────────────────────────────────────────────────
  await app.register(
    async (api) => {
      await api.register(authRoutes, { authLimit: limits.auth });
      await api.register(referenceRoutes);
      await api.register(applicationRoutes);
      await api.register(adminRoutes);
      await api.register(fileRoutes);
      await api.register(deptRoutes);
      await api.register(configRoutes);
      await api.register(reportRoutes);
    },
    { prefix: cfg.API_PREFIX },
  );

  // The outbox is delivered by the log driver (no SMS / e-mail gateway in this phase).
  if (!cfg.isTest) {
    const stop = startOutboxDispatcher(app.ctx.db, app.log);
    app.addHook('onClose', async () => stop());
    if (cfg.ENABLE_SCHEDULER) {
      const stopJobs = startScheduler(app.ctx.db, app.ctx.cache, app.log);
      app.addHook('onClose', async () => stopJobs());
    }
  }

  return app;
}
