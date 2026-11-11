import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom, map, switchMap } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { AccountsService, DeptUserInput, OpenTask } from '../../core/accounts/accounts.service';
import { LookupService } from '../../core/lookups/lookup.service';
import { DeptRole, District, DistrictFireStations, Region, UserAccount } from '../../core/models';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { IconComponent } from '../../shared/ui/icon';
import { Modal } from '../../shared/ui/modal';
import { ToastService } from '../../shared/ui/toast.service';

/**
 * Admin: manage department users — Add, Modify (role, fire stations), Reset Password,
 * Deactivate/Reactivate. The fire stations decide which applications an officer works on: the
 * officers of a workflow are those of each role associated with the fire station of the property.
 * Deactivating an officer with open tasks requires moving them to another officer of the same role.
 */
@Component({
  selector: 'app-dept-users',
  imports: [FormsModule, IconComponent, Modal],
  templateUrl: './dept-users.html',
  styleUrl: './accounts.scss',
})
export class DeptUsers {
  private readonly accounts = inject(AccountsService);
  private readonly lookups = inject(LookupService);
  private readonly dialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  protected readonly regions = toSignal(this.lookups.regions$, { initialValue: [] as Region[] });
  protected readonly fireStations = toSignal(this.lookups.fireStations$, { initialValue: [] as DistrictFireStations[] });
  protected readonly roles = toSignal(this.lookups.deptRoles$, { initialValue: [] as DeptRole[] });
  protected readonly districts = toSignal(this.lookups.districts$, { initialValue: [] as District[] });

  protected readonly all = signal<UserAccount[]>([]);
  protected readonly query = signal('');
  protected readonly roleFilter = signal('');
  protected readonly statusFilter = signal<'all' | 'active' | 'inactive'>('all');

