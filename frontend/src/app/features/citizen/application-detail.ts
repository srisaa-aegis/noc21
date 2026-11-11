import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { canApplyForOccupancy, canApplyForRenewal, canDelete, canRate, canRevise, delegationLevelName, toSummary } from '../../core/domain/application-rules';
import { validateUpload } from '../../core/domain/documents';
import { LookupService, WizardLookups } from '../../core/lookups/lookup.service';
import { Application, RequestedDocument } from '../../core/models';
import { ApplicationSheet } from '../../shared/application-sheet/application-sheet';
import { ApplTypeBadge } from '../../shared/ui/appl-type-badge';
import { StarRating } from '../../shared/ui/star-rating';
import { IconComponent } from '../../shared/ui/icon';
import { StatusBadge } from '../../shared/ui/status-badge';
import { ToastService } from '../../shared/ui/toast.service';
import { Router } from '@angular/router';
import { ApplicationActions } from './application-actions.service';
import { ApplicationsService } from './applications.service';
import { RateDialog } from './rate-dialog';
import { WorkflowProgress } from '../../shared/workflow/workflow-progress';
import { CitizenApi, RevisionEntry } from '../../core/api/citizen-api.service';

@Component({
  selector: 'app-application-detail',
  imports: [RouterLink, FormsModule, DatePipe, DecimalPipe, ApplTypeBadge, StatusBadge, IconComponent, ApplicationSheet, StarRating, RateDialog, WorkflowProgress],
  templateUrl: './application-detail.html',
  styleUrl: './application-detail.scss',
})
export class ApplicationDetail {
  private readonly applicationsService = inject(ApplicationsService);
  private readonly auth = inject(AuthService);
  private readonly lookupService = inject(LookupService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  protected readonly actions = inject(ApplicationActions);

  /** Route param, bound via withComponentInputBinding. */
  readonly id = input.required<string>();

  protected readonly application = signal<Application | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly lookups = toSignal<WizardLookups | null>(this.lookupService.wizard(), { initialValue: null });
  protected readonly rating = signal(false);
  /** Snapshots kept by the server at each submission / revision (live backend only). */
  protected readonly revisions = signal<RevisionEntry[]>([]);
  private readonly citizenApi = inject(CitizenApi);

  /** Pending uploads for department document requests, keyed by fileid. */
  protected readonly requestFiles = signal<Record<number, File | undefined>>({});
  protected requestComments: Record<number, string> = {};

  protected readonly summary = computed(() => (this.application() ? toSummary(this.application()!) : null));
  protected readonly openRequests = computed(() => this.application()?.deptfiles.filter((f) => f.status === 'R') ?? []);

  constructor() {
    effect(() => {
      const id = Number(this.id());
      untracked(() => this.load(id));
    });
  }

  private load(id: number): void {
    this.loading.set(true);
    this.applicationsService.get(id, this.auth.session()?.username).subscribe({
      next: (app) => {
        this.application.set(app);
        this.loading.set(false);
        this.loadRevisions(app);
      },
      error: () => {
        this.notFound.set(true);
        this.loading.set(false);
      },
    });
  }

  private loadRevisions(app: Application): void {
    if (app.status_id === 1 && app.revision <= 1) {
      this.revisions.set([]);
      return;
    }
    this.citizenApi.revisions(app.appl_id).subscribe({
      next: (list) => this.revisions.set(list),
      error: () => this.revisions.set([]),
    });
  }

  protected revisionKind(kind: RevisionEntry['kind']): string {
    return { submitted: 'Submitted', decided: 'Decided', archived: 'Superseded by a revision' }[kind] ?? kind;
  }

  protected can = {
    revise: canRevise,
    occupancy: canApplyForOccupancy,
    renewal: canApplyForRenewal,
    delete: canDelete,
    rate: canRate,
  };

  protected levelName(a: Application): string {
    return delegationLevelName(a.delegation_level);
  }

  protected onRated(app: Application): void {
    this.application.set(app);
    this.rating.set(false);
  }

  protected stationName(a: Application): string {
    return (
      this.lookups()
        ?.fireStations.find((d) => Number(d.id) === Number(a.district))
        ?.stations.find((s) => s.id === a.fire_station_id)?.name ?? (a.fire_station_id ? String(a.fire_station_id) : '—')
    );
  }

  protected onRequestFile(req: RequestedDocument, event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const problem = validateUpload(file);
    if (problem) {
      this.toast.error(problem);
      (event.target as HTMLInputElement).value = '';
      return;
    }
    this.requestFiles.update((m) => ({ ...m, [req.fileid]: file }));
  }

  protected uploadRequested(req: RequestedDocument): void {
    const a = this.application();
    const file = this.requestFiles()[req.fileid];
    if (!a || !file) {
      this.toast.error('Choose a PDF file to upload first.');
      return;
    }
    this.applicationsService
      .uploadRequestedDocument(a.appl_id, a.owner, req.fileid, file, this.requestComments[req.fileid] ?? '')
      .subscribe({
        next: (updated) => {
          this.application.set(updated);
          this.toast.success(`${req.file_desc} uploaded and sent to the department.`);
        },
        error: (e: Error) => this.toast.error(e.message),
      });
  }

  protected async deleteDraft(): Promise<void> {
    const s = this.summary();
    if (!s) return;
    const list = await this.actions.deleteDraft(s);
    if (list) this.router.navigate(['/citizen/dashboard']);
  }
}
