import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { LookupService } from '../../core/lookups/lookup.service';
import { ApplicationType } from '../../core/models';
import { ApplTypeBadge } from '../../shared/ui/appl-type-badge';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { IconComponent } from '../../shared/ui/icon';
import { StatusBadge } from '../../shared/ui/status-badge';
import { ToastService } from '../../shared/ui/toast.service';
import { AdminSearchQuery, AdminSearchRow, AdminService } from './admin.service';

/**
 * Admin "Search & Delete" — replaces the legacy stale draft-files grid
 * (draftfiles.htm + deleteOldFiles.aspx) with a filterable search over every
 * application and single/bulk deletion of **drafts that were never submitted**
 * (a submitted application is never deleted — decided after B3; the server enforces it).
 */
@Component({
  selector: 'app-admin-applications',
  imports: [FormsModule, ApplTypeBadge, StatusBadge, IconComponent],
  templateUrl: './applications.html',
  styleUrl: './applications.scss',
})
export class AdminApplications {
  private readonly adminService = inject(AdminService);
  private readonly lookups = inject(LookupService);
  private readonly dialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  protected readonly applicationTypes = toSignal(this.lookups.applicationTypes$, { initialValue: [] as ApplicationType[] });

  protected text = '';
  protected type = '';
  protected status = '';
  protected draftsOnly = false;
  protected staleDays: number | null = null;

  protected readonly results = signal<AdminSearchRow[]>([]);
  /** Matches on the server (the first 100 are listed). */
  protected readonly total = signal(0);
  protected readonly searched = signal(false);
  protected readonly loading = signal(false);
  protected readonly selected = signal<Set<number>>(new Set());

  /** Drafts that were never submitted — the only applications that can be deleted. */
  protected deletable(row: AdminSearchRow): boolean {
    return row.status_id === 1 && !row.appl_number;
  }

  protected readonly deletableRows = computed(() => this.results().filter((r) => this.deletable(r)));

  protected readonly allSelected = computed(
    () => this.deletableRows().length > 0 && this.deletableRows().every((r) => this.selected().has(r.appl_id)),
  );

  constructor() {
    this.search();
  }

  protected presetStaleDrafts(): void {
    this.text = '';
    this.type = '';
    this.status = '';
    this.draftsOnly = true;
    this.staleDays = 180;
    this.search();
  }

  protected clear(): void {
    this.text = '';
    this.type = '';
    this.status = '';
    this.draftsOnly = false;
    this.staleDays = null;
    this.search();
  }

  protected search(): void {
    const query: AdminSearchQuery = {
      text: this.text || undefined,
      type: this.type || undefined,
      statusId: this.status ? Number(this.status) : null,
      draftsOnly: this.draftsOnly,
      staleDays: this.staleDays != null && String(this.staleDays) !== '' ? Number(this.staleDays) : null,
    };
    this.loading.set(true);
    this.adminService.search(query).subscribe(({ items: rows, total }) => {
      this.results.set(rows);
      this.total.set(total);
      this.selected.set(new Set());
      this.searched.set(true);
      this.loading.set(false);
    });
  }

  protected toggle(id: number): void {
    const next = new Set(this.selected());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.selected.set(next);
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.deletableRows().map((r) => r.appl_id)));
  }

  protected deleteOne(row: AdminSearchRow): Promise<void> {
    return this.confirmAndDelete([row]);
  }

  protected deleteSelected(): Promise<void> {
    return this.confirmAndDelete(this.deletableRows().filter((r) => this.selected().has(r.appl_id)));
  }

  private async confirmAndDelete(rows: AdminSearchRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const confirmed = await this.dialog.open({
      title: rows.length === 1 ? 'Delete application?' : `Delete ${rows.length} applications?`,
      message:
        (rows.length === 1
          ? `The draft "${rows[0].site_name}" (#${rows[0].appl_id}) will be permanently deleted.`
          : `${rows.length} drafts will be permanently deleted.`) + ' This cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
    });
    if (!confirmed) {
      return;
    }
    this.adminService.deleteApplications(rows.map((r) => r.appl_id)).subscribe({
      next: (count) => {
        this.toast.success(`${count} draft(s) deleted.`);
        this.search();
      },
      error: (e: Error) => this.toast.error(e.message),
    });
  }
}