  protected readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    const role = this.roleFilter();
    const status = this.statusFilter();
    return this.all()
      .filter((a) => a.portal === 'dept')
      .filter((a) => !role || String(a.role_id) === role)
      .filter((a) => status === 'all' || (status === 'active' ? a.active : !a.active))
      .filter((a) => !q || `${a.displayName} ${a.username} ${a.email} ${a.mobile}`.toLowerCase().includes(q));
  });

  /** null = closed; 'new' = add; account = modify. */
  protected readonly editing = signal<UserAccount | 'new' | null>(null);
  protected form: DeptUserInput = this.emptyForm();
  /** Stations selected in the modal. */
  protected readonly stationSet = signal<Set<number>>(new Set());
  protected readonly allStations = signal(false);
  protected readonly stationFilter = signal('');
  protected readonly expanded = signal<Set<number>>(new Set());

  /** Deactivation with open tasks (null = closed). */
  protected readonly handover = signal<{ user: UserAccount; tasks: OpenTask[]; candidates: UserAccount[] } | null>(null);
  protected handoverTo: number | null = null;
  protected readonly formError = signal<string | null>(null);
  protected readonly issued = signal<{ username: string; password: string; reason: string } | null>(null);

  constructor() {
    this.reload();
  }

  private emptyForm(): DeptUserInput {
    return { username: '', displayName: '', email: '', mobile: '', role_id: 0, district: 0, fire_station_ids: [], all_stations: false };
  }

  private reload(): void {
    this.accounts.list('dept').subscribe((list) => this.all.set(list));
  }

  protected roleName(id?: number): string {
    const r = this.roles().find((x) => x.id === id);
    return r ? `${r.code} — ${r.name}` : String(id ?? '—');
  }

  protected roleCodeOf(id?: number): string {
    return this.roles().find((x) => x.id === id)?.code ?? String(id ?? '—');
  }

  protected roleLabel(id?: number): string {
    return this.roles().find((x) => x.id === id)?.name ?? '';
  }

  protected districtName(id?: number): string {
    return id ? this.districts().find((d) => d.id === id)?.desc ?? String(id) : 'HQ / State-wide';
  }

  /** Districts with their stations, filtered by the station search. */
  protected readonly stationGroups = computed(() => {
    const q = this.stationFilter().trim().toLowerCase();
    return this.fireStations()
      .map((d) => {
        const name = this.districtName(d.id);
        const stations = d.stations.filter((s) => !q || s.name.toLowerCase().includes(q) || name.toLowerCase().includes(q));
        return { id: d.id, name, all: d.stations, stations };
      })
      .filter((g) => g.stations.length);
  });

  protected selectedIn(all: { id: number }[]): number {
    const set = this.stationSet();
    return all.filter((s) => set.has(s.id)).length;
  }

  protected toggleStation(id: number, on: boolean): void {
    const next = new Set(this.stationSet());
    if (on) next.add(id);
    else next.delete(id);
    this.stationSet.set(next);
  }

  protected toggleDistrict(all: { id: number }[], on: boolean): void {
    const next = new Set(this.stationSet());
    for (const s of all) {
      if (on) next.add(s.id);
      else next.delete(s.id);
    }
    this.stationSet.set(next);
  }

  /** Adds every station of the districts of a region (RFOs). */
  protected selectRegion(districts: number[]): void {
    const next = new Set(this.stationSet());
    for (const d of this.fireStations().filter((x) => districts.includes(x.id))) d.stations.forEach((s) => next.add(s.id));
    this.stationSet.set(next);
  }

  protected clearStations(): void {
    this.stationSet.set(new Set());
  }

  protected toggleExpanded(id: number): void {
    const next = new Set(this.expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded.set(next);
  }

  /** "All fire stations" or "Krishna (all 21) · Guntur: Guntur-I". */
  protected stationSummary(a: UserAccount): string {
    if (a.all_stations) return 'All fire stations';
    const mine = new Set(a.fire_station_ids ?? []);
    if (!mine.size) return 'None';
    const parts: string[] = [];
    for (const d of this.fireStations()) {
      const sel = d.stations.filter((s) => mine.has(s.id));
      if (!sel.length) continue;
      const name = this.districtName(d.id);
      parts.push(sel.length === d.stations.length ? `${name} (all ${sel.length})` : `${name}: ${sel.map((s) => s.name).join(', ')}`);
    }
    return parts.join(' · ');
  }

  protected get isNew(): boolean {
    return this.editing() === 'new';
  }

  private openStations(a?: UserAccount): void {
    this.stationSet.set(new Set(a?.fire_station_ids ?? []));
    this.allStations.set(!!a?.all_stations);
    this.stationFilter.set('');
    const districts = new Set<number>();
    for (const d of this.fireStations()) if (d.stations.some((s) => (a?.fire_station_ids ?? []).includes(s.id))) districts.add(d.id);
    this.expanded.set(districts);
  }

  protected openAdd(): void {
    this.form = this.emptyForm();
    this.openStations();
    this.formError.set(null);
    this.editing.set('new');
  }

  protected openEdit(a: UserAccount): void {
    this.form = {
      username: a.username,
      displayName: a.displayName,
      email: a.email,
      mobile: a.mobile,
      role_id: a.role_id ?? 0,
      district: a.district ?? 0,
    };
    this.openStations(a);
    this.formError.set(null);
    this.editing.set(a);
  }

  protected save(): void {
    const target = this.editing();
    if (!target) return;
    const input: DeptUserInput = {
      ...this.form,
      role_id: Number(this.form.role_id),
      district: Number(this.form.district) || 0,
      all_stations: this.allStations(),
      fire_station_ids: this.allStations() ? [] : [...this.stationSet()],
    };
    if (target === 'new') {
      this.accounts.createDeptUser(input).subscribe({
        next: (r) => {
          this.editing.set(null);
          this.issued.set({ username: r.account.username, password: r.temporaryPassword ?? '', reason: 'Account created' });
          this.reload();
        },
        error: (e: Error) => this.formError.set(e.message),
      });
    } else {
      const { username: _ignored, ...patch } = input;
      void _ignored;
      this.accounts.updateDeptUser(target.id, patch as DeptUserInput).subscribe({
        next: () => {
          this.editing.set(null);
          this.toast.success(`User "${target.username}" updated.`);
          this.reload();
        },
        error: (e: Error) => this.formError.set(e.message),
      });
    }
  }

  protected async resetPassword(a: UserAccount): Promise<void> {
    const ok = await this.dialog.open({
      title: 'Reset password?',
      message: `A new temporary password will be generated for "${a.displayName}" (${a.username}). Their current password stops working immediately.`,
      confirmText: 'Reset Password',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    this.accounts.setPassword(a.id).subscribe({
      next: (r) => this.issued.set({ username: r.account.username, password: r.temporaryPassword ?? '', reason: 'Password reset' }),
      error: (e: Error) => this.toast.error(e.message),
    });
  }

  protected async toggleActive(a: UserAccount): Promise<void> {
    const deactivate = a.active;
    if (deactivate) {
      const tasks = await firstValueFrom(this.accounts.openTasks(a.id));
      if (tasks.length) {
        const candidates = this.all().filter((u) => u.portal === 'dept' && u.active && u.id !== a.id && u.role_id === a.role_id);
        this.handoverTo = candidates[0]?.id ?? null;
        this.handover.set({ user: a, tasks, candidates });
        return;
      }
    }
    const ok = await this.dialog.open({
      title: deactivate ? 'Deactivate user?' : 'Reactivate user?',
      message: deactivate
        ? `"${a.displayName}" (${a.username}) will no longer be able to log in. No task is pending with this officer.`
        : `"${a.displayName}" (${a.username}) will be able to log in again. Tasks moved to other officers stay with them.`,
      confirmText: deactivate ? 'Deactivate' : 'Reactivate',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    this.accounts.setActive(a.id, !deactivate).subscribe({
      next: () => {
        this.toast.success(`User "${a.username}" ${deactivate ? 'deactivated' : 'reactivated'}.`);
        this.reload();
      },
      error: (e: Error) => this.toast.error(e.message),
    });
  }

  /** Moves the open tasks to the chosen officer, then deactivates the user. */
  protected confirmHandover(): void {
    const h = this.handover();
    if (!h || !this.handoverTo) return;
    const toId = Number(this.handoverTo);
    this.accounts
      .handOver(h.user.id, toId)
      .pipe(switchMap((r) => this.accounts.setActive(h.user.id, false).pipe(map(() => r.moved))))
      .subscribe({
        next: (moved) => {
          this.handover.set(null);
          const to = this.all().find((u) => u.id === toId)?.displayName ?? String(toId);
          this.toast.success(`${moved} task(s) moved to ${to}; "${h.user.username}" deactivated.`);
          this.reload();
        },
        error: (e: Error) => this.toast.error(e.message),
      });
  }
}
