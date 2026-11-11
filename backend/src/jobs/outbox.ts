/**
 * Notification outbox dispatcher.
 *
 * Services queue messages in `notification_outbox` inside their own
 * transaction (so a rolled-back action never sends anything). This job renders
 * them with the legacy templates and hands them to a driver. The only driver
 * in this phase is `log`: the message is written to the API log, which is
 * how a developer sees a password-reset link or a submission SMS.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';

export function render(template: string, payload: Record<string, unknown>): string {
  return template.replace(/<<(\w+)>>/g, (_m, key: string) => String(payload[key] ?? ''));
}

/**
 * Sends up to `limit` queued messages. Several API processes may run the
 * dispatcher: each claims its batch with `FOR UPDATE SKIP LOCKED` inside one
 * transaction, so a message is sent once.
 */
export async function flushOutbox(db: Database, log: FastifyBaseLogger, limit = 50): Promise<number> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{ id: number }>(sql`
      select id from notification_outbox where status = 'queued' order by id limit ${limit} for update skip locked`);
    const ids = claimed.rows.map((r) => Number(r.id));
    if (!ids.length) return 0;
    const queued = await tx.select().from(s.notificationOutbox).where(inArray(s.notificationOutbox.id, ids));
    const templates = await tx
      .select()
      .from(s.notificationTemplates)
      .where(inArray(s.notificationTemplates.key, [...new Set(queued.map((q) => q.templateKey))]));
    const byKey = new Map(templates.map((t) => [t.key, t]));
    for (const msg of queued.sort((a, b) => a.id - b.id)) {
      const template = byKey.get(msg.templateKey);
      const text = template ? render(template.body, msg.payload as Record<string, unknown>) : JSON.stringify(msg.payload);
      log.info({ notification: { id: msg.id, kind: msg.kind, to: msg.toAddress, subject: template?.subject ?? '' }, text }, `${msg.kind.toUpperCase()} (log driver)`);
      await tx
        .update(s.notificationOutbox)
        .set({ status: 'sent', sentAt: new Date(), attempts: msg.attempts + 1 })
        .where(eq(s.notificationOutbox.id, msg.id));
    }
    return queued.length;
  });
}

/** Polls the outbox while the API runs. */
export function startOutboxDispatcher(db: Database, log: FastifyBaseLogger, intervalMs = 5000): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    flushOutbox(db, log)
      .catch((e: Error) => log.warn({ err: e.message }, 'outbox flush failed'))
      .finally(() => (busy = false));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
