import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { IconComponent } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { AdminService, StatusRow } from './admin.service';

/**
 * Admin → Statuses (decision N-4). The system statuses (1 Draft, 2 Submitted, 7 Approved,
 * 8 Returned, 9 Rejected) are fixed. In-process statuses can be added, renamed and re-ordered;
 * one that has been used is kept for the history and can only be deactivated (once no workflow
 * sets it); one that was never used can be removed.
 */
@Component({
  selector: 'app-admin-statuses',
  imports: [FormsModule, IconComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <p class="page-header__eyebrow">Admin</p>
          <h2>Statuses</h2>
          <p>The status a citizen sees while the department works on the file. Workflows choose which in-process status each stage sets.</p>
        </div>
      </div>

      <section class="card">
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Kind</th><th>Order</th><th>Used by</th><th>State</th><th></th></tr>
            </thead>
            <tbody>
              @for (s of rows(); track s.code) {
                <tr [class.is-inactive]="!s.active">
                  <td>{{ s.code }}</td>
                  <td>
                    @if (s.is_system) {
                      <strong>{{ s.desc }}</strong>
                    } @else {
                      <input class="input" [attr.aria-label]="'Name of status ' + s.code" [value]="s.desc" (change)="rename(s, $any($event.target).value)" />
                    }
                  </td>
                  <td>{{ s.is_system ? 'System' : 'In process' }}@if (s.is_pre_decision) { <span class="field__hint"> · before the decision</span> }</td>
                  <td>
                    @if (s.is_system) {
                      {{ s.sort_order }}
                    } @else {
                      <input class="input input--narrow" type="number" [attr.aria-label]="'Order of status ' + s.code" [value]="s.sort_order" (change)="reorder(s, +$any($event.target).value)" />
                    }
                  </td>
                  <td class="field__hint">{{ s.used_by.applications }} files · {{ s.used_by.history }} log entries · {{ s.used_by.workflows }} workflows</td>
                  <td>{{ s.active ? 'Active' : 'Deactivated' }}</td>
                  <td class="actions">
                    @if (!s.is_system) {
                      <button type="button" class="btn btn--ghost btn--sm" (click)="toggle(s)">{{ s.active ? 'Deactivate' : 'Reactivate' }}</button>
                      @if (!s.used_by.applications && !s.used_by.history && !s.used_by.workflows) {
                        <button type="button" class="btn btn--ghost btn--sm" (click)="remove(s)"><app-icon name="trash" size="14"></app-icon> Remove</button>
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <form class="card add" (ngSubmit)="add()">
        <h3>Add an in-process status</h3>
        <div class="form-grid">
          <div class="field">
            <label class="field__label" for="st-name">Name</label>
            <input id="st-name" class="input" name="name" [(ngModel)]="newName" placeholder="e.g. Reviewed (Legal)" />
          </div>
          <div class="field">
            <label class="field__label" for="st-order">Order</label>
            <input id="st-order" class="input" name="order" type="number" [(ngModel)]="newOrder" />
          </div>
        </div>
        <button type="submit" class="btn btn--primary"><app-icon name="plus" size="14"></app-icon> Add Status</button>
      </form>
    </div>
  `,
  styles: `
    .add { margin-top: var(--space-4); display: grid; gap: var(--space-3); }
    .input--narrow { width: 6rem; }
    .actions { display: flex; gap: var(--space-2); }
    .is-inactive td { opacity: 0.6; }
  `,
})
export class AdminStatuses {
  private readonly admin = inject(AdminService);
  private readonly toast = inject(ToastService);
  private readonly dialog = inject(ConfirmDialogService);

  protected readonly rows = signal<StatusRow[]>([]);
  protected newName = '';
  protected newOrder = 65;

  constructor() {
    this.admin.statuses().subscribe((r) => this.rows.set(r));
  }

  private apply(call: ReturnType<AdminService['statuses']>, message: string): void {
    call.subscribe({
      next: (r) => {
        this.rows.set(r);
        this.toast.success(message);
      },
      error: (e: Error) => {
        this.toast.error(e.message);
        this.admin.statuses().subscribe((r) => this.rows.set(r));
      },
    });
  }

  protected add(): void {
    if (!this.newName.trim()) return;
    this.apply(this.admin.addStatus({ desc: this.newName.trim(), sort_order: this.newOrder }), `Status "${this.newName.trim()}" added.`);
    this.newName = '';
  }

  protected rename(s: StatusRow, desc: string): void {
    if (desc.trim() && desc.trim() !== s.desc) this.apply(this.admin.updateStatus(s.code, { desc: desc.trim() }), 'Status renamed.');
  }

  protected reorder(s: StatusRow, sort_order: number): void {
    if (Number.isFinite(sort_order)) this.apply(this.admin.updateStatus(s.code, { sort_order }), 'Order saved.');
  }

  protected toggle(s: StatusRow): void {
    this.apply(this.admin.updateStatus(s.code, { active: !s.active }), s.active ? 'Status deactivated.' : 'Status reactivated.');
  }

  protected async remove(s: StatusRow): Promise<void> {
    const ok = await this.dialog.open({ title: 'Remove status?', message: `"${s.desc}" has never been used and will be removed.`, confirmText: 'Remove', cancelText: 'Cancel' });
    if (ok) this.apply(this.admin.removeStatus(s.code), 'Status removed.');
  }
}
