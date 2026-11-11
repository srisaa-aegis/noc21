import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import type { Assessment } from '@srisaa/noc-domain';
import { Application, ApplicationSummary, OccupancyCondition } from '../models';
import { ApiClient } from './api-client.service';
import { API_ENDPOINTS } from './api-endpoints';

export interface SaveResponse {
  application: Application;
  assessment: Assessment;
}

export interface FeePosition {
  fee: { total: number; description: string };
  paid: number;
  due: number;
  frozen: boolean;
}

export interface RevisionEntry {
  revision: number;
  kind: 'submitted' | 'decided' | 'archived';
  createdAt: string;
  /** Fee of the assessment stored with the snapshot. */
  fee: number | null;
  approvalLevel: number | null;
}

/**
 * The citizen lifecycle endpoints of the NOC backend. The server owns every
 * transaction and every calculation; the browser sends what the applicant
 * typed and adopts what the server returns.
 */
@Injectable({ providedIn: 'root' })
export class CitizenApi {
  private readonly api = inject(ApiClient);

  /** "My Applications": the summaries (not the aggregates) of the signed-in citizen's applications. */
  listMine(): Observable<ApplicationSummary[]> {
    return this.api.get<{ items: ApplicationSummary[] }>(API_ENDPOINTS.citizenApplicationList, undefined, { scope: 'mine', pageSize: 'all' }).pipe(map((r) => r.items));
  }

  get(id: number): Observable<Application> {
    return this.api.get<Application>(API_ENDPOINTS.applicationDetail, { id });
  }

  create(draft: Application): Observable<SaveResponse> {
    return this.api.request<SaveResponse>(API_ENDPOINTS.citizenApplicationCreate, { body: draft });
  }

  save(app: Application): Observable<SaveResponse> {
    return this.api.request<SaveResponse>(API_ENDPOINTS.citizenApplicationUpdate, {
      params: { id: app.appl_id },
      body: app,
      headers: app.row_version ? { 'If-Match': `"r${app.row_version}"` } : undefined,
    });
  }

  remove(id: number): Observable<void> {
    return this.api.request<void>(API_ENDPOINTS.citizenApplicationDelete, { params: { id } });
  }

  occupancyFrom(parentId: number, conditions: OccupancyCondition[]): Observable<SaveResponse> {
    return this.api.request<SaveResponse>(API_ENDPOINTS.citizenOccupancyFromProvisional, { params: { id: parentId }, body: { conditions } });
  }

  renewalFrom(parentId: number): Observable<SaveResponse> {
    return this.api.request<SaveResponse>(API_ENDPOINTS.citizenRenewalFromOccupancy, { params: { id: parentId }, body: {} });
  }

  fee(id: number): Observable<FeePosition> {
    return this.api.get<FeePosition>(API_ENDPOINTS.applicationFee, { id });
  }

  pay(
    id: number,
    body: { mode: 'online' } | { mode: 'challan'; challan_num: string; challan_date: string; bank: string; branch: string },
  ): Observable<{ application: Application; payment: FeePosition & { charged: number } }> {
    return this.api.request(API_ENDPOINTS.paymentInitiate, { params: { id }, body, headers: { 'Idempotency-Key': `pay-${id}-${Date.now()}` } });
  }

  submit(id: number, undertakings: string[]): Observable<SaveResponse> {
    return this.api.request<SaveResponse>(API_ENDPOINTS.citizenApplicationSubmit, { params: { id }, body: { undertakings } });
  }

  revise(id: number): Observable<Application> {
    return this.api.request<{ application: Application }>(API_ENDPOINTS.citizenApplicationRevise, { params: { id } }).pipe(map((r) => r.application));
  }

  feedback(id: number, rating: number, remarks: string): Observable<Application> {
    return this.api.request<{ application: Application }>(API_ENDPOINTS.citizenFeedbackSave, { params: { id }, body: { rating, remarks } }).pipe(map((r) => r.application));
  }

  revisions(id: number): Observable<RevisionEntry[]> {
    return this.api.get<RevisionEntry[]>(API_ENDPOINTS.applicationRevisions, { id });
  }

  /** Multipart upload; `code` is sent before the file so the server can validate it first. */
  uploadDocument(id: number, code: string, file: File, onProgress?: (percent: number) => void): Observable<Application> {
    const form = new FormData();
    form.append('code', code);
    form.append('file', file, file.name);
    return this.api.upload<{ application: Application }>(API_ENDPOINTS.documentUpload, { id }, form, onProgress).pipe(map((r) => r.application));
  }

  removeDocument(id: number, docNo: number): Observable<Application> {
    return this.api.request<{ application: Application }>(API_ENDPOINTS.documentRemove, { params: { id, docNo } }).pipe(map((r) => r.application));
  }

  respondToRequest(id: number, requestNo: number, comment: string, file: File): Observable<Application> {
    const form = new FormData();
    form.append('comment', comment);
    form.append('file', file, file.name);
    return this.api.upload<{ application: Application }>(API_ENDPOINTS.citizenRequestedDocUpload, { id, requestNo }, form).pipe(map((r) => r.application));
  }

  /** One-time link for opening a stored file in a new tab (no bearer token in the URL). */
  downloadUrl(fileId: string): Observable<string> {
    return this.api.request<{ url: string }>(API_ENDPOINTS.fileDownloadToken, { params: { id: fileId } }).pipe(map((r) => r.url));
  }
}
