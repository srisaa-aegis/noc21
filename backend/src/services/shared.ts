/**
 * Helpers shared by the write services (citizen, department, administration):
 * the service context, aggregate reads inside a transaction, the process log,
 * the audit log and the notification outbox.
 */
import { eq, max } from 'drizzle-orm';
import type { Application } from '@srisaa/noc-domain';
import type { ReferenceBundle } from '../cache/bundles.js';
import type { ReferenceCache } from '../cache/reference-cache.js';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';
import type { RulesEngineProvider } from '../engines/rules.js';
import { notFound } from '../errors/app-error.js';
import { businessDate } from '../lib/dates.js';
import type { Tx } from '../repositories/application.writer.js';
import { loadAggregate } from '../repositories/application.repo.js';
import { toApplication } from '../serializers/application.serializer.js';
import type { PublicUser } from './auth.service.js';

export interface ServiceContext {
  db: Database;
  cache: ReferenceCache;
  rules: RulesEngineProvider;
  user: PublicUser;
  requestId: string;
  ip: string;
  now?: Date;
}

export const reference = (c: Pick<ServiceContext, 'cache'>) => c.cache.data<ReferenceBundle>('reference');

/** The aggregate as stored (inside the current transaction). */
export async function read(tx: Tx, id: number, hideInternalNotes = true): Promise<Application> {
  const rows = await loadAggregate(tx as Database, id);
  if (!rows) throw notFound('Application not found.');
  return toApplication(rows, { hideInternalNotes });
}

async function nextStepNo(tx: Tx, applicationId: number): Promise<number> {
  const [row] = await tx.select({ n: max(s.processLog.stepNo) }).from(s.processLog).where(eq(s.processLog.applicationId, applicationId));
  return (row?.n ?? 0) + 1;
}

/** Appends one entry to the application's process log (the citizen-visible timeline). */
export async function logStep(
  tx: Tx,
  c: Pick<ServiceContext, 'now'>,
  applicationId: number,
  action: string,
  remarks: string,
  statusId: number,
  actor: { name: string; role: string; userId?: number | null },
): Promise<void> {
  await tx.insert(s.processLog).values({
    applicationId,
    stepNo: await nextStepNo(tx, applicationId),
    actorUserId: actor.userId ?? null,
    reviewerName: actor.name,
    role: actor.role,
    statusId,
    action,
    remarks,
    atDate: businessDate(c.now ?? new Date()),
    at: c.now ?? new Date(),
  });
}

export async function audit(
  tx: Tx,
  c: Pick<ServiceContext, 'user' | 'requestId' | 'ip'>,
  action: string,
  entityType: string,
  entityId: string | number,
  summary: string,
  after?: unknown,
): Promise<void> {
  await tx.insert(s.auditLog).values({
    requestId: c.requestId,
    actorUserId: c.user.id,
    actorUsername: c.user.username,
    actorPortal: c.user.portal,
    action,
    entityType,
    entityId: String(entityId),
    summary,
    after: (after ?? null) as Record<string, unknown> | null,
    ip: c.ip,
  });
}

/** Queues a message in the transactional outbox (delivered by the outbox job). */
export async function notify(
  tx: Tx,
  kind: 'sms' | 'email',
  to: string,
  templateKey: string,
  payload: Record<string, unknown>,
  refs: { applicationId?: number; userId?: number },
): Promise<void> {
  if (!to) return;
  await tx.insert(s.notificationOutbox).values({
    kind,
    toAddress: to,
    templateKey,
    payload,
    applicationId: refs.applicationId ?? null,
    userId: refs.userId ?? null,
  });
}
