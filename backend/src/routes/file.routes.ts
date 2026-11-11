/**
 * /files — authorised downloads.
 *
 * A PDF must open in a new tab, where a bearer token cannot be sent, so the
 * client asks for a one-time, short-lived download token and uses the returned
 * URL. That indirection is also exactly what an S3 driver needs later: the
 * same route would answer 302 to a presigned URL instead of streaming.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import * as s from '../db/schema/index.js';
import { forbidden, notFound } from '../errors/app-error.js';
import { createStorage } from '../storage/storage.js';
import { assertCanRead, getApplication } from '../services/application.service.js';

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const storage = createStorage(app.ctx.config.STORAGE_DRIVER, app.ctx.config.FS_STORAGE_ROOT);

  /** The application a file belongs to, for the access check. */
  async function applicationOf(fileId: string): Promise<number | null> {
    const [doc] = await app.ctx.db
      .select({ applicationId: s.applicationDocuments.applicationId })
      .from(s.applicationDocuments)
      .where(and(eq(s.applicationDocuments.fileId, fileId), isNull(s.applicationDocuments.deletedAt)))
      .limit(1);
    if (doc) return doc.applicationId;
    const [dept] = await app.ctx.db
      .select({ applicationId: s.deptDocuments.applicationId })
      .from(s.deptDocuments)
      .where(eq(s.deptDocuments.fileId, fileId))
      .limit(1);
    if (dept) return dept.applicationId;
    const [request] = await app.ctx.db
      .select({ applicationId: s.documentRequests.applicationId })
      .from(s.documentRequests)
      .where(eq(s.documentRequests.responseFileId, fileId))
      .limit(1);
    return request?.applicationId ?? null;
  }

  app.get('/files/:id/metadata', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const file = await requireAccess(id, req);
    return {
      id: file.id,
      original_name: file.originalName,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      checksum_sha256: file.checksumSha256,
      created_at: file.createdAt,
    };
  });

  app.post('/files/:id/download-token', { preHandler: app.requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireAccess(id, req);
    const raw = randomBytes(24).toString('base64url');
    const ttl = app.ctx.config.DOWNLOAD_LINK_TTL_SECONDS;
    await app.ctx.db.insert(s.downloadTokens).values({
      tokenHash: hash(raw),
      fileId: id,
      userId: req.auth!.sub,
      expiresAt: new Date(Date.now() + ttl * 1000),
    });
    return { url: `${app.ctx.config.API_PREFIX}/files/download/${raw}`, expiresIn: ttl };
  });

  app.get('/files/download/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.params);
    const [row] = await app.ctx.db
      .select({ token: s.downloadTokens, file: s.files })
      .from(s.downloadTokens)
      .innerJoin(s.files, eq(s.files.id, s.downloadTokens.fileId))
      .where(eq(s.downloadTokens.tokenHash, hash(token)))
      .limit(1);
    if (!row || row.token.usedAt || row.token.expiresAt < new Date()) throw notFound('This download link has expired.');
    await app.ctx.db.update(s.downloadTokens).set({ usedAt: new Date() }).where(eq(s.downloadTokens.id, row.token.id));
    if (row.file.scanStatus === 'infected') throw forbidden('This file failed the virus scan and cannot be downloaded.');

    const plan = await storage.createDownload(row.file.storageKey, {
      fileName: row.file.originalName,
      contentType: row.file.mimeType,
      ttlSeconds: app.ctx.config.DOWNLOAD_LINK_TTL_SECONDS,
    });
    if (plan.kind === 'redirect') return reply.redirect(plan.url, 302);
    void reply.header('content-type', row.file.mimeType);
    void reply.header('content-disposition', `attachment; filename="${row.file.originalName.replace(/"/g, '')}"`);
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('cache-control', 'private, no-store');
    return reply.send(plan.stream);
  });

  /**
   * The caller may reach a file only through an application they may read:
   * the owner, an officer of its jurisdiction / workflow, or an administrator.
   * A file attached to nothing is visible to administrators only.
   */
  async function requireAccess(fileId: string, req: FastifyRequest): Promise<typeof s.files.$inferSelect> {
    const [file] = await app.ctx.db
      .select()
      .from(s.files)
      .where(and(eq(s.files.id, fileId), isNull(s.files.deletedAt)))
      .limit(1);
    if (!file) throw notFound('File not found.');
    const user = await app.currentUser(req);
    const applicationId = await applicationOf(fileId);
    if (applicationId === null) {
      if (user.portal !== 'admin') throw notFound('File not found.');
      return file;
    }
    const application = await getApplication(app.ctx.db, user, applicationId).catch(() => null);
    if (!application) throw notFound('File not found.');
    await assertCanRead(app.ctx.db, user, application);
    return file;
  }
}
