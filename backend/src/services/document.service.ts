/**
 * Uploaded documents (plans, challans, undertakings, requested documents).
 *
 * The file is streamed straight to the storage provider — never buffered whole,
 * never written under the web root — while its first bytes are sniffed: the
 * type is decided by the content (PDF / JPEG / PNG magic numbers), not by the
 * name or the browser's claim. Metadata goes to `files`; the link to the
 * application goes to `application_documents` (replacing a document with the
 * same requirement code).
 */
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { and, eq, isNull, max, sql } from 'drizzle-orm';
import { requiredDocuments, type Application, type DocumentRequirements } from '@srisaa/noc-domain';
import type { ReferenceBundle } from '../cache/bundles.js';
import { config } from '../config/env.js';
import * as s from '../db/schema/index.js';
import { AppError, businessRule, forbidden, notFound } from '../errors/app-error.js';
import { businessDate } from '../lib/dates.js';
import { loadAggregate } from '../repositories/application.repo.js';
import { toApplication } from '../serializers/application.serializer.js';
import { createStorage, storageKeys, type StorageProvider } from '../storage/storage.js';
import { audit, type ServiceContext } from './shared.js';

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: '.png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];

export function sniff(head: Buffer): { mime: string; ext: string } | null {
  const hit = SIGNATURES.find((sig) => sig.test(head));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

const UNSUPPORTED = 'Only PDF documents are accepted.';

/**
 * Reads just enough of the stream to identify the content, then returns a
 * stream that replays those bytes followed by the rest — so the file is
 * written exactly once, to its final key (which is what an S3 driver needs).
 */
async function peek(stream: Readable, bytes = 8): Promise<{ head: Buffer; rest: Readable }> {
  const iterator = stream[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  let done = false;
  while (head.length < bytes) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    head = Buffer.concat([head, next.value as Buffer]);
  }
  async function* replay() {
    if (head.length) yield head;
    if (done) return;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value as Buffer;
    }
  }
  return { head, rest: Readable.from(replay()) };
}

/** Counts bytes and stops the upload as soon as it exceeds the limit. */
class SizeLimit extends Transform {
  bytes = 0;
  constructor(private readonly maxBytes: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      return cb(new AppError(413, 'payload-too-large', `The file is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB.`));
    }
    cb(null, chunk);
  }
}

export interface IncomingFile {
  stream: Readable;
  filename: string;
  /** Set by the multipart parser when its own size limit was hit. */
  truncated?: () => boolean;
}

export interface StoredFile {
  id: string;
  key: string;
  size: number;
  checksum: string;
  mime: string;
  originalName: string;
}

let storage: StorageProvider | undefined;
export function store(): StorageProvider {
  storage ??= createStorage(config().STORAGE_DRIVER, config().FS_STORAGE_ROOT);
  return storage;
}

/** Streams an upload into storage under a key chosen by `keyFor`. Cleans up on failure. */
export async function storeUpload(file: IncomingFile, keyFor: (ext: string) => string, allowed: string[]): Promise<StoredFile> {
  const cfg = config();
  const { head, rest } = await peek(file.stream);
  if (!head.length) throw businessRule('The file is empty.');
  const detected = sniff(head);
  if (!detected || !allowed.includes(detected.mime)) {
    rest.destroy();
    file.stream.resume();
    throw new AppError(415, 'unsupported-media-type', UNSUPPORTED);
  }
  const key = keyFor(detected.ext);
  const limit = new SizeLimit(cfg.UPLOAD_MAX_BYTES);
  rest.on('error', (e) => limit.destroy(e));
  let result;
  try {
    result = await store().put(key, rest.pipe(limit));
  } catch (e) {
    await store().delete(key).catch(() => undefined);
    throw e;
  }
  if (file.truncated?.()) {
    await store().delete(key);
    throw new AppError(413, 'payload-too-large', `The file is larger than ${Math.round(cfg.UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`);
  }
  return {
    id: randomUUID(),
    key,
    size: result.size,
    checksum: result.checksumSha256,
    mime: detected.mime,
    originalName: sanitiseName(file.filename, detected.ext),
  };
}

