/**
 * /applications — reads (phase B1) and the citizen lifecycle (phase B2).
 *
 * The citizen lifecycle (phase B2): create, save, delete, carry forward, pay,
 * submit, revise, rate, and the document uploads.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { certificateValidity, renewalPeriodYears, toSummary } from '@srisaa/noc-domain';
import * as s from '../db/schema/index.js';
import { badRequest } from '../errors/app-error.js';
import { toDateColumn } from '../lib/dates.js';
import {
  assessPayload,
  assessStored,
  carryForward,
  createApplication,
  deleteDraft,
  feePosition,
  pay,
  revise,
  saveApplication,
  saveFeedback,
  submit,
  type ServiceContext,
} from '../services/citizen.service.js';
import { removeApplicationDocument, respondToDocumentRequest, uploadApplicationDocument } from '../services/document.service.js';

/** A plain field of a multipart request (sent before the file part). */
function fieldValue(fields: Record<string, unknown>, name: string): string | undefined {
  const f = fields[name] as { value?: unknown } | { value?: unknown }[] | undefined;
  const one = Array.isArray(f) ? f[0] : f;
  return one && typeof one.value === 'string' ? one.value : undefined;
}
import { getApplication, listApplications } from '../services/application.service.js';

const listQuery = z.object({
  scope: z.enum(['mine', 'dept', 'all']).default('mine'),
  type: z.string().optional(),
  statusId: z.coerce.number().int().optional(),
  level: z.enum(['MSB', 'RFO', 'DFO']).optional(),
  districtId: z.coerce.number().int().optional(),
  text: z.string().optional(),
  q: z.string().optional(),
  draftsOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  idleDays: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.union([z.coerce.number().int().min(1).max(200), z.literal('all')]).default(25),
  sort: z.string().optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function applicationRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.requireAuth };
  /** The lifecycle writes are the applicant's own (the department acts through /dept, the administrator through /admin). */
  const citizen = { preHandler: app.requirePortal('citizen') };

  app.get('/applications', auth, async (req, reply) => {
    const q = listQuery.parse(req.query);
    const user = await app.currentUser(req);
    const result = await listApplications(app.ctx.db, user, {
      scope: q.scope,
      type: q.type,
      statusId: q.statusId,
      level: q.level,
      districtId: q.districtId,
      text: q.text ?? q.q,
      draftsOnly: q.draftsOnly,
      idleDays: q.idleDays,
      sort: q.sort,
      page: q.page,
      pageSize: q.pageSize === 'all' ? 1000 : q.pageSize,
    });
    void reply.header('cache-control', 'private, no-store');
    return result;
  });

  app.get('/applications/:id', auth, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = await app.currentUser(req);
    const application = await getApplication(app.ctx.db, user, id);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('etag', `"r${(application as unknown as { row_version: number }).row_version}"`);
    return application;
  });

  app.get('/applications/:id/summary', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = await app.currentUser(req);
    return toSummary(await getApplication(app.ctx.db, user, id));
  });

  /** The authoritative calculation: fee, approval level, renewal period, issues. */
  app.get('/applications/:id/assessment', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const c = await ctxOf(req);
    const application = await getApplication(app.ctx.db, c.user, id);
    return { ...(await assessStored(c, application)), appl_id: id };
  });

  app.get('/applications/:id/validation', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const c = await ctxOf(req);
    const application = await getApplication(app.ctx.db, c.user, id);
    const { issues, errorCount } = await assessStored(c, application);
    return { issues, errorCount, ok: errorCount === 0 };
  });

  app.get('/applications/:id/process-log', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = await app.currentUser(req);
    const application = await getApplication(app.ctx.db, user, id);
    return application.processLog;
  });

  app.get('/applications/:id/revisions', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = await app.currentUser(req);
    await getApplication(app.ctx.db, user, id);
    const rows = await app.ctx.db
      .select({
        revision: s.applicationRevisions.revision,
        kind: s.applicationRevisions.kind,
        createdAt: s.applicationRevisions.createdAt,
        assessment: s.applicationRevisions.assessment,
      })
      .from(s.applicationRevisions)
      .where(eq(s.applicationRevisions.applicationId, id))
      .orderBy(s.applicationRevisions.revision, s.applicationRevisions.createdAt);
    return rows.map((r) => ({
      revision: r.revision,
      kind: r.kind,
      createdAt: r.createdAt,
      fee: (r.assessment as { fee?: { total?: number } } | null)?.fee?.total ?? null,
      approvalLevel: (r.assessment as { approvalLevel?: number } | null)?.approvalLevel ?? null,
    }));
  });

  /** Facts for the printable documents; the components render them unchanged. */
  app.get('/applications/:id/certificate/:kind', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const { kind } = z
      .object({ kind: z.enum(['acknowledgement', 'receipt', 'certificate', 'display-certificate', 'rejection']) })
      .parse(req.params);
    const user = await app.currentUser(req);
    const application = await getApplication(app.ctx.db, user, id);
    const parent = application.parent_id ? await getApplication(app.ctx.db, user, application.parent_id).catch(() => null) : null;
    const rules = app.ctx.rules.get();
    const content = app.ctx.cache.data<{ nocTerms: unknown }>('content');
    const renewalRules = app.ctx.cache.data<{ renewalRules: unknown }>('rules').renewalRules as never;
    const years = renewalPeriodYears(application, renewalRules);
    return {
      kind,
      application,
      parent,
      nocTerms: content.nocTerms,
      renewalYears: years,
      validity: application.final_date ? certificateValidity(application.final_date, years) : null,
      ruleVersions: rules.versionsUsed(),
    };
  });

  // ── Citizen lifecycle (phase B2) ───────────────────────────────────────────
  const ctxOf = async (req: FastifyRequest): Promise<ServiceContext> => ({
    db: app.ctx.db,
    cache: app.ctx.cache,
    rules: app.ctx.rules,
    user: await app.currentUser(req),
    requestId: req.requestId,
    ip: req.ip,
  });
  const ifMatch = (req: FastifyRequest): number | undefined => {
    const raw = req.headers['if-match'];
    const m = typeof raw === 'string' ? /^"?r?(\d+)"?$/.exec(raw.trim()) : null;
    return m ? Number(m[1]) : undefined;
  };
  const withEtag = <T extends { application: object }>(reply: FastifyReply, body: T) => {
    const version = (body.application as { row_version?: number }).row_version;
    if (version !== undefined) void reply.header('etag', `"r${version}"`);
    void reply.header('cache-control', 'private, no-store');
    return body;
  };

  app.post('/applications', citizen, async (req, reply) => {
    const body = z.object({ appl_type: z.string() }).passthrough().parse(req.body);
    const result = await createApplication(await ctxOf(req), body as never);
    return reply.status(201).send(withEtag(reply, result));
  });

  app.put('/applications/:id', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ site_name: z.string().optional(), site_addr: z.string().optional() }).passthrough().parse(req.body);
    const result = await saveApplication(await ctxOf(req), id, body as never, ifMatch(req));
    return withEtag(reply, result);
  });

  app.delete('/applications/:id', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await deleteDraft(await ctxOf(req), id);
    return reply.status(204).send();
  });

  app.post('/applications/:id/occupancy', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ conditions: z.array(z.object({ checklist_id: z.number(), item_desc: z.string() })).optional() }).parse(req.body ?? {});
    const result = await carryForward(await ctxOf(req), id, 'occupancy', body.conditions as never);
    return reply.status(201).send(withEtag(reply, result));
  });

  app.post('/applications/:id/renewal', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const result = await carryForward(await ctxOf(req), id, 'renewal');
    return reply.status(201).send(withEtag(reply, result));
  });

  app.get('/applications/:id/fee', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const c = await ctxOf(req);
    const application = await getApplication(app.ctx.db, c.user, id);
    return feePosition(c, app.ctx.db, application);
  });

  app.post('/applications/:id/payment', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        mode: z.enum(['online', 'challan']),
        challan_num: z.string().optional(),
        challan_date: z.string().optional(),
        bank: z.string().optional(),
        branch: z.string().optional(),
      })
      .parse(req.body);
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
    const result = await pay(await ctxOf(req), id, { ...body, challan_date: body.challan_date ? toDateColumn(body.challan_date) ?? undefined : undefined }, key);
    return withEtag(reply, result);
  });

  app.post('/applications/:id/submit', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ undertakings: z.array(z.string()).optional() }).parse(req.body ?? {});
    const result = await submit(await ctxOf(req), id, body);
    return withEtag(reply, result);
  });

  app.post('/applications/:id/revise', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const application = await revise(await ctxOf(req), id);
    return withEtag(reply, { application });
  });

  app.post('/applications/:id/feedback', citizen, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ rating: z.number().int(), remarks: z.string() }).parse(req.body);
    return { application: await saveFeedback(await ctxOf(req), id, body.rating, body.remarks) };
  });

  // ── Documents ──────────────────────────────────────────────────────────────
  app.post('/applications/:id/documents', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const part = await req.file();
    if (!part) throw badRequest('Attach a file.');
    const code = fieldValue(part.fields, 'code');
    if (!code) throw badRequest('Say which document this file is (field "code", sent before the file).');
    const application = await uploadApplicationDocument(await ctxOf(req), id, code, {
      stream: part.file,
      filename: part.filename,
      truncated: () => part.file.truncated,
    });
    return reply.status(201).send(withEtag(reply, { application }));
  });

  app.delete('/applications/:id/documents/:docNo', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { docNo } = z.object({ docNo: z.coerce.number().int() }).parse(req.params);
    return withEtag(reply, { application: await removeApplicationDocument(await ctxOf(req), id, docNo) });
  });

  app.post('/applications/:id/document-requests/:requestNo/response', citizen, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { requestNo } = z.object({ requestNo: z.coerce.number().int() }).parse(req.params);
    const part = await req.file();
    if (!part) throw badRequest('Attach a file.');
    const application = await respondToDocumentRequest(await ctxOf(req), id, requestNo, fieldValue(part.fields, 'comment') ?? '', {
      stream: part.file,
      filename: part.filename,
      truncated: () => part.file.truncated,
    });
    return reply.status(201).send(withEtag(reply, { application }));
  });

  // ── Stateless calculation (the wizard, and any other client) ──────────────
  app.post('/assessments', auth, async (req) => {
    const body = z.object({ appl_type: z.string() }).passthrough().parse(req.body);
    return assessPayload({ cache: app.ctx.cache, rules: app.ctx.rules }, body as never);
  });
}
