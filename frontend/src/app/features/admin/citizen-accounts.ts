import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccountsService, CitizenProfilePatch } from '../../core/accounts/accounts.service';
import { isoToLegacy, legacyToIso } from '../../core/domain/dates';
import { PASSWORD_RULES, passwordProblem } from '../../core/domain/password';
import { UserAccount } from '../../core/models';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { IconComponent } from '../../shared/ui/icon';
import { Modal } from '../../shared/ui/modal';
import { ToastService } from '../../shared/ui/toast.service';

type ProfileForm = CitizenProfilePatch & { dobIso: string };

/** Admin: manage citizen login accounts — Modify, Change Password, Deactivate/Reactivate. */
@Component({
  selector: 'app-citizen-accounts',
  imports: [FormsModule, IconComponent, Modal],
  templateUrl: './citizen-accounts.html',
  styleUrl: './accounts.scss',
})
export class CitizenAccounts {
  private readonly accounts = inject(AccountsService);
  private readonly dialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);

  protected readonly rows = signal<UserAccount[]>([]);
  /** Matches on the server (the first page is listed). */
  protected readonly total = signal(0);
  protected readonly query = signal('');
  protected readonly statusFilter = signal<'all' | 'active' | 'inactive'>('all');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  // Modify
  protected readonly editing = signal<UserAccount | null>(null);
  protected form: ProfileForm = this.emptyForm();
  protected readonly formError = signal<string | null>(null);

  // Change password
  protected readonly pwdFor = signal<UserAccount | null>(null);
  protected readonly passwordRules = PASSWORD_RULES;
  protected newPassword = '';
  protected confirmPassword = '';
  protected readonly pwdError = signal<string | null>(null);

  constructor() {
    // The server searches name, username and e-mail (citizens are many: 100 000 a year).
    effect(() => {
      const q = this.query();
      const status = this.statusFilter();
      untracked(() => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.search(q, status), q ? 250 : 0);
      });
    });
  }

  private search(q: string, status: 'all' | 'active' | 'inactive'): void {
    this.accounts
      .page({ portal: 'citizen', q: q.trim() || undefined, active: status === 'all' ? undefined : status === 'active', pageSize: 100 })
      .subscribe((p) => {
        this.rows.set(p.items);
        this.total.set(p.total);
      });
  }

  private emptyForm(): ProfileForm {
    return { displayName: '', email: '', mobile: '', address: '', gender: '', dob: '', dobIso: '' };
  }

  private reload(): void {
    this.search(this.query(), this.statusFilter());
  }

  protected openEdit(a: UserAccount): void {
    this.form = {
      displayName: a.displayName,
      email: a.email,
      mobile: a.mobile,
      address: a.address ?? '',
      gender: a.gender ?? '',
      dob: a.dob ?? '',
      dobIso: legacyToIso(a.dob),
    };
    this.formError.set(null);
    this.editing.set(a);
  }

  protected saveEdit(): void {
    const a = this.editing();
    if (!a) return;
    const { dobIso, ...rest } = this.form;
    this.accounts.updateCitizen(a.id, { ...rest, dob: isoToLegacy(dobIso) }).subscribe({
      next: () => {
        this.editing.set(null);
        this.toast.success(`Account "${a.username}" updated.`);
        this.reload();
      },
      error: (e: Error) => this.formError.set(e.message),
    });
  }

  protected openPassword(a: UserAccount): void {
    this.newPassword = '';
    this.confirmPassword = '';
    this.pwdError.set(null);
    this.pwdFor.set(a);
  }

  protected savePassword(): void {
    const a = this.pwdFor();
    if (!a) return;
    const problem = passwordProblem(this.newPassword, this.confirmPassword);
    if (problem) {
      this.pwdError.set(problem);
      return;
    }
    this.accounts.setPassword(a.id, this.newPassword).subscribe({
      next: () => {
        this.pwdFor.set(null);
        this.toast.success(`Password set for "${a.username}". They will be asked to choose their own at the next sign-in.`);
      },
      error: (e: Error) => this.pwdError.set(e.message),
    });
  }

  protected async toggleActive(a: UserAccount): Promise<void> {
    const deactivate = a.active;
    const ok = await this.dialog.open({
      title: deactivate ? 'Deactivate account?' : 'Reactivate account?',
      message: deactivate
        ? `"${a.displayName}" (${a.username}) will no longer be able to log in. Their applications are kept.`
        : `"${a.displayName}" (${a.username}) will be able to log in again.`,
      confirmText: deactivate ? 'Deactivate' : 'Reactivate',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    this.accounts.setActive(a.id, !deactivate).subscribe({
      next: () => {
        this.toast.success(`Account "${a.username}" ${deactivate ? 'deactivated' : 'reactivated'}.`);
        this.reload();
      },
      error: (e: Error) => this.toast.error(e.message),
    });
  }
}
