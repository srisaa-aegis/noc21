import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import type { DecisionInput, FeedbackSummary } from '@srisaa/noc-domain';
import { ApiClient } from '../../core/api/api-client.service';
import { API_ENDPOINTS } from '../../core/api/api-endpoints';
import { Application, ApplicationSummary, DelegationLevel, WorkflowOutcome, WorkflowTask } from '../../core/models';

/** What the signed-in officer may do on a file right now (decided by the server's workflow engine). */
export interface AllowedActions {
  tasks: { task_id: number; save: boolean; submit: boolean; send_back: boolean; decide: boolean; request_documents: boolean; challan_check: boolean }[];
  outcomes: WorkflowOutcome[];
  skip: number[];
  reassign: number[];
  reassign_candidates: Record<number, { id: number; username: string; displayName: string }[]>;
  upload_documents: boolean;
  sms: boolean;
  change_fire_station: boolean;
  update_licensing_authority: boolean;
  is_decider: boolean;
}

export interface DeptView {
  application: Application;
  allowed_actions: AllowedActions;
  /** The application this one was carried forward from (certificate preview). */
  parent: Application | null;
}

export type DeptSummary = ApplicationSummary & { stage_label: string };

export interface TaskRow {
  app: DeptSummary;
  task: Pick<WorkflowTask, 'task_id' | 'name' | 'stage_key' | 'task_key' | 'role_id' | 'form' | 'start_date' | 'state'>;
  action: string;
  days: number;
  sla: number;
  overdue: boolean;
  station: string;
}

export interface MonitorRow {
  app: DeptSummary;
  station: string;
  days: number;
  sla: number | null;
  overdue: boolean;
  complete: boolean;
}

export interface MonitorQuery {
  text?: string;
  type?: string;
  level?: DelegationLevel | '';
  stage?: string;
  includeDecided?: boolean;
  /** With decided files: the last 12 months when there are many (default), or all. */
  decidedAll?: boolean;
  overdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

/** "My tasks": the oldest matching open tasks, and counts over all of them. */
export interface TaskList {
  items: TaskRow[];
  total: number;
  overdue: number;
  groups: { name: string; count: number }[];
}

export interface MonitorPage {
  items: MonitorRow[];
  total: number;
  page: number;
  pageSize: number;
  stages: { label: string; count: number }[];
  kpis: { in_process: number; processing_overdue: number };
  /** With decided files: how far back they go (null = all) and how many there are. */
  decided?: { window_months: number | null; total: number } | null;
}

/**
 * Department processing through the NOC backend (legacy applications.aspx,
 * process_move.aspx, sendback.aspx, reassign.aspx, uploaddeptdocs.aspx, sendsms.aspx…).
 * Every action runs in the server's workflow engine, which also decides what
 * the officer may do (`allowed_actions`).
 */
@Injectable({ providedIn: 'root' })
export class DeptWorkflowService {
  private readonly api = inject(ApiClient);

  /** My open tasks (dashboard "My tasks"). */
  tasks(q: { text?: string; type?: string; level?: string; limit?: number } = {}): Observable<TaskList> {
    return this.api.get<TaskList>(API_ENDPOINTS.deptTasks, undefined, {
      text: q.text?.trim() || undefined,
      type: q.type || undefined,
      level: q.level || undefined,
      limit: q.limit ?? 200,
    });
  }

  /** Files the officer follows (dashboard "Monitoring"), filtered and paged on the server. */
  monitoring(q: MonitorQuery = {}): Observable<MonitorPage> {
    return this.api.get<MonitorPage>(API_ENDPOINTS.deptMonitoring, undefined, {
      text: q.text,
      type: q.type,
      level: q.level || undefined,
      stage: q.stage,
      includeDecided: q.includeDecided ? 'true' : undefined,
      decided: q.includeDecided && q.decidedAll ? 'all' : undefined,
      overdueOnly: q.overdueOnly ? 'true' : undefined,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 50,
    });
  }

