/**
 * Application context: database, reference cache and the rules engine, exposed
 * on the Fastify instance so routes and services share one of each.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config, type AppConfig } from '../config/env.js';
import { ReferenceCache } from '../cache/reference-cache.js';
import { RulesEngineProvider } from '../engines/rules.js';
import { createDb, type DbHandle } from '../db/client.js';

export interface AppContext {
  config: AppConfig;
  db: DbHandle['db'];
  dbHandle: DbHandle;
  cache: ReferenceCache;
  rules: RulesEngineProvider;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface ContextOptions {
  databaseUrl?: string;
  /** Reuse an existing handle (tests). */
  dbHandle?: DbHandle;
}

export const contextPlugin = fp<ContextOptions>(async (app: FastifyInstance, opts: ContextOptions) => {
  const cfg = config();
  const dbHandle = opts.dbHandle ?? createDb(opts.databaseUrl ?? cfg.databaseUrl);
  const cache = new ReferenceCache({
    db: dbHandle.db,
    connectionString: opts.databaseUrl ?? cfg.databaseUrl,
    pollIntervalMs: cfg.CACHE_POLL_INTERVAL_MS,
    logger: app.log,
  });
  await cache.warm();

  app.decorate('ctx', {
    config: cfg,
    db: dbHandle.db,
    dbHandle,
    cache,
    rules: new RulesEngineProvider(cache),
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('x-data-versions')) void reply.header('x-data-versions', cache.versionHeader());
    return payload;
  });

  app.addHook('onClose', async () => {
    await cache.close();
    if (!opts.dbHandle) await dbHandle.close();
  });
});
