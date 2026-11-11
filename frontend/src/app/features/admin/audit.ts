import { Component, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';
import { AdminService, AuditEntry } from './admin.service';

const ENTITY_TYPES: { id: string; label: string }[] = [
  { id: '', label: 'Everything' },
  { id: 'application', label: 'Applications' },
  { id: 'user', label: 'Accounts' },
  { id: 'status', label: 'Statuses' },
  { id: 'workflow', label: 'Workflows' },
  { id: 'rule_set', label: 'Rules & fees' },
  { id: 'sla', label: 'SLA' },
];

/**
 * Admin → Audit: who did what and when (every transaction of the portal writes an entry in the
 * same database transaction). Newest first, filtered by kind of record, record id and action.
 */
@Component({
  selector: 'app-admin-audit',
  imports: [DatePipe, IconComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div>
          <p class="page-header__eyebrow">{{ eyebrow }}</p>
          <h2>Audit</h2>
          <p>Every change made through the portal, newest first: who, when, from where, and what. Entries are kept for 3 months.</p>
        </div>
      </div>

      <div class="card filters-bar">
        <select class="select" aria-label="Kind of record" [value]="entityType()" (change)="set(entityType, $any($event.target).value)">
          @for (t of entityTypes; track t.id) {
            <option [value]="t.id">{{ t.label }}</option>
          }
        </select>
        <input class="input" aria-label="Record id" placeholder="Record id (e.g. application id)" [value]="entityId()" (change)="set(entityId, $any($event.target).value)" />
        <input class="input" aria-label="Action" placeholder="Action (e.g. workflow. or status.added)" [value]="action()" (change)="set(action, $any($event.target).value)" />
      </div>

      <section class="card">
        @if (loading()) {
          <p class="empty-state">Loading…</p>
        } @else if (!items().length) {
          <p class="empty-state">No entry matches.</p>
        } @else {
          <div class="table-scroll">
            <table class="table audit">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Summary</th></tr></thead>
              <tbody>
                @for (e of items(); track e.id) {
                  <tr>
                    <td class="nowrap">{{ e.at | date: 'dd-MMM-yyyy HH:mm:ss' }}</td>
                    <td>{{ e.actorUsername || 'system' }}<div class="field__hint">{{ e.actorPortal }}@if (e.ip) { · {{ e.ip }} }</div></td>
                    <td><code>{{ e.action }}</code></td>
                    <td class="nowrap">{{ e.entityType }} {{ e.entityId }}</td>
                    <td>{{ e.summary }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pager">
            <button type="button" class="btn btn--ghost btn--sm" [disabled]="page() === 1" (click)="page.set(page() - 1)"><app-icon name="arrow-left" size="14"></app-icon> Newer</button>
            <span class="field__hint">Page {{ page() }}</span>
            <button type="button" class="btn btn--ghost btn--sm" [disabled]="!more()" (click)="page.set(page() + 1)">Older <app-icon name="arrow-right" size="14"></app-icon></button>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .filters-bar { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
    .pager { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
    .audit code { font-size: var(--font-size-sm); }
  `,
})
export class AdminAudit {
  private readonly admin = inject(AdminService);
  private readonly toast = inject(ToastService);
  /** Read by the administrator and the DG (department portal). */
  protected readonly eyebrow = inject(AuthService).session()?.portal === 'admin' ? 'Admin' : 'Department';

  protected readonly entityTypes = ENTITY_TYPES;
  protected readonly entityType = signal('');
  protected readonly entityId = signal('');
  protected readonly action = signal('');
  protected readonly page = signal(1);
  protected readonly items = signal<AuditEntry[]>([]);
  protected readonly more = signal(false);
  protected readonly loading = signal(true);

  constructor() {
    effect(() => {
      const q = { entityType: this.entityType(), entityId: this.entityId(), action: this.action(), page: this.page() };
      untracked(() => this.load(q));
    });
  }

  protected set(which: ReturnType<typeof signal<string>>, value: string): void {
    this.page.set(1);
    which.set(value);
  }

  private load(q: Parameters<AdminService['audit']>[0]): void {
    this.loading.set(true);
    this.admin.audit(q).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.more.set(r.more);
        this.loading.set(false);
      },
      error: (e: Error) => {
        this.loading.set(false);
        this.toast.error(e.message);
      },
    });
  }
}
