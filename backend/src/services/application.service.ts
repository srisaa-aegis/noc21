/**
 * Application reads and the authorisation that governs them.
 *
 * Citizens see their own applications; officers see submitted applications in
 * the jurisdiction of their fire-station association (the monitoring role sees
 * all); admins see everything, including drafts.
 */
import { and, eq } from 'drizzle-orm';
import { assess, type Assessment } from '@srisaa/noc-domain';
import type { Application } from '@srisaa/noc-domain';
import type { RuleEngine } from '@srisaa/rules-engine';
import type { ReferenceBundle } from '../cache/bundles.js';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { forbidden, notFound } from '../errors/app-error.js';
import { businessToday } from '../lib/dates.js';
import { listSummaries, loadAggregate, officerScope, type ListQuery } from '../repositories/application.repo.js';
import { toApplication, toSummaryDto } from '../serializers/application.serializer.js';
import type { PublicUser } from './auth.service.js';

export type Scope = 'mine' | 'dept' | 'all';

export interface ListParams extends Omit<ListQuery, 'ownerUserId' | 'submittedOnly' | 'page' | 'pageSize'> {
  scope: Scope;
  page: number;
  pageSize: number;
}

export async function listApplications(
  db: Database,
  user: PublicUser,
  params: ListParams,
): Promise<{ items: ReturnType<typeof toSummaryDto>[]; page: number; pageSize: number; total: number }> {
  const query: ListQuery = { ...params };
  if (params.scope === 'mine') {
    if (user.portal !== 'citizen') throw forbidden('Only citizens have their own applications.');
    query.ownerUserId = user.id;
  } else if (params.scope === 'dept') {
    if (user.portal !== 'dept' && user.portal !== 'admin') throw forbidden('Only department users can see the queue.');
    query.submittedOnly = true;
  } else {
    if (user.portal !== 'admin') throw forbidden('Only administrators can search every application.');
  }
  if (params.scope === 'dept' && user.portal === 'dept') {
    const scope = await officerScope(db, user.id);
    if (!scope) throw forbidden('Your account is not configured as a department officer.');
    if (!scope.monitoring && !scope.allStations) query.jurisdiction = { stationIds: scope.stationIds, userId: user.id };
  }
  const { items, total } = await listSummaries(db, query);
  return { items: items.map(toSummaryDto), page: params.page, pageSize: params.pageSize, total };
}

/** Can this user see this application at all? */
export async function assertCanRead(db: Database, user: PublicUser, app: Application & { __fireStationId?: number | null }): Promise<void> {
  if (user.portal === 'admin') return;
  if (user.portal === 'citizen') {
    if (app.owner !== user.username) throw notFound('Application not found.');
    return;
  }
  // Department: submitted applications only, inside the officer's jurisdiction.
  if (app.status_id <= 1) throw notFound('Application not found.');
  const scope = await officerScope(db, user.id);
  if (!scope) throw forbidden('Your account is not configured as a department officer.');
  if (scope.monitoring || scope.allStations) return;
  if (app.fire_station_id && scope.stationIds.includes(app.fire_station_id)) return;
  // Officers keep access to files they have worked on even after a transfer.
  const involved = await db
    .select({ id: s.wfTasks.id })
    .from(s.wfTasks)
    .innerJoin(s.wfInstances, eq(s.wfInstances.id, s.wfTasks.instanceId))
    .where(and(eq(s.wfInstances.subjectId, app.appl_id), eq(s.wfTasks.assigneeUserId, user.id)))
    .limit(1);
  if (!involved.length) throw notFound('Application not found.');
}

export async function getApplication(db: Database, user: PublicUser, applicationId: number): Promise<Application> {
  const rows = await loadAggregate(db, applicationId);
  if (!rows) throw notFound('Application not found.');
  const app = toApplication(rows, { hideInternalNotes: user.portal === 'citizen' });
  await assertCanRead(db, user, app);
  return app;
}

export interface AssessmentLookupsSource {
  reference: ReferenceBundle;
}

/** Server-side recalculation (fee, approval level, renewal period, FFE, issues). */
export function assessApplication(app: Application, engine: RuleEngine, reference: ReferenceBundle, now = businessToday()): Assessment {
  return assess(
    app,
    engine,
    {
      applicationTypes: reference.applicationTypes as never,
      buildTypes: reference.buildTypes as never,
      partyRoles: reference.partyRoles as never,
      documentRequirements: reference.documentRequirements as never,
      equipments: reference.equipments as never,
    },
    now,
  );
}
