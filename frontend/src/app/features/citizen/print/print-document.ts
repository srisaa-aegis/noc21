import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { delegationLevelName } from '../../../core/domain/application-rules';
import { LookupService, WizardLookups } from '../../../core/lookups/lookup.service';
import { Application } from '../../../core/models';
import { DeclarationLetter } from '../../../shared/certificates/declaration-letter';
import { NocOccupancy } from '../../../shared/certificates/noc-occupancy';
import { NocProvisional } from '../../../shared/certificates/noc-provisional';
import { NocRenewal } from '../../../shared/certificates/noc-renewal';
import { OccupancyCertificate } from '../../../shared/certificates/occupancy-certificate';
import { RejectionLetter } from '../../../shared/certificates/rejection-letter';
import { IconComponent } from '../../../shared/ui/icon';
import { ApplicationsService } from '../applications.service';
import { PrintDocument as DocKind } from '../application-actions.service';

const TITLES: Record<DocKind, string> = {
  acknowledgement: 'Acknowledgement',
  receipt: 'Payment Receipt',
  certificate: 'No Objection Certificate',
  'display-certificate': 'Certificate for Display',
  rejection: 'Rejection / Return Letter',
};

const NOC_TITLES: Record<string, string> = {
  P: 'Provisional Fire No Objection Certificate',
  O: 'No Objection Certificate for Occupancy',
  R: 'Annual Periodical Renewal Fire Certificate',
  RO: 'Annual Periodical Renewal Fire Certificate',
  D: 'Acceptance of Self-Declaration for Renewal of Fire NOC',
};

/**
 * /citizen/applications/:id/print/:doc — printable documents. The legal formats (NOCs, renewal
 * certificate, rejection letter) are the shared certificate components that reproduce the legacy
 * final_noc_16 / final_noc_o / final_noc_r / rejection / OccCert pages.
 */
@Component({
  selector: 'app-print-document',
  imports: [RouterLink, IconComponent, DecimalPipe, NocProvisional, NocOccupancy, NocRenewal, RejectionLetter, OccupancyCertificate, DeclarationLetter],
  templateUrl: './print-document.html',
  styleUrl: './print-document.scss',
})
export class PrintDocument {
  private readonly applications = inject(ApplicationsService);
  private readonly auth = inject(AuthService);
  private readonly lookupService = inject(LookupService);

  readonly id = input.required<string>();
  readonly doc = input.required<string>();

  protected readonly app = signal<Application | null>(null);
  protected readonly parent = signal<Application | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly lookups = toSignal<WizardLookups | null>(this.lookupService.wizard(), { initialValue: null });
  protected readonly today = new Date();

  protected readonly kind = computed(() => this.doc() as DocKind);
  protected readonly title = computed(() => TITLES[this.kind()] ?? 'Document');
  protected readonly nocTitle = computed(() => NOC_TITLES[this.app()?.appl_type ?? 'P']);
  protected readonly levelName = computed(() => delegationLevelName(this.app()?.delegation_level ?? 'DFO'));

  /** Why the document cannot be shown for the current state (null = available). */
  protected readonly unavailable = computed<string | null>(() => {
    const a = this.app();
    if (!a) return null;
    switch (this.kind()) {
      case 'acknowledgement':
        return a.status_id > 1 ? null : 'An acknowledgement is issued once the application is submitted.';
      case 'receipt':
        return a.payment.status === 'paid' ? null : 'No payment has been made for this application yet.';
      case 'certificate':
        return a.status_id === 7 ? null : 'The NOC is available only after the application is approved.';
      case 'display-certificate':
        return a.status_id === 7 && a.appl_type !== 'P' && a.appl_type !== 'D' ? null : 'The display certificate is issued with an Occupancy NOC or its renewal.';
      case 'rejection':
        return a.status_id === 8 || a.status_id === 9 ? null : 'This application has not been returned or rejected.';
      default:
        return 'Unknown document.';
    }
  });

  constructor() {
    effect(() => {
      const id = Number(this.id());
      untracked(() => this.load(id));
    });
  }

  private load(id: number): void {
    const owner = this.auth.session()?.username;
    this.applications.get(id, owner).subscribe({
      next: (a) => {
        this.app.set(a);
        if (a.parent_id) {
          this.applications
            .get(a.parent_id, owner)
            .pipe(catchError(() => of(null)))
            .subscribe((p) => this.parent.set(p));
        }
      },
      error: (e: Error) => this.error.set(e.message),
    });
  }

  protected stationName(): string {
    const a = this.app();
    return this.lookups()?.fireStations.find((d) => d.id === Number(a?.district))?.stations.find((s) => s.id === a?.fire_station_id)?.name ?? '—';
  }

  protected print(): void {
    window.print();
  }
}
