/**
 * Entry point: build the app, listen, and shut down cleanly.
 *
 * With API_WORKERS > 1 the process forks that many workers (node:cluster) that
 * share the port; the primary only supervises them (restarts a worker that
 * dies). Every worker runs the whole API, including the outbox dispatcher and
 * the scheduler, which are safe to run several times (SKIP LOCKED / advisory lock).
 */
import cluster from 'node:cluster';
import { buildApp } from './app.js';
import { config } from './config/env.js';

const cfg = config();

if (cfg.API_WORKERS > 1 && cluster.isPrimary) {
  let stopping = false;
  console.log(`NOC API: starting ${cfg.API_WORKERS} worker processes on ${cfg.HOST}:${cfg.PORT}`);
  for (let i = 0; i < cfg.API_WORKERS; i++) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;
    console.error(`NOC API: worker ${worker.process.pid} exited (${signal ?? code}); starting a new one`);
    cluster.fork();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
      for (const w of Object.values(cluster.workers ?? {})) w?.kill(signal);
      setTimeout(() => process.exit(0), 5000).unref();
      cluster.on('exit', () => {
        if (!Object.keys(cluster.workers ?? {}).length) process.exit(0);
      });
    });
  }
} else {
  const app = await buildApp();

  try {
    await app.listen({ host: cfg.HOST, port: cfg.PORT });
    app.log.info(
      { url: `http://${cfg.HOST}:${cfg.PORT}${cfg.API_PREFIX}`, env: cfg.NODE_ENV, storage: cfg.FS_STORAGE_ROOT, worker: cluster.isWorker ? process.pid : undefined },
      'NOC API ready',
    );
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }

  const stop = (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(signal));
  // a worker whose supervisor is gone stops too
  if (cluster.isWorker) process.on('disconnect', () => stop('disconnect'));
}
