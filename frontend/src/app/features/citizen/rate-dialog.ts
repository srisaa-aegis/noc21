import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { Application, Feedback } from '../../core/models';
import { Modal } from '../../shared/ui/modal';
import { StarRating } from '../../shared/ui/star-rating';
import { ToastService } from '../../shared/ui/toast.service';
import { ApplicationsService } from './applications.service';

/** Legacy "Feedback Form" (citizenlist.html #feedback → savefeedback.aspx): 1–5 stars and a description. */
@Component({
  selector: 'app-rate-dialog',
  imports: [FormsModule, Modal, StarRating],
  template: `
    <app-modal [open]="open()" title="Rate our service" (closed)="closed.emit()">
      <p>How was your experience with <strong>{{ siteName() }}</strong>{{ applNumber() ? ' (' + applNumber() + ')' : '' }}?</p>
      @if (error()) { <p class="field__error" role="alert">{{ error() }}</p> }
      <div class="field">
        <span class="field__label">Rating</span>
        <app-star-rating [(value)]="rating" label="Service rating"></app-star-rating>
      </div>
      <div class="field">
        <label class="field__label" for="fb-remarks">Description</label>
        <textarea id="fb-remarks" class="textarea" [(ngModel)]="remarks" placeholder="Tell us what went well or what could be improved"></textarea>
      </div>
      <div modal-footer>
        <button type="button" class="btn btn--ghost" (click)="closed.emit()">Close</button>
        <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="submit()">Submit</button>
      </div>
    </app-modal>
  `,
})
export class RateDialog {
  private readonly applications = inject(ApplicationsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  readonly open = input(false);
  readonly applId = input.required<number>();
  readonly siteName = input('');
  readonly applNumber = input('');
  readonly existing = input<Feedback | undefined>(undefined);
  readonly closed = output<void>();
  readonly saved = output<Application>();

  protected rating = 0;
  protected remarks = '';
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      if (this.open()) {
        const f = this.existing();
        untracked(() => {
          this.rating = f?.rating ?? 0;
          this.remarks = f?.remarks ?? '';
          this.error.set(null);
        });
      }
    });
  }

  protected submit(): void {
    this.busy.set(true);
    this.applications.saveFeedback(this.applId(), this.auth.session()?.username ?? '', this.rating, this.remarks).subscribe({
      next: (app) => {
        this.busy.set(false);
        this.toast.success('Thank you for your feedback.');
        this.saved.emit(app);
      },
      error: (e: Error) => {
        this.busy.set(false);
        this.error.set(e.message);
      },
    });
  }
}
