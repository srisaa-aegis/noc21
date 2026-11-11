/** Helpers shared by the route modules. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, forbidden } from '../errors/app-error.js';
import { officerScope } from '../repositories/application.repo.js';
import type { IncomingFile } from '../services/document.service.js';
import type { ServiceContext } from '../services/shared.js';

/** The per-request service context (database, caches, rules engine, user). */
export function contextFactory(app: FastifyInstance) {
  return async (req: FastifyRequest): Promise<ServiceContext> => ({
    db: app.ctx.db,
    cache: app.ctx.cache,
    rules: app.ctx.rules,
    user: await app.currentUser(req),
    requestId: req.requestId,
    ip: req.ip,
  });
}

/** A plain field of a multipart request (sent before the file part). */
export function fieldValue(fields: Record<string, unknown>, name: string): string | undefined {
  const f = fields[name] as { value?: unknown } | { value?: unknown }[] | undefined;
  const one = Array.isArray(f) ? f[0] : f;
  return one && typeof one.value === 'string' ? one.value : undefined;
}

/** The single file of a multipart request, plus its preceding fields. */
export async function multipartFile(req: FastifyRequest): Promise<{ file: IncomingFile; fields: Record<string, unknown> }> {
  const part = await req.file();
  if (!part) throw badRequest('Attach a file.');
  return {
    file: { stream: part.file, filename: part.filename, truncated: () => part.file.truncated },
    fields: part.fields as Record<string, unknown>,
  };
}

/**
 * The fire stations whose files a user may see in reports and the ratings panel:
 * a district or station officer sees his stations; the Head Office officers (all
 * stations), the monitoring role and the administrator see every file (undefined).
 */
export async function reportJurisdiction(app: FastifyInstance, req: FastifyRequest): Promise<number[] | undefined> {
  if (!req.auth || req.auth.portal === 'admin') return undefined;
  const scope = await officerScope(app.ctx.db, req.auth.sub);
  if (!scope) throw forbidden('Your account is not configured as a department officer.');
  return scope.allStations || scope.monitoring ? undefined : scope.stationIds;
}
