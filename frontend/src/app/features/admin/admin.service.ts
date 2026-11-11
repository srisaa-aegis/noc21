import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiClient } from '../../core/api/api-client.service';
import { API_ENDPOINTS } from '../../core/api/api-endpoints';
import { Application, ApplicationSummary, EscalationLogEntry, EscalationNotice } from '../../core/models';

export interface EscalationPreview {
  /** Everything past its SLA (the most overdue first; see `counts`). */
  overdue: EscalationNotice[];
  /** Items to notify now (not reminded within the reminder interval; see `counts`). */
  due: EscalationNotice[];
  /** How many there are in all (the lists may be shortened). */
  counts: { overdue: number; due: number };
  last: EscalationLogEntry | null;
}

export interface AdminSearchQuery {
  text?: string;
  type?: string;
  statusId?: number | null;
  /** Only applications not modified for at least this many days. */
  staleDays?: number | null;
  /** Only drafts (status 1). */
  draftsOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface AdminSearchRow extends ApplicationSummary {
  days_idle: number | null;
}

export interface UnassignedTask {
  appl_id: number;
  appl_number: string;
  site_name: string;
  fire_station_id: number | null;
  task: { task_id: number; name: string; state: string; role_id: number };
  candidates: { id: number; username: string; displayName: string }[];
}

export interface StatusRow {
  code: number;
  desc: string;
  category: string;
  is_system: boolean;
  is_pre_decision: boolean;
  badge: string;
  sort_order: number;
  active: boolean;
  used_by: { applications: number; history: number; workflows: number };
}

export interface AuditEntry {
  id: number;
  at: string;
  requestId: string;
  actorUsername: string;
  actorPortal: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  ip: string;
}

export interface AuditQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  page?: number;
  pageSize?: number;
}

/** Admin operations on applications, tasks, statuses and escalations (all on the server). */
@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly api = inject(ApiClient);

  /** Search every application, including citizens' drafts (paged on the server, stalest first when asked). */
  search(query: AdminSearchQuery): Observable<{ items: AdminSearchRow[]; total: number }> {
    return this.api.get(API_ENDPOINTS.adminApplicationSearch, undefined, {
      scope: 'all',
      text: query.text,
      type: query.type,
      statusId: query.statusId ?? undefined,
      draftsOnly: query.draftsOnly ? 'true' : undefined,
      idleDays: query.staleDays ?? undefined,
      sort: query.staleDays != null || query.draftsOnly ? '-days_idle' : '-appl_id',
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 100,
    });
  }

  /** Number of applications matching a query (dashboard counters). */
  count(query: AdminSearchQuery): Observable<number> {
    return this.search({ ...query, pageSize: 1 }).pipe(map((r) => r.total));
  }

  /** Deletes applications (legacy deleteOldFiles.aspx); their files are purged after the retention period. */
  deleteApplications(ids: number[]): Observable<number> {
    return this.api.request<{ deleted: number }>(API_ENDPOINTS.adminApplicationDelete, { body: { ids } }).pipe(map((r) => r.deleted));
  }

  escalationPreview(): Observable<EscalationPreview> {
    return this.api.get<EscalationPreview>(API_ENDPOINTS.adminEscalationPreview);
  }

  sendEscalations(): Observable<EscalationLogEntry> {
    return this.api.request<EscalationLogEntry>(API_ENDPOINTS.adminSendEscalations);
  }

  escalationLog(): Observable<EscalationLogEntry[]> {
    return this.api.get<{ items: EscalationLogEntry[] }>(API_ENDPOINTS.adminEscalationLog).pipe(map((r) => r.items));
  }

  /** Tasks nobody could be assigned to (no officer of the role at the fire station). */
  unassignedTasks(): Observable<UnassignedTask[]> {
    return this.api.get<{ items: UnassignedTask[] }>(API_ENDPOINTS.adminUnassignedTasks).pipe(map((r) => r.items));
  }

  assignTask(applId: number, taskId: number, toUserId: number): Observable<Application> {
    return this.api
      .request<{ application: Application }>(API_ENDPOINTS.adminReassignTask, { params: { id: applId, taskNo: taskId }, body: { to: toUserId } })
      .pipe(map((r) => r.application));
  }

  /** The audit trail, newest first (`action` is a prefix, e.g. "workflow."). */
  audit(q: AuditQuery = {}): Observable<{ items: AuditEntry[]; page: number; pageSize: number; more: boolean }> {
    return this.api.get(API_ENDPOINTS.auditTrail, undefined, {
      action: q.action?.trim() || undefined,
      entityType: q.entityType || undefined,
      entityId: q.entityId?.trim() || undefined,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 50,
    });
  }

  statuses(): Observable<StatusRow[]> {
    return this.api.get<{ items: StatusRow[] }>(API_ENDPOINTS.adminStatuses).pipe(map((r) => r.items));
  }

  addStatus(input: { desc: string; badge?: string; sort_order?: number; is_pre_decision?: boolean }): Observable<StatusRow[]> {
    return this.api.request<{ items: StatusRow[] }>(API_ENDPOINTS.adminStatusAdd, { body: input }).pipe(map((r) => r.items));
  }

  updateStatus(id: number, patch: Partial<Pick<StatusRow, 'desc' | 'badge' | 'sort_order' | 'active' | 'is_pre_decision'>>): Observable<StatusRow[]> {
    return this.api.request<{ items: StatusRow[] }>(API_ENDPOINTS.adminStatusUpdate, { params: { id }, body: patch }).pipe(map((r) => r.items));
  }

  removeStatus(id: number): Observable<StatusRow[]> {
    return this.api.request<{ items: StatusRow[] }>(API_ENDPOINTS.adminStatusRemove, { params: { id } }).pipe(map((r) => r.items));
  }
}
