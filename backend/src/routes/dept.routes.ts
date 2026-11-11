/**
 * /dept — department processing (phase B3): the dashboard queues, the
 * processing page and every officer action, all through the workflow engine.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  changeFireStation,
  decideApplication,
  decisionPreview,
  deptView,
  parseOutcome,
  reassignTask,
  requestDocument,
  saveTask,
  sendSms,
  sendTaskBack,
  skipTask,
  submitTask,
  updateLicensingAuthority,
  uploadDeptDocument,
  uploadSignedCopy,
} from '../services/dept.service.js';
import { feedbackSummary, monitoring, myTasks } from '../services/dept-queue.service.js';
import { contextFactory, reportJurisdiction, fieldValue, multipartFile } from './helpers.js';

const appParams = z.object({ id: z.coerce.number().int().positive() });
const taskParams = appParams.extend({ taskNo: z.coerce.number().int().positive() });
const data = z.object({ data: z.record(z.string(), z.unknown()).default({}) });
const decisionInput = z
  .object({
    remark: z.string().default(''),
    valid_from: z.string().optional(),
    valid_to: z.string().optional(),
    addcc: z.string().optional(),
    rem_comm: z.string().optional(),
  })
  .passthrough();
const decisionBody = z.object({ outcome: z.string(), input: decisionInput.default({ remark: '' }) });

export async function deptRoutes(app: FastifyInstance): Promise<void> {
  const dept = { preHandler: app.requirePortal('dept') };
  const deptOrAdmin = { preHandler: app.requirePortal('dept', 'admin') };
  const ctxOf = contextFactory(app);
  const view = async (req: Parameters<typeof ctxOf>[0], id: number) => deptView(await ctxOf(req), id);

  // ── Queues ────────────────────────────────────────────────────────────────
  app.get('/dept/tasks', dept, async (req) => {
    const q = z
      .object({
        text: z.string().optional(),
        type: z.string().optional(),
        level: z.enum(['MSB', 'RFO', 'DFO']).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .parse(req.query);
    return myTasks(await ctxOf(req), q);
  });

  app.get('/dept/monitoring', deptOrAdmin, async (req) => {
    const q = z
      .object({
        text: z.string().optional(),
        type: z.string().optional(),
        level: z.enum(['MSB', 'RFO', 'DFO']).optional(),
        stage: z.string().optional(),
        includeDecided: z.enum(['true', 'false']).optional(),
        decided: z.enum(['recent', 'all']).optional(),
        overdueOnly: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return monitoring(await ctxOf(req), {
      ...q,
      includeDecided: q.includeDecided === 'true',
      overdueOnly: q.overdueOnly === 'true',
    });
  });

  app.get('/dept/feedback-summary', deptOrAdmin, async (req) => {
    const q = z.object({ months: z.coerce.number().int().min(1).max(120).optional(), level: z.enum(['MSB', 'RFO', 'DFO']).optional() }).parse(req.query);
    return feedbackSummary(app.ctx.db, q.months ?? null, new Date(), q.level, await reportJurisdiction(app, req));
  });

  // ── The processing page ───────────────────────────────────────────────────
  app.get('/dept/applications/:id', deptOrAdmin, async (req, reply) => {
    const { id } = appParams.parse(req.params);
    void reply.header('cache-control', 'private, no-store');
    return view(req, id);
  });

  app.post('/dept/applications/:id/tasks/:taskNo/save', dept, async (req) => {
    const { id, taskNo } = taskParams.parse(req.params);
    await saveTask(await ctxOf(req), id, taskNo, data.parse(req.body ?? {}).data);
    return view(req, id);
  });

  app.post('/dept/applications/:id/tasks/:taskNo/submit', dept, async (req) => {
    const { id, taskNo } = taskParams.parse(req.params);
    await submitTask(await ctxOf(req), id, taskNo, data.parse(req.body ?? {}).data);
    return view(req, id);
  });

  app.post('/dept/applications/:id/tasks/:taskNo/send-back', dept, async (req) => {
    const { id, taskNo } = taskParams.parse(req.params);
    const body = z.object({ comments: z.string() }).parse(req.body);
    await sendTaskBack(await ctxOf(req), id, taskNo, body.comments);
    return view(req, id);
  });

  app.post('/dept/applications/:id/tasks/:taskNo/skip', dept, async (req) => {
    const { id, taskNo } = taskParams.parse(req.params);
    await skipTask(await ctxOf(req), id, taskNo);
    return view(req, id);
  });

  app.post('/dept/applications/:id/tasks/:taskNo/reassign', dept, async (req) => {
    const { id, taskNo } = taskParams.parse(req.params);
    const body = z.object({ to: z.coerce.number().int().positive() }).parse(req.body);
    await reassignTask(await ctxOf(req), id, taskNo, body.to);
    return view(req, id);
  });

  app.post('/dept/applications/:id/tasks/:taskNo/signed-copy', dept, async (req, reply) => {
    const { id, taskNo } = taskParams.parse(req.params);
    const { file } = await multipartFile(req);
    return reply.status(201).send(await uploadSignedCopy(await ctxOf(req), id, taskNo, file));
  });

  app.post('/dept/applications/:id/tasks/:taskNo/decision-preview', dept, async (req) => {
    const { id, taskNo } = taskParams.parse(req.params);
    const body = decisionBody.parse(req.body);
    return { application: await decisionPreview(await ctxOf(req), id, taskNo, parseOutcome(body.outcome), body.input as never) };
  });

  app.post('/dept/applications/:id/tasks/:taskNo/decide', dept, async (req) => {
    const { id, taskNo } = taskParams.parse(req.params);
    const body = decisionBody.parse(req.body);
    await decideApplication(await ctxOf(req), id, taskNo, parseOutcome(body.outcome), body.input as never);
    return view(req, id);
  });

  // ── File actions ──────────────────────────────────────────────────────────
  app.post('/dept/applications/:id/document-requests', dept, async (req, reply) => {
    const { id } = appParams.parse(req.params);
    const body = z.object({ file_desc: z.string() }).parse(req.body);
    await requestDocument(await ctxOf(req), id, body.file_desc);
    return reply.status(201).send(await view(req, id));
  });

  app.post('/dept/applications/:id/dept-documents', dept, async (req, reply) => {
    const { id } = appParams.parse(req.params);
    const { file, fields } = await multipartFile(req);
    await uploadDeptDocument(await ctxOf(req), id, fieldValue(fields, 'description') ?? '', file);
    return reply.status(201).send(await view(req, id));
  });

  app.post('/dept/applications/:id/sms', dept, async (req, reply) => {
    const { id } = appParams.parse(req.params);
    const body = z.object({ message: z.string() }).parse(req.body);
    await sendSms(await ctxOf(req), id, body.message);
    return reply.status(201).send(await view(req, id));
  });

  app.put('/dept/applications/:id/fire-station', dept, async (req) => {
    const { id } = appParams.parse(req.params);
    const body = z.object({ district: z.coerce.number().int().positive(), fire_station_id: z.coerce.number().int().positive() }).parse(req.body);
    await changeFireStation(await ctxOf(req), id, body.district, body.fire_station_id);
    return view(req, id);
  });

  app.put('/dept/applications/:id/licensing-authority', dept, async (req) => {
    const { id } = appParams.parse(req.params);
    const body = z.object({ lic_auth: z.string(), lic_addr: z.string() }).parse(req.body);
    await updateLicensingAuthority(await ctxOf(req), id, body.lic_auth, body.lic_addr);
    return view(req, id);
  });

}
