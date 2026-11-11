/** /admin — accounts, hand-over, unassigned tasks, application deletion, statuses, escalations, audit. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import * as s from '../db/schema/index.js';
import {
  addStatus,
  adminSetPassword,
  createDeptUser,
  deleteApplications,
  handOver,
  listStatuses,
  openTasksOf,
  removeStatus,
  setActive,
  unassignedTasks,
  updateCitizen,
  updateDeptUser,
  updateStatus,
} from '../services/admin.service.js';
import { reassignTask } from '../services/dept.service.js';
import { escalationLog, preview as escalationPreview, send as sendEscalations } from '../services/escalation.service.js';
import { contextFactory } from './helpers.js';
import { publicUser } from '../services/auth.service.js';
import { fromDateColumn } from '../lib/dates.js';
import { forbidden } from '../errors/app-error.js';

const listQuery = z.object({
  portal: z.enum(['citizen', 'dept', 'admin']).optional(),
  roleId: z.coerce.number().int().optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const admin = { preHandler: app.requirePortal('admin') };

  app.get('/admin/accounts', admin, async (req) => {
    const q = listQuery.parse(req.query);
    const where: SQL[] = [isNull(s.users.deletedAt)];
    if (q.portal) where.push(eq(s.users.portal, q.portal));
    if (q.active !== undefined) where.push(eq(s.users.active, q.active));
    if (q.roleId) where.push(eq(s.deptProfiles.roleId, q.roleId));
    if (q.q) {
      const like = `%${q.q.trim().toLowerCase()}%`;
      // one trigram-indexed expression (users_search_trgm_idx)
      where.push(sql`lower(${s.users.username} || ' ' || ${s.users.displayName} || ' ' || ${s.users.email}) like ${like}`);
    }
    const rows = await app.ctx.db
      .select({
        id: s.users.id,
        username: s.users.username,
        email: s.users.email,
        displayName: s.users.displayName,
        portal: s.users.portal,
        mobile: s.users.mobile,
        active: s.users.active,
        must_change_password: s.users.mustChangePassword,
        created_on: s.users.createdOn,
        last_login_at: s.users.lastLoginAt,
        role_id: s.deptProfiles.roleId,
        district_id: s.deptProfiles.districtId,
        all_stations: s.deptProfiles.allStations,
        gender: s.citizenProfiles.gender,
        dob: s.citizenProfiles.dob,
        address: s.citizenProfiles.address,
        aadhar_last4: s.citizenProfiles.aadharLast4,
      })
      .from(s.users)
      .leftJoin(s.deptProfiles, eq(s.deptProfiles.userId, s.users.id))
      .leftJoin(s.citizenProfiles, eq(s.citizenProfiles.userId, s.users.id))
      .where(and(...where))
      .orderBy(asc(s.users.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);

    const stations = await app.ctx.db.select().from(s.deptUserStations);
    const total = await app.ctx.db
      .select({ count: sql<string>`count(*)::text` })
      .from(s.users)
      .leftJoin(s.deptProfiles, eq(s.deptProfiles.userId, s.users.id))
      .where(and(...where));

    return {
      items: rows.map(({ role_id, district_id, all_stations, gender, dob, address, aadhar_last4, ...u }) => ({
        ...u,
        created_on: fromDateColumn(u.created_on),
        ...(role_id
          ? { role_id, district: district_id ?? 0, all_stations: !!all_stations, fire_station_ids: stations.filter((x) => x.userId === u.id).map((x) => x.fireStationId) }
          : {}),
        ...(u.portal === 'citizen' ? { gender: gender ?? '', dob: fromDateColumn(dob), address: address ?? '', aadhar_last4: aadhar_last4 ?? '' } : {}),
      })),
      page: q.page,
      pageSize: q.pageSize,
      total: Number(total[0]?.count ?? 0),
    };
  });

  app.get('/admin/accounts/:id', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return publicUser(app.ctx.db, id);
  });

  /**
   * The audit trail, newest first; `action` matches a prefix ("workflow." → every
   * workflow action). Readers: the administrator and the DG (decided after B3).
   * Entries are kept 3 months (job purge-audit).
   */
  const auditReaders = {
    preHandler: [
      app.requirePortal('admin', 'dept'),
      async (req: FastifyRequest) => {
        if (req.auth?.portal === 'admin') return;
        const [role] = await app.ctx.db
          .select({ code: s.deptRoles.code })
          .from(s.deptProfiles)
          .innerJoin(s.deptRoles, eq(s.deptRoles.id, s.deptProfiles.roleId))
          .where(eq(s.deptProfiles.userId, req.auth!.sub))
          .limit(1);
        if (role?.code !== 'DG') throw forbidden('Only the Director General and the administrator can read the audit trail.');
      },
    ],
  };
  app.get('/audit', auditReaders, async (req) => {
    const q = z
      .object({
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        actorUserId: z.coerce.number().int().optional(),
        action: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const where: SQL[] = [];
    if (q.entityType) where.push(eq(s.auditLog.entityType, q.entityType));
    if (q.entityId) where.push(eq(s.auditLog.entityId, q.entityId));
    if (q.actorUserId) where.push(eq(s.auditLog.actorUserId, q.actorUserId));
    if (q.action) where.push(sql`${s.auditLog.action} like ${`${q.action.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`}`);
    const rows = await app.ctx.db
      .select()
      .from(s.auditLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(s.auditLog.at), desc(s.auditLog.id))
      .limit(q.pageSize + 1)
      .offset((q.page - 1) * q.pageSize);
    return { items: rows.slice(0, q.pageSize), page: q.page, pageSize: q.pageSize, more: rows.length > q.pageSize };
  });

  /** Officers available for assignment pickers (from the cached directory bundle). */
  app.get('/admin/officers', { preHandler: app.requirePortal('dept', 'admin') }, async () =>
    app.ctx.cache.data<{ officers: unknown[] }>('directory').officers,
  );

  // ── Accounts (phase B3) ────────────────────────────────────────────────────
  const ctxOf = contextFactory(app);
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const deptUser = z.object({
    username: z.string().optional(),
    displayName: z.string(),
    email: z.string(),
    mobile: z.string(),
    role_id: z.coerce.number().int(),
    district: z.coerce.number().int().nullable().optional(),
    fire_station_ids: z.array(z.coerce.number().int()).optional(),
    all_stations: z.boolean().optional(),
  });

  app.post('/admin/accounts/dept', admin, async (req, reply) => {
    const result = await createDeptUser(await ctxOf(req), deptUser.parse(req.body));
    await app.ctx.cache.checkVersions();
    return reply.status(201).send(result);
  });

  app.put('/admin/accounts/:id/dept', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const account = await updateDeptUser(await ctxOf(req), id, deptUser.parse(req.body));
    await app.ctx.cache.checkVersions();
    return { account };
  });

  app.put('/admin/accounts/:id/profile', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ displayName: z.string(), email: z.string(), mobile: z.string(), address: z.string().optional(), gender: z.string().optional(), dob: z.string().optional() })
      .parse(req.body);
    return { account: await updateCitizen(await ctxOf(req), id, body) };
  });

  app.post('/admin/accounts/:id/password', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ password: z.string().optional() }).parse(req.body ?? {});
    return adminSetPassword(await ctxOf(req), id, body.password || undefined);
  });

  app.put('/admin/accounts/:id/active', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ active: z.boolean() }).parse(req.body);
    const account = await setActive(await ctxOf(req), id, body.active);
    await app.ctx.cache.checkVersions();
    return { account };
  });

  app.get('/admin/accounts/:id/open-tasks', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    return { items: await openTasksOf(app.ctx, id) };
  });

  app.post('/admin/accounts/:id/handover', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ to: z.coerce.number().int().positive() }).parse(req.body);
    return handOver(await ctxOf(req), id, body.to);
  });

  // ── Workflow housekeeping ───────────────────────────────────────────────────
  app.get('/admin/unassigned-tasks', admin, async (req) => ({ items: await unassignedTasks(await ctxOf(req)) }));

  app.post('/admin/applications/:id/tasks/:taskNo/reassign', admin, async (req) => {
    const { id, taskNo } = z.object({ id: z.coerce.number().int(), taskNo: z.coerce.number().int() }).parse(req.params);
    const body = z.object({ to: z.coerce.number().int().positive() }).parse(req.body);
    return { application: await reassignTask(await ctxOf(req), id, taskNo, body.to, { asAdmin: true }) };
  });

  app.delete('/admin/applications', admin, async (req) => {
    const body = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500) }).parse(req.body);
    return { deleted: await deleteApplications(await ctxOf(req), body.ids) };
  });

  // ── Statuses (N-4) ───────────────────────────────────────────────────────────
  app.get('/admin/statuses', admin, async () => ({ items: await listStatuses(app.ctx) }));
  app.post('/admin/statuses', admin, async (req, reply) => {
    const body = z.object({ desc: z.string(), badge: z.string().optional(), sort_order: z.coerce.number().int().optional(), is_pre_decision: z.boolean().optional() }).parse(req.body);
    const items = await addStatus(await ctxOf(req), body);
    await app.ctx.cache.checkVersions();
    return reply.status(201).send({ items });
  });
  app.put('/admin/statuses/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ desc: z.string().optional(), badge: z.string().optional(), sort_order: z.coerce.number().int().optional(), active: z.boolean().optional(), is_pre_decision: z.boolean().optional() })
      .parse(req.body);
    const items = await updateStatus(await ctxOf(req), id, body);
    await app.ctx.cache.checkVersions();
    return { items };
  });
  app.delete('/admin/statuses/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const items = await removeStatus(await ctxOf(req), id);
    await app.ctx.cache.checkVersions();
    return { items };
  });

  // ── Escalations ─────────────────────────────────────────────────────────────
  app.get('/admin/escalations/preview', admin, async () => escalationPreview(app.ctx.db, app.ctx.cache));
  app.post('/admin/escalations/send', admin, async (req) => {
    const user = await app.currentUser(req);
    return sendEscalations(app.ctx.db, app.ctx.cache, `admin:${user.username}`);
  });
  app.get('/admin/escalations/log', admin, async () => ({ items: await escalationLog(app.ctx.db) }));
}