  /** Department search over submitted applications in the officer's jurisdiction. */
  search(query: { text?: string; type?: string; level?: string; statusId?: number; page?: number; pageSize?: number }): Observable<{ items: ApplicationSummary[]; total: number }> {
    return this.api.get(API_ENDPOINTS.deptSearch, undefined, { scope: 'dept', ...query, pageSize: query.pageSize ?? 50 });
  }

  /** Average citizen rating over the last `months` months (null = overall) — legacy Feedback_AvgRating.aspx. */
  feedback(months: number | null): Observable<FeedbackSummary> {
    return this.api.get<FeedbackSummary>(API_ENDPOINTS.deptFeedbackRatings, undefined, { months: months ?? undefined });
  }

  /** The processing page: the application, what the officer may do, and its parent. */
  view(applId: number): Observable<DeptView> {
    return this.api.get<DeptView>(API_ENDPOINTS.deptApplication, { id: applId });
  }

  saveTask(applId: number, taskId: number, data: Record<string, unknown>): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptTaskSave, { params: { id: applId, taskNo: taskId }, body: { data } });
  }

  submitTask(applId: number, taskId: number, data: Record<string, unknown>): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptTaskSubmit, { params: { id: applId, taskNo: taskId }, body: { data } });
  }

  sendBack(applId: number, taskId: number, comments: string): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptSendBack, { params: { id: applId, taskNo: taskId }, body: { comments } });
  }

  skipTask(applId: number, taskId: number): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptSkipTask, { params: { id: applId, taskNo: taskId } });
  }

  reassignTask(applId: number, taskId: number, toUserId: number): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptReassignTask, { params: { id: applId, taskNo: taskId }, body: { to: toUserId } });
  }

  /** Uploads the signed NOC / letter before the decision is submitted. */
  uploadSignedCopy(applId: number, taskId: number, file: File): Observable<{ file_id: string; file_name: string; size: number }> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.api.upload(API_ENDPOINTS.deptSignedCopy, { id: applId, taskNo: taskId }, form);
  }

  /** The application as it would be after the decision (the live NOC / letter preview). */
  decisionPreview(applId: number, taskId: number, outcome: WorkflowOutcome, input: DecisionInput): Observable<Application> {
    return this.api
      .request<{ application: Application }>(API_ENDPOINTS.deptDecisionPreview, { params: { id: applId, taskNo: taskId }, body: { outcome, input } })
      .pipe(map((r) => r.application));
  }

  decide(applId: number, taskId: number, outcome: WorkflowOutcome, input: DecisionInput): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptDecision, { params: { id: applId, taskNo: taskId }, body: { outcome, input } });
  }

  requestDocuments(applId: number, fileDesc: string): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptRequestDocuments, { params: { id: applId }, body: { file_desc: fileDesc } });
  }

  uploadDocument(applId: number, file: File, description: string): Observable<DeptView> {
    const form = new FormData();
    form.append('description', description);
    form.append('file', file, file.name);
    return this.api.upload<DeptView>(API_ENDPOINTS.deptUploadDocument, { id: applId }, form);
  }

  sendSms(applId: number, message: string): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptSendSms, { params: { id: applId }, body: { message } });
  }

  changeFireStation(applId: number, district: number, fireStationId: number): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptUpdateFireStation, { params: { id: applId }, body: { district, fire_station_id: fireStationId } });
  }

  updateLicensingAuthority(applId: number, licAuth: string, licAddr: string): Observable<DeptView> {
    return this.api.request<DeptView>(API_ENDPOINTS.deptUpdateLicensingAuthority, { params: { id: applId }, body: { lic_auth: licAuth, lic_addr: licAddr } });
  }

  /** A report computed on the server (JSON), and its CSV export. */
  report<T>(id: string, filter: Record<string, string | number | undefined>): Observable<T> {
    return this.api.get<T>(API_ENDPOINTS.deptReports, { id }, filter);
  }

  reportCsv(id: string, filter: Record<string, string | number | undefined>): Observable<Blob> {
    return this.api.download(API_ENDPOINTS.deptReports, { id }, { ...filter, format: 'csv' });
  }
}
