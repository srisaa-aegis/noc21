/**
 * In-process cache of the five reference bundles.
 *
 * - warm at boot, so /ready only reports ready once every bundle is loaded;
 * - invalidated by PostgreSQL NOTIFY 'noc_cache' (fired by statement-level
 *   triggers on every source table, whatever wrote them — API, seed, psql);
 * - a slow poll of cache_versions is the safety net if a notification is lost;
 * - holds the serialised JSON and pre-compressed buffers, so serving a bundle
 *   costs no database query and no re-serialisation;
 * - the rules engine and the workflow configuration read from here, so a
 *   calculation never hits the database for its rules.
 */
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Database } from '../db/client.js';
import { cacheVersions } from '../db/schema/index.js';
import { BUNDLE_BUILDERS, BUNDLE_NAMES, type BundleName } from './bundles.js';

export interface CachedBundle<T = unknown> {
  name: BundleName;
  version: number;
  etag: string;
  data: T;
  json: Buffer;
  gzip: Buffer;
  brotli: Buffer;
  builtAt: Date;
}

export interface ReferenceCacheOptions {
  db: Database;
  connectionString: string;
  pollIntervalMs: number;
  logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export class ReferenceCache {
  private readonly bundles = new Map<BundleName, CachedBundle>();
  private readonly inFlight = new Map<BundleName, Promise<CachedBundle>>();
  private listener?: pg.Client;
  private poll?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly opts: ReferenceCacheOptions) {}

  private log = {
    info: (o: unknown, m?: string) => this.opts.logger?.info(o, m),
    warn: (o: unknown, m?: string) => this.opts.logger?.warn(o, m),
    error: (o: unknown, m?: string) => this.opts.logger?.error(o, m),
  };

  /** Current versions straight from the database. */
  async dbVersions(): Promise<Record<string, number>> {
    const rows = await this.opts.db.select().from(cacheVersions);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.bundle] = Number(r.version);
    return out;
  }

  async warm(): Promise<void> {
    const versions = await this.dbVersions();
    await Promise.all(BUNDLE_NAMES.map((n) => this.rebuild(n, versions[n] ?? 1)));
    await this.startListening();
    this.poll = setInterval(() => void this.checkVersions(), this.opts.pollIntervalMs);
    this.poll.unref?.();
  }

  isWarm(): boolean {
    return BUNDLE_NAMES.every((n) => this.bundles.has(n));
  }

  get(name: BundleName): CachedBundle {
    const b = this.bundles.get(name);
    if (!b) throw new Error(`Bundle "${name}" is not loaded.`);
    return b;
  }

  data<T>(name: BundleName): T {
    return this.get(name).data as T;
  }

  versions(): Record<BundleName, number> {
    const out = {} as Record<BundleName, number>;
    for (const n of BUNDLE_NAMES) out[n] = this.bundles.get(n)?.version ?? 0;
    return out;
  }

  /** `reference=12;rules=5;…` — sent on every API response. */
  versionHeader(): string {
    return Object.entries(this.versions())
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
  }

  async rebuild(name: BundleName, version: number): Promise<CachedBundle> {
    const running = this.inFlight.get(name);
    if (running) return running;
    const task = (async () => {
      const data = await BUNDLE_BUILDERS[name](this.opts.db);
      const json = Buffer.from(JSON.stringify(data));
      const hash = createHash('sha256').update(json).digest('hex').slice(0, 8);
      const bundle: CachedBundle = {
        name,
        version,
        etag: `"${name}-v${version}-${hash}"`,
        data,
        json,
        gzip: gzipSync(json, { level: 6 }),
        brotli: brotliCompressSync(json),
        builtAt: new Date(),
      };
      this.bundles.set(name, bundle);
      this.log.info({ bundle: name, version, bytes: json.length, brotli: bundle.brotli.length }, 'cache bundle built');
      return bundle;
    })().finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, task);
    return task;
  }

  /** Re-reads cache_versions and rebuilds anything that moved. */
  async checkVersions(): Promise<void> {
    if (this.closed) return;
    try {
      const versions = await this.dbVersions();
      for (const name of BUNDLE_NAMES) {
        const current = this.bundles.get(name);
        const v = versions[name] ?? 1;
        if (!current || current.version !== v) await this.rebuild(name, v);
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'cache version check failed');
    }
  }

  private async startListening(): Promise<void> {
    const client = new pg.Client({ connectionString: this.opts.connectionString, application_name: 'noc-api-cache' });
    client.on('error', (e) => {
      this.log.warn({ err: e.message }, 'cache listener error; will reconnect');
      setTimeout(() => void this.reconnect(), 2000).unref?.();
    });
    client.on('notification', (msg) => {
      const [name, version] = (msg.payload ?? '').split(':');
      if (!BUNDLE_NAMES.includes(name as BundleName)) return;
      void this.rebuild(name as BundleName, Number(version) || (this.bundles.get(name as BundleName)?.version ?? 0) + 1);
    });
    await client.connect();
    await client.query('LISTEN noc_cache');
    this.listener = client;
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    try {
      await this.listener?.end().catch(() => undefined);
      await this.startListening();
      await this.checkVersions();
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'cache listener reconnect failed');
      setTimeout(() => void this.reconnect(), 5000).unref?.();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    await this.listener?.end().catch(() => undefined);
  }
}
