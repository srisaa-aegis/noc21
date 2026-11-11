/**
 * Storage contract suite.
 *
 * It is written against the `StorageProvider` port, not the filesystem driver,
 * so the S3 driver added later must pass exactly these tests (that is the whole
 * point of keeping the design S3-compliant while building only `fs` now).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesystemStorage, storageKeys, type StorageProvider } from '../../src/storage/storage.js';

function bytes(size: number): Buffer {
  return Buffer.alloc(size, 'a');
}

describe('StorageProvider contract (filesystem driver)', () => {
  let root: string;
  let storage: StorageProvider;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'noc-storage-'));
    storage = new FilesystemStorage(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores and reads an object, reporting its size and checksum', async () => {
    const payload = Buffer.from('%PDF-1.4 hello');
    const key = storageKeys.applicationDocument(101, '.pdf');
    const result = await storage.put(key, Readable.from(payload));
    expect(result.size).toBe(payload.length);
    expect(result.checksumSha256).toBe(createHash('sha256').update(payload).digest('hex'));

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.getStream(key)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe(payload.toString());
  });

  it('reports existence with head() and deletes', async () => {
    const key = storageKeys.deptDocument(7, '.jpg');
    expect((await storage.head(key)).exists).toBe(false);
    await storage.put(key, Readable.from(bytes(10)));
    expect(await storage.head(key)).toEqual({ exists: true, size: 10 });
    await storage.delete(key);
    expect((await storage.head(key)).exists).toBe(false);
    await storage.delete(key); // deleting twice is not an error
  });

  it('never exposes a partial object (atomic rename)', async () => {
    const key = storageKeys.applicationDocument(1, '.pdf');
    await storage.put(key, Readable.from(bytes(1024)));
    const full = resolve(root, key);
    expect((await stat(full)).size).toBe(1024);
    const partials = await storage.head(`${key}.part`);
    expect(partials.exists).toBe(false);
  });

  it('streams a 5 MB object without buffering it whole', async () => {
    const key = storageKeys.applicationDocument(2, '.pdf');
    const size = 5 * 1024 * 1024;
    const before = process.memoryUsage().heapUsed;
    await storage.put(
      key,
      Readable.from(
        (function* () {
          for (let i = 0; i < size / 65536; i++) yield bytes(65536);
        })(),
      ),
    );
    expect((await storage.head(key)).size).toBe(size);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(size);
  });

  it('refuses keys that try to escape the root', async () => {
    await expect(storage.put('../../etc/passwd', Readable.from(bytes(1)))).rejects.toThrow(/Invalid storage key|ENOENT/);
  });

  it('keeps user-supplied names out of the keys', () => {
    const key = storageKeys.applicationDocument(123456, '.pdf');
    expect(key).toMatch(/^applications\/000123\/123456\/documents\/[0-9a-f-]{36}\.pdf$/);
    expect(storageKeys.blockPlan(5, 2, '.pdf')).toMatch(/^applications\/000000\/5\/blocks\/2\/plans\//);
    expect(storageKeys.decisionDocument(9)).toContain('/decision/');
  });

  it('always asks for a download plan rather than a path (S3-ready)', async () => {
    const key = storageKeys.applicationDocument(3, '.pdf');
    await storage.put(key, Readable.from(bytes(4)));
    const plan = await storage.createDownload(key, { fileName: 'a.pdf', contentType: 'application/pdf', ttlSeconds: 60 });
    expect(plan.kind).toBe('stream');
    if (plan.kind === 'stream') plan.stream.destroy();
  });

  it('shards keys so one directory never holds 100 000 applications', () => {
    expect(storageKeys.shard(1)).toBe('000000');
    expect(storageKeys.shard(100_000)).toBe('000100');
    expect(new Set([1, 999, 1000, 1001].map(storageKeys.shard)).size).toBe(2);
  });

  it('requires an absolute root', () => {
    expect(() => new FilesystemStorage(`relative-${randomUUID()}`)).toThrow(/absolute/);
  });
});
