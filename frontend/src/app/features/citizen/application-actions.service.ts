import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, firstValueFrom, switchMap, take } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { LookupService } from '../../core/lookups/lookup.service';
import { Application, ApplicationSummary, ApplicationType } from '../../core/models';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { ToastService } from '../../shared/ui/toast.service';
import { ApplicationsService } from './applications.service';

export type PrintDocument = 'acknowledgement' | 'receipt' | 'certificate' | 'display-certificate' | 'rejection';

/**
 * Citizen-side user actions shared by the dashboard and the detail page:
 * they combine a confirm dialog, the data operation, a toast and navigation
 * (replacing the legacy alert()/location.href pattern).
 */
@Injectable({ providedIn: 'root' })
export class ApplicationActions {
  private readonly apps = inject(ApplicationsService);
  private readonly auth = inject(AuthService);
  private readonly lookups = inject(LookupService);
  private readonly dialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  private get owner(): string {
    return this.auth.session()?.username ?? '';
  }

  editUrl(applId: number, step = 'basic'): string[] {
    return ['/citizen/applications', String(applId), 'edit', step];
  }

  printUrl(applId: number, doc: PrintDocument): string[] {
    return ['/citizen/applications', String(applId), 'print', doc];
  }

  private open(app: Application, message: string): void {
    this.toast.success(message);
    this.router.navigate(this.editUrl(app.appl_id));
  }

  private fail(e: Error): void {
    this.toast.error(e.message || 'The operation failed.');
  }

  /**
   * "Apply for …" card → instructions → a NEW unsaved application form (legacy #addpnoc etc.).
   * The application is created on its first Save (site name + address).
   */
  async start(type: ApplicationType): Promise<void> {
    const proceed = await this.dialog.open({
      title: `Apply for ${type.name}`,
      items: type.instructions ?? [],
      confirmText: 'Start Application',
      cancelText: 'Close',
    });
    if (!proceed) return;
    this.router.navigate(['/citizen/applications', 'new', 'edit', 'basic'], { queryParams: { type: type.code } });
  }

  continue(applId: number): void {
    this.router.navigate(this.editUrl(applId));
  }

  async revise(row: Pick<ApplicationSummary, 'appl_id' | 'site_name' | 'revision'>): Promise<void> {
    const ok = await this.dialog.open({
      title: 'Revise application?',
      message: `"${row.site_name}" will be reopened as revision ${row.revision + 1}. Address the department's remarks, then resubmit. The history is kept.`,
      confirmText: 'Revise',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    this.apps.revise(row.appl_id, this.owner).subscribe({ next: (app) => this.open(app, `Revision ${app.revision} opened.`), error: (e) => this.fail(e) });
  }

  async applyForOccupancy(row: Pick<ApplicationSummary, 'appl_id' | 'site_name'>): Promise<void> {
    const ok = await this.dialog.open({
      title: 'Apply for Occupancy NOC?',
      message: `A new Occupancy application will be pre-filled from the Provisional NOC of "${row.site_name}". Update anything that changed during construction.`,
      confirmText: 'Create Occupancy Application',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    this.lookups.occupancyConditions$
      .pipe(
        take(1),
        switchMap((conditions) => this.apps.createOccupancyFromProvisional(row.appl_id, this.owner, conditions)),
      )
      .subscribe({ next: (app) => this.open(app, 'Occupancy application created from your Provisional NOC.'), error: (e) => this.fail(e) });
  }

  async applyForRenewal(row: Pick<ApplicationSummary, 'appl_id' | 'site_name'>): Promise<void> {
    const ok = await this.dialog.open({
      title: 'Apply for Renewal?',
      message: `A new Renewal application will be pre-filled from the Occupancy NOC of "${row.site_name}".`,
      confirmText: 'Create Renewal Application',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    this.run(this.apps.createRenewalFromOccupancy(row.appl_id, this.owner), 'Renewal application created from your Occupancy NOC.');
  }

  private run(op: Observable<Application>, message: string): void {
    op.subscribe({ next: (app) => this.open(app, message), error: (e) => this.fail(e) });
  }

  /** Resolves with the remaining list (or null if cancelled/failed). */
  async deleteDraft(row: Pick<ApplicationSummary, 'appl_id' | 'site_name'>): Promise<ApplicationSummary[] | null> {
    const ok = await this.dialog.open({
      title: 'Delete draft application?',
      message: `"${row.site_name || 'This draft'}" will be permanently removed. This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
    });
    if (!ok) return null;
    try {
      const list = await firstValueFrom(this.apps.deleteDraft(row.appl_id, this.owner));
      this.toast.success('Draft application deleted.');
      return list;
    } catch (e) {
      this.fail(e as Error);
      return null;
    }
  }
}
