import { DestroyRef, Injectable, PendingTasks, effect, inject, signal } from '@angular/core';
import { Observable, firstValueFrom, of } from 'rxjs';
import { SessionStore } from '../auth/session.store';
import { BUNDLE_NAMES, BundleName, DataVersionBus } from './data-version.bus';
import { HttpBackend } from './http-backend.service';

function pick<T>(data: unknown, key: string): T {
  let current: unknown = data;
  for (const part of key.split('.')) {
    if (current === null || current === undefined) return undefined as T;
    current = (current as Record<string, unknown>)[part];
  }
  return current as T;
}

/** Bundle format version; a mismatch discards anything persisted by an older build. */
const SCHEMA = 1;
const DB_NAME = 'noc-cache';
const STORE = 'bundles';
const CHANNEL = 'noc-cache';

interface CachedEntry<T = unknown> {
  bundle: BundleName;
  version: number;
  schema: number;
  data: T;
}

/**
 * Browser-side cache of the reference bundles (docs/backend/55-caching.md §55.7).
 *
 * - a returning user renders from IndexedDB with **zero** network calls;
 * - `X-Data-Versions` on any API response tells us when a bundle moved;
 * - a BroadcastChannel shares a refresh with the other tabs;
 * - the private bundles (workflow, directory) are dropped on logout.
 */
@Injectable({ providedIn: 'root' })
export class ReferenceDataStore {
  private readonly backend = inject(HttpBackend);
  private readonly bus = inject(DataVersionBus);
  private readonly session = inject(SessionStore);
  /** Keeps the application "unstable" while a bundle is being read (tests, SSR, whenStable). */
  private readonly pendingTasks = inject(PendingTasks);

  private readonly bundles = signal<Partial<Record<BundleName, CachedEntry>>>({});
  readonly ready = signal(false);
  private channel: BroadcastChannel | null = null;
  private loading = new Map<BundleName, Promise<void>>();
  /** Started in the constructor so nothing can fetch before the cache is read. */
  private readonly hydration: Promise<void>;

  constructor() {
    this.hydration = this.hydrateFromIndexedDb();
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e: MessageEvent<{ bundle: BundleName; version: number }>) => {
        const entry = this.bundles()[e.data.bundle];
        if (!entry || entry.version !== e.data.version) this.load(e.data.bundle, e.data.version).catch(() => undefined);
      };
      inject(DestroyRef).onDestroy(() => {
        this.channel?.close();
        this.channel = null;
      });
    }
    // Refetch whatever the server says has changed.
    effect(() => {
      const versions = this.bus.serverVersions();
      for (const name of this.relevantBundles()) {
        const want = versions[name];
        const have = this.bundles()[name]?.version;
        if (want !== undefined && have !== want) this.load(name, want).catch(() => undefined);
      }
    });
  }

  /** Bundles this user needs: citizens never load the staff configuration. */
  private relevantBundles(): BundleName[] {
    const portal = this.session.session()?.portal;
    if (portal === 'dept' || portal === 'admin') return BUNDLE_NAMES;
    return ['reference', 'rules', 'content'];
  }

  /** Called once at application start. */
  async init(): Promise<void> {
    await this.hydration;
    try {
      const versions = await firstValueFrom(this.backend.getPath<Record<string, number>>('/meta/versions'));
      this.bus.merge(versions);
      await Promise.all(
        this.relevantBundles()
          .filter((b) => this.bundles()[b]?.version !== versions[b])
          .map((b) => this.load(b, versions[b])),
      );
    } catch {
      /* offline: whatever came out of IndexedDB is used */
    }
    this.ready.set(true);
  }

  data<T>(bundle: BundleName): T | undefined {
    return this.bundles()[bundle]?.data as T | undefined;
  }

  /** Value of one (possibly dotted) key inside a bundle, fetching it if necessary. */
  async value<T>(bundle: BundleName, key: string): Promise<T> {
    if (!this.bundles()[bundle]) await this.load(bundle, this.bus.serverVersions()[bundle]);
    return pick<T>(this.bundles()[bundle]?.data, key);
  }

  observable<T>(bundle: BundleName, key: string): Observable<T> {
    const data = this.bundles()[bundle]?.data;
    if (data !== undefined && pick(data, key) !== undefined) return of(pick<T>(data, key));
    return new Observable<T>((subscriber) => {
      const done = this.pendingTasks.add();
      this.value<T>(bundle, key)
        .then((v) => {
          subscriber.next(v);
          subscriber.complete();
        })
        .catch((e) => subscriber.error(e))
        .finally(done);
    });
  }

  async load(bundle: BundleName, version?: number): Promise<void> {
    // Single flight: concurrent readers of the same bundle share one download.
    const running = this.loading.get(bundle);
    if (running) return running;
    const task = (async () => {
      // Anything persisted by an earlier visit wins: a full page load must not
      // refetch a bundle whose version has not moved.
      await this.hydration;
      const cachedEntry = this.bundles()[bundle];
      if (cachedEntry && version !== undefined && cachedEntry.version === version) return;
      const path = version ? `/bundles/${bundle}/v/${version}` : `/bundles/${bundle}`;
      const data = await firstValueFrom(this.backend.getPath<unknown>(path));
      const resolved = version ?? (this.bus.serverVersions()[bundle] ?? 0);
      const entry: CachedEntry = { bundle, version: resolved, schema: SCHEMA, data };
      this.bundles.set({ ...this.bundles(), [bundle]: entry });
      await this.persist(entry);
      this.channel?.postMessage({ bundle, version: resolved });
    })().finally(() => this.loading.delete(bundle));
    this.loading.set(bundle, task);
    return task;
  }

  /** Drops the staff bundles when a user signs out. */
  async clearPrivate(): Promise<void> {
    const next = { ...this.bundles() };
    delete next.workflow;
    delete next.directory;
    this.bundles.set(next);
    await this.removePersisted(['workflow', 'directory']);
  }

  // ── IndexedDB (small wrapper; no dependency) ──────────────────────────────
  private openDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'bundle' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  private async hydrateFromIndexedDb(): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const next: Partial<Record<BundleName, CachedEntry>> = {};
        for (const entry of (req.result ?? []) as CachedEntry[]) {
          if (entry.schema === SCHEMA) next[entry.bundle] = entry;
        }
        this.bundles.set({ ...this.bundles(), ...next });
        resolve();
      };
      req.onerror = () => resolve();
    });
    db.close();
  }

  private async persist(entry: CachedEntry): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  }

  private async removePersisted(names: BundleName[]): Promise<void> {
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      for (const n of names) tx.objectStore(STORE).delete(n);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  }
}
