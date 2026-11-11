/**
 * Housekeeping jobs (phase B3):
 *
 *   purgeFiles      stored files no longer used by anything — replaced or removed
 *                   draft documents, deleted drafts, orphans of failed uploads —
 *                   are deleted from storage FILE_PURGE_AFTER_DAYS after they
 *                   stopped being used (decision B2-9). Files of submitted
 *                   applications, decision copies and anything a revision
 *                   snapshot refers to are kept.
 *   cleanupTokens   expired refresh / reset / download tokens.
 *   purgeAudit      audit entries older than AUDIT_RETENTION_MONTHS (3).
 */
import { sql } from 'drizzle-orm';
import { config } from '../config/env.js';
import type { Database } from '../db/client.js';
import { store } from '../services/document.service.js';

export async function purgeFiles(db: Database, now: Date = new Date()): Promise<{ purged: number; bytes: number }> {
  const days = config().FILE_PURGE_AFTER_DAYS;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const candidates = await db.execute<{ id: string; storage_key: string; size_bytes: number }>(sql`
    select f.id, f.storage_key, f.size_bytes
      from files f
     where f.deleted_at is null
       and f.created_at < ${cutoff}::timestamptz
       -- still (or recently) used by an application document
       and not exists (select 1 from application_documents d join applications a on a.id = d.application_id
                        where d.file_id = f.id
                          and ((d.deleted_at is null and a.deleted_at is null)
                               or d.deleted_at >= ${cutoff}::timestamptz or a.deleted_at >= ${cutoff}::timestamptz
                               or (d.deleted_at is null and a.status_id > 1 and a.deleted_at is null)))
       and not exists (select 1 from dept_documents x join applications a on a.id = x.application_id
                        where x.file_id = f.id and (a.deleted_at is null or a.deleted_at >= ${cutoff}::timestamptz))
       and not exists (select 1 from document_requests r join applications a on a.id = r.application_id
                        where r.response_file_id = f.id and (a.deleted_at is null or a.deleted_at >= ${cutoff}::timestamptz))
       and not exists (select 1 from wf_task_attachments t where t.file_id = f.id)
       -- the legal record: anything a revision snapshot refers to
       and not exists (select 1 from application_revisions rv
                        where rv.snapshot->'documents' @> jsonb_build_array(jsonb_build_object('file_id', f.id::text)))
     limit 5000`);
  let purged = 0;
  let bytes = 0;
  for (const f of candidates.rows) {
    await store()
      .delete(f.storage_key)
      .catch(() => undefined);
    await db.execute(sql`update files set deleted_at = ${now.toISOString()}::timestamptz where id = ${f.id}`);
    purged++;
    bytes += Number(f.size_bytes);
  }
  return { purged, bytes };
}

export async function cleanupTokens(db: Database, now: Date = new Date()): Promise<{ refresh: number; reset: number; download: number }> {
  const at = now.toISOString();
  const refresh = await db.execute(sql`delete from refresh_tokens where expires_at < ${at}::timestamptz - interval '7 days'`);
  const reset = await db.execute(sql`delete from password_reset_tokens where expires_at < ${at}::timestamptz - interval '7 days'`);
  const download = await db.execute(sql`delete from download_tokens where expires_at < ${at}::timestamptz - interval '1 day'`);
  return { refresh: refresh.rowCount ?? 0, reset: reset.rowCount ?? 0, download: download.rowCount ?? 0 };
}

/** Audit entries are kept AUDIT_RETENTION_MONTHS (3 months, decided after B3). The table is append-only except for this purge. */
export async function purgeAudit(db: Database, now: Date = new Date()): Promise<{ deleted: number; before: string }> {
  const months = config().AUDIT_RETENTION_MONTHS;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`set local noc.allow_purge = 'on'`);
    const r = await tx.execute(sql`delete from audit_log where at < ${cutoff.toISOString()}::timestamptz`);
    return r.rowCount ?? 0;
  });
  return { deleted, before: cutoff.toISOString() };
}
