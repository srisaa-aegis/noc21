import { Injectable, inject } from '@angular/core';
import { Observable, map, switchMap } from 'rxjs';
import { CitizenApi } from '../../core/api/citizen-api.service';
import { canApplyForOccupancy, canApplyForRenewal, canDelete, canEdit, canRate, canRevise } from '../../core/domain/application-rules';
import { Application, ApplicationSummary, OccupancyCondition } from '../../core/models';

/**
 * Citizen-facing application data access. Every transaction — numbering,
 * approval level, workflow start, validation — happens on the server; this
 * service only sends what the applicant did and hands back what the server
 * stored.
 */
@Injectable({ providedIn: 'root' })
export class ApplicationsService {
  private readonly server = inject(CitizenApi);

  /** "My Applications" — newest first. */
  listMine(_owner?: string): Observable<ApplicationSummary[]> {
    return this.server.listMine().pipe(map((list) => [...list].sort((a, b) => b.appl_id - a.appl_id)));
  }

  /** Full aggregate (the server decides whether the signed-in user may see it). */
  get(applId: number, _owner?: string): Observable<Application> {
    return this.server.get(applId);
  }

  /** First save of a new application (legacy newapplication.aspx): only the site name and address are needed. */
  createFromDraft(draft: Application): Observable<Application> {
    return this.server.create(draft).pipe(map((r) => r.application));
  }

  createOccupancyFromProvisional(parentId: number, _owner: string, conditions: OccupancyCondition[] = []): Observable<Application> {
    return this.server.occupancyFrom(parentId, conditions).pipe(map((r) => r.application));
  }

  createRenewalFromOccupancy(parentId: number, _owner: string): Observable<Application> {
    return this.server.renewalFrom(parentId).pipe(map((r) => r.application));
  }

  /** Saves a draft (legacy SaveApplication, optimistic locking with the row version). */
  save(app: Application): Observable<Application> {
    return this.server.save(app).pipe(map((r) => r.application));
  }

  /** Submits a draft: the server validates it, numbers it and starts the department workflow. */
  submit(app: Application, undertakings: string[] = []): Observable<Application> {
    return this.server.submit(app.appl_id, undertakings).pipe(map((r) => r.application));
  }

  /** Reopens a returned (8) / rejected (9) application as a new revision (legacy revise.aspx). */
  revise(applId: number, _owner?: string): Observable<Application> {
    return this.server.revise(applId);
  }

  /** Deletes a draft and returns the refreshed list. */
  deleteDraft(applId: number, owner?: string): Observable<ApplicationSummary[]> {
    return this.server.remove(applId).pipe(switchMap(() => this.listMine(owner)));
  }

  /** Responds to a department document request (legacy UploadRequestDocs). */
  uploadRequestedDocument(applId: number, _owner: string, fileid: number, file: File, comment: string): Observable<Application> {
    return this.server.respondToRequest(applId, fileid, comment, file);
  }

  /** Citizen rating of a completed application (legacy savefeedback.aspx). */
  saveFeedback(applId: number, _owner: string, rating: number, remarks: string): Observable<Application> {
    return this.server.feedback(applId, rating, remarks);
  }

  // Business-rule helpers re-exported for templates/components.
  readonly canApplyForOccupancy = canApplyForOccupancy;
  readonly canApplyForRenewal = canApplyForRenewal;
  readonly canRevise = canRevise;
  readonly canDelete = canDelete;
  readonly canEdit = canEdit;
  readonly canRate = canRate;

  summarize(list: ApplicationSummary[]): { total: number; inProgress: number; approved: number; needsAttention: number } {
    return {
      total: list.length,
      inProgress: list.filter((a) => a.status_id >= 1 && a.status_id <= 6).length,
      approved: list.filter((a) => a.status_id === 7).length,
      needsAttention: list.filter((a) => a.status_id === 8 || a.status_id === 9 || a.pending_requests > 0).length,
    };
  }
}

export const applicationListFilter = (
  list: ApplicationSummary[],
  query: { type?: string; statusId?: number; text?: string },
): ApplicationSummary[] =>
  list.filter((a) => {
    if (query.type && a.appl_type !== query.type) return false;
    if (query.statusId != null && a.status_id !== query.statusId) return false;
    if (query.text) {
      const t = query.text.toLowerCase();
      const hay = `${a.appl_number} ${a.site_name} ${a.build_name} ${a.dist_name} ${a.site_addr}`.toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });
