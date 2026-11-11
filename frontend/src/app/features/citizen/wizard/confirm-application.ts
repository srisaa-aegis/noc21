import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { ApplicationSheet } from '../../../shared/application-sheet/application-sheet';
import { ApplTypeBadge } from '../../../shared/ui/appl-type-badge';
import { IconComponent } from '../../../shared/ui/icon';
import { ToastService } from '../../../shared/ui/toast.service';
import { Undertaking } from '../../../core/models';
import { ApplicationDraftStore } from './application-draft.store';

const TITLES: Record<string, string> = {
  P: 'Provisional NOC',
  O: 'Occupancy NOC',
  R: 'Renewal of Occupancy NOC',
  RO: 'Renewal of Occupancy NOC',
  D: 'Declaration for Renewal',
};

/**
 * /citizen/applications/:id/confirm — legacy confirmpnoc / confirmonoc / confirmrnoc:
 * "Confirmation before Submission". The whole application on one page, the applicant's undertakings,
 * and the final Submit that numbers the application and starts the department workflow.
 */
@Component({
  selector: 'app-confirm-application',
  imports: [FormsModule, RouterLink, IconComponent, ApplTypeBadge, ApplicationSheet],
  providers: [ApplicationDraftStore],
  templateUrl: './confirm-application.html',
  styleUrl: './confirm-application.scss',
})
export class ConfirmApplication {
  protected readonly store = inject(ApplicationDraftStore);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly id = input.required<string>();

  protected readonly submitting = signal(false);
  protected ticks: boolean[] = [];

  protected readonly title = computed(() => TITLES[this.store.app()?.appl_type ?? ''] ?? 'Application');

  protected readonly undertakings = computed<Undertaking[]>(() => {
    const a = this.store.app();
    const u = this.store.lookups()?.undertakings;
    if (!a || !u) return [];
    const key = a.appl_type === 'RO' ? 'R' : a.appl_type;
    const list = u[key];
    return Array.isArray(list) ? list : [];
  });

  protected readonly allTicked = signal(false);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.store.load(id, this.auth.session()?.username ?? ''));
    });
  }

  protected onTick(): void {
    this.allTicked.set(this.undertakings().every((u, i) => !u.required || !!this.ticks[i]));
  }

  protected backToEdit(): void {
    this.router.navigate(['/citizen/applications', this.id(), 'edit', 'submit']);
  }

  protected async confirm(): Promise<void> {
    this.submitting.set(true);
    const ticked = this.undertakings().filter((_, i) => !!this.ticks[i]).map((u) => u.id);
    const r = await this.store.submit(ticked);
    this.submitting.set(false);
    if (!r.ok) {
      this.toast.error(r.error);
      return;
    }
    this.toast.success(`Application submitted. Application No. ${r.app.appl_number}.`);
    this.router.navigate(['/citizen/applications', r.app.appl_id, 'print', 'acknowledgement']);
  }
}
