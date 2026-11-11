import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { LookupService } from '../../core/lookups/lookup.service';
import { ApplicationSummary, ApplicationType, ApplicationTypeCode } from '../../core/models';
import { ApplTypeBadge } from '../../shared/ui/appl-type-badge';
import { StarRating } from '../../shared/ui/star-rating';
import { IconComponent } from '../../shared/ui/icon';
import { StatusBadge } from '../../shared/ui/status-badge';
import { ToastService } from '../../shared/ui/toast.service';
import { ApplicationActions } from './application-actions.service';
import { applicationListFilter, ApplicationsService } from './applications.service';
import { RateDialog } from './rate-dialog';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, ApplTypeBadge, StatusBadge, IconComponent, StarRating, RateDialog],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly applicationsService = inject(ApplicationsService);
  private readonly lookups = inject(LookupService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  protected readonly actions = inject(ApplicationActions);

  protected readonly applicationTypes = toSignal(this.lookups.applicationTypes$, {
    initialValue: [] as ApplicationType[],
  });

  protected readonly applications = signal<ApplicationSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly typeFilter = signal<ApplicationTypeCode | ''>('');
  protected readonly statusFilter = signal<number | ''>('');

  protected readonly filtered = computed(() =>
    applicationListFilter(this.applications(), {
      type: this.typeFilter() || undefined,
      statusId: this.statusFilter() === '' ? undefined : Number(this.statusFilter()),
    }),
  );

  /** Application being rated (legacy Feedback modal). */
  protected readonly rateTarget = signal<ApplicationSummary | null>(null);

  protected readonly summary = computed(() => this.applicationsService.summarize(this.applications()));

  constructor() {
    this.loadApplications();
  }

  private loadApplications(): void {
    this.loading.set(true);
    this.applicationsService.listMine(this.auth.session()?.username ?? '').subscribe({
      next: (list) => {
        this.applications.set(list);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Could not load your applications.');
      },
    });
  }

  protected canApplyForOccupancy = (row: ApplicationSummary): boolean => this.applicationsService.canApplyForOccupancy(row);
  protected canApplyForRenewal = (row: ApplicationSummary): boolean => this.applicationsService.canApplyForRenewal(row);
  protected canRevise = (row: ApplicationSummary): boolean => this.applicationsService.canRevise(row);
  protected canDelete = (row: ApplicationSummary): boolean => this.applicationsService.canDelete(row);
  protected canRate = (row: ApplicationSummary): boolean => this.applicationsService.canRate(row);

  protected onRated(): void {
    this.rateTarget.set(null);
    this.loadApplications();
  }

  protected async deleteDraft(row: ApplicationSummary): Promise<void> {
    const list = await this.actions.deleteDraft(row);
    if (list) {
      this.applications.set(list);
    }
  }
}