function sanitiseName(name: string, ext: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
  const base = (name || 'document').replace(/[\\/\u0000-\u001f"<>|:*?]+/g, '_').slice(0, 150).trim() || 'document';
  return base.toLowerCase().endsWith(ext) || (ext === '.jpg' && /\.jpe?g$/i.test(base)) ? base : `${base}${ext}`;
}

/** Records a stored upload in `files` (inside the caller's transaction). */
export async function insertFile(tx: Pick<ServiceContext['db'], 'insert'>, stored: StoredFile, userId: number): Promise<void> {
  await tx.insert(s.files).values({
    id: stored.id,
    storageBackend: 'fs',
    storageKey: stored.key,
    originalName: stored.originalName,
    mimeType: stored.mime,
    sizeBytes: stored.size,
    checksumSha256: stored.checksum,
    uploadedBy: userId,
  });
}

export async function discardStored(file: StoredFile): Promise<void> {
  await store().delete(file.key).catch(() => undefined);
}

async function usedBytes(tx: ServiceContext['db'], applicationId: number): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${s.files.sizeBytes}), 0)::text` })
    .from(s.applicationDocuments)
    .innerJoin(s.files, eq(s.files.id, s.applicationDocuments.fileId))
    .where(and(eq(s.applicationDocuments.applicationId, applicationId), isNull(s.applicationDocuments.deletedAt)));
  return Number(row?.total ?? 0);
}

/** Requirement codes this application may upload (mirrors the wizard's document list). */
function allowedCodes(app: Application, reference: ReferenceBundle): Map<string, { label: string; blockId?: number }> {
  const list = requiredDocuments(app, reference.documentRequirements as unknown as DocumentRequirements);
  return new Map(list.map((d) => [d.code, { label: d.blockName ? `${d.label} (${d.blockName})` : d.label, blockId: d.blockId }]));
}

export async function uploadApplicationDocument(
  c: ServiceContext,
  applicationId: number,
  code: string,
  file: IncomingFile,
): Promise<Application> {
  if (c.user.portal !== 'citizen') throw forbidden('Only the applicant can upload the application documents.');
  const rows = await loadAggregate(c.db, applicationId);
  if (!rows || rows.application.ownerUserId !== c.user.id) throw notFound('Application not found.');
  if (rows.application.statusId !== 1) throw businessRule('Documents can only be changed while the application is a draft.');
  const app = toApplication(rows);
  const codes = allowedCodes(app, c.cache.data<ReferenceBundle>('reference'));
  const requirement = codes.get(code);
  if (!requirement) throw businessRule(`"${code}" is not a document this application needs.`);

  const used = await usedBytes(c.db, applicationId);
  const blockMatch = /^(?:SitePlan|SectionPlan|ElevationPlan|FloorPlan):(\d+)/.exec(code);
  const stored = await storeUpload(
    file,
    (ext) => (blockMatch ? storageKeys.blockPlan(applicationId, Number(blockMatch[1]), ext) : storageKeys.applicationDocument(applicationId, ext)),
    ['application/pdf'],
  );
  if (used + stored.size > config().UPLOAD_MAX_PER_APPLICATION_BYTES) {
    await discardStored(stored);
    throw new AppError(413, 'payload-too-large', 'The documents of this application exceed the allowed total size.');
  }
  try {
    return await c.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(s.applications)
        .where(and(eq(s.applications.id, applicationId), isNull(s.applications.deletedAt)))
        .for('update');
      if (!locked || locked.statusId !== 1) throw businessRule('Documents can only be changed while the application is a draft.');
      await tx.insert(s.files).values({
        id: stored.id,
        storageBackend: 'fs',
        storageKey: stored.key,
        originalName: stored.originalName,
        mimeType: stored.mime,
        sizeBytes: stored.size,
        checksumSha256: stored.checksum,
        uploadedBy: c.user.id,
      });
      await tx
        .update(s.applicationDocuments)
        .set({ deletedAt: new Date() })
        .where(and(eq(s.applicationDocuments.applicationId, applicationId), eq(s.applicationDocuments.code, code), isNull(s.applicationDocuments.deletedAt)));
      const [n] = await tx.select({ n: max(s.applicationDocuments.docNo) }).from(s.applicationDocuments).where(eq(s.applicationDocuments.applicationId, applicationId));
      const floorMatch = /^FloorPlan:(\d+):(\d+)$/.exec(code);
      await tx.insert(s.applicationDocuments).values({
        applicationId,
        docNo: (n?.n ?? 0) + 1,
        code,
        fileId: stored.id,
        category: requirement.label,
        uploadedOn: businessDate(c.now ?? new Date()),
        uploadedBy: c.user.id,
        blockNo: blockMatch ? Number(blockMatch[1]) : null,
        floorNo: floorMatch ? Number(floorMatch[2]) : null,
      });
      await tx
        .update(s.applications)
        .set({ lastModified: c.now ?? new Date(), rowVersion: locked.rowVersion + 1 })
        .where(eq(s.applications.id, applicationId));
      await audit(tx, c, 'document.uploaded', 'application', applicationId, `${code} uploaded (${stored.originalName}, ${stored.size} bytes)`);
      const after = await loadAggregate(tx as never, applicationId);
      return toApplication(after!, { hideInternalNotes: true });
    });
  } catch (e) {
    await discardStored(stored);
    throw e;
  }
}

export async function removeApplicationDocument(c: ServiceContext, applicationId: number, docNo: number): Promise<Application> {
  return c.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(s.applications)
      .where(and(eq(s.applications.id, applicationId), eq(s.applications.ownerUserId, c.user.id), isNull(s.applications.deletedAt)))
      .for('update');
    if (!locked) throw notFound('Application not found.');
    if (locked.statusId !== 1) throw businessRule('Documents can only be changed while the application is a draft.');
    const removed = await tx
      .update(s.applicationDocuments)
      .set({ deletedAt: new Date() })
      .where(and(eq(s.applicationDocuments.applicationId, applicationId), eq(s.applicationDocuments.docNo, docNo), isNull(s.applicationDocuments.deletedAt)))
      .returning({ code: s.applicationDocuments.code });
    if (!removed.length) throw notFound('Document not found.');
    await tx.update(s.applications).set({ lastModified: c.now ?? new Date(), rowVersion: locked.rowVersion + 1 }).where(eq(s.applications.id, applicationId));
    await audit(tx, c, 'document.removed', 'application', applicationId, `${removed[0].code} removed`);
    const after = await loadAggregate(tx as never, applicationId);
    return toApplication(after!, { hideInternalNotes: true });
  });
}

/** The applicant's answer to a document the department asked for. */
export async function respondToDocumentRequest(
  c: ServiceContext,
  applicationId: number,
  requestNo: number,
  comment: string,
  file: IncomingFile,
): Promise<Application> {
  if (c.user.portal !== 'citizen') throw forbidden('Only the applicant can answer a document request.');
  const [request] = await c.db
    .select({ request: s.documentRequests, owner: s.applications.ownerUserId })
    .from(s.documentRequests)
    .innerJoin(s.applications, eq(s.applications.id, s.documentRequests.applicationId))
    .where(and(eq(s.documentRequests.applicationId, applicationId), eq(s.documentRequests.requestNo, requestNo)))
    .limit(1);
  if (!request || request.owner !== c.user.id) throw notFound('Application not found.');
  if (request.request.status !== 'R') throw businessRule('This document request is no longer open.');
  const stored = await storeUpload(file, (ext) => storageKeys.requestedDocument(applicationId, ext), ['application/pdf']);
  try {
    return await c.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(s.applications).where(eq(s.applications.id, applicationId)).for('update');
      const [current] = await tx
        .select()
        .from(s.documentRequests)
        .where(and(eq(s.documentRequests.applicationId, applicationId), eq(s.documentRequests.requestNo, requestNo)))
        .for('update');
      if (current.status !== 'R') throw businessRule('This document request is no longer open.');
      await tx.insert(s.files).values({
        id: stored.id,
        storageKey: stored.key,
        originalName: stored.originalName,
        mimeType: stored.mime,
        sizeBytes: stored.size,
        checksumSha256: stored.checksum,
        uploadedBy: c.user.id,
      });
      const today = businessDate(c.now ?? new Date());
      await tx
        .update(s.documentRequests)
        .set({ status: 'U', citizenComment: comment.trim(), respondedOn: today, responseFileId: stored.id })
        .where(eq(s.documentRequests.id, current.id));
      const code = `Requested:${current.fileName}`;
      await tx
        .update(s.applicationDocuments)
        .set({ deletedAt: new Date() })
        .where(and(eq(s.applicationDocuments.applicationId, applicationId), eq(s.applicationDocuments.code, code), isNull(s.applicationDocuments.deletedAt)));
      const [n] = await tx.select({ n: max(s.applicationDocuments.docNo) }).from(s.applicationDocuments).where(eq(s.applicationDocuments.applicationId, applicationId));
      await tx.insert(s.applicationDocuments).values({
        applicationId,
        docNo: (n?.n ?? 0) + 1,
        code,
        fileId: stored.id,
        category: current.fileDesc,
        uploadedOn: today,
        uploadedBy: c.user.id,
      });
      const [step] = await tx.select({ n: max(s.processLog.stepNo) }).from(s.processLog).where(eq(s.processLog.applicationId, applicationId));
      await tx.insert(s.processLog).values({
        applicationId,
        stepNo: (step?.n ?? 0) + 1,
        actorUserId: c.user.id,
        reviewerName: locked.buildName || c.user.displayName,
        role: 'Applicant',
        statusId: locked.statusId,
        action: 'Requested document uploaded',
        remarks: `${current.fileDesc}${comment.trim() ? ` — ${comment.trim()}` : ''}`,
        atDate: today,
      });
      await tx.update(s.applications).set({ lastModified: c.now ?? new Date(), rowVersion: locked.rowVersion + 1 }).where(eq(s.applications.id, applicationId));
      await audit(tx, c, 'document.request_answered', 'application', applicationId, `Request ${requestNo} answered`);
      const after = await loadAggregate(tx as never, applicationId);
      return toApplication(after!, { hideInternalNotes: true });
    });
  } catch (e) {
    await discardStored(stored);
    throw e;
  }
}
