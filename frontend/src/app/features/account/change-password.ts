import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService, landingFor } from '../../core/auth/auth.service';
import { PASSWORD_RULES, passwordPolicyProblems } from '../../core/domain/password';
import { IconComponent } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';

/**
 * Self-service "Change Password" for every logged-in user — citizens (legacy changepass.aspx)
 * and department officers / administrators (legacy dept chpwd). Routed under each portal.
 */
@Component({
  selector: 'app-change-password',
  imports: [FormsModule, IconComponent],
  template: `
    <div class="page change-password">
      <div class="page-header">
        <div>
          <p class="page-header__eyebrow">My account</p>
          <h2>Change Password</h2>
          <p>Signed in as <strong>{{ auth.session()?.username }}</strong>.</p>
        </div>
      </div>
      @if (auth.mustChangePassword()) {
        <p class="msg msg--info" role="status">
          You signed in with a temporary password. Please choose your own password to continue.
        </p>
      }
      <form class="card" (ngSubmit)="submit()" autocomplete="off">
        @if (error()) { <p class="msg msg--error" role="alert">{{ error() }}</p> }
        @if (done()) { <p class="msg msg--success" role="status">Your password has been changed.</p> }
        <div class="field">
          <label class="field__label" for="cp-current">Current password</label>
          <input id="cp-current" class="input" type="password" name="current" [(ngModel)]="current" autocomplete="current-password" />
        </div>
        <div class="field">
          <label class="field__label" for="cp-new">New password</label>
          <input id="cp-new" class="input" type="password" name="next" [(ngModel)]="next" autocomplete="new-password" />
          <span class="field__hint">{{ rules }} It must differ from the current password.</span>
        </div>
        <div class="field">
          <label class="field__label" for="cp-confirm">Confirm new password</label>
          <input id="cp-confirm" class="input" type="password" name="confirm" [(ngModel)]="confirm" autocomplete="new-password" />
        </div>
        <div class="actions">
          @if (!auth.mustChangePassword()) {
            <button type="button" class="btn btn--ghost" (click)="location.back()">Cancel</button>
          } @else {
            <button type="button" class="btn btn--ghost" (click)="signOut()">Sign out</button>
          }
          <button type="submit" class="btn btn--primary" [disabled]="busy()"><app-icon name="key" size="14"></app-icon> Change Password</button>
        </div>
      </form>
    </div>
  `,
  styles: `
    .change-password .card { max-width: 460px; }
    .actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
    .msg { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--font-size-sm); }
    .msg--error { background: var(--status-rejected-bg); color: var(--status-rejected-fg); }
    .msg--success { background: var(--status-approved-bg); color: var(--status-approved-fg); }
    .msg--info { max-width: 460px; background: var(--status-pending-bg); color: var(--status-pending-fg); margin-bottom: var(--space-3); }
  `,
})
export class ChangePassword {
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  protected readonly location = inject(Location);
  private readonly router = inject(Router);
  protected readonly rules = PASSWORD_RULES;

  protected current = '';
  protected next = '';
  protected confirm = '';
  protected readonly error = signal<string | null>(null);
  protected readonly done = signal(false);
  protected readonly busy = signal(false);

  protected signOut(): void {
    this.auth.logout();
    this.router.navigate(['/auth/login']);
  }

  protected submit(): void {
    this.done.set(false);
    if (!this.current || !this.next) {
      this.error.set('Enter your current and new password.');
      return;
    }
    const session = this.auth.session();
    const problems = passwordPolicyProblems(this.next, { username: session?.username });
    if (problems.length) {
      this.error.set(`The new password does not meet the policy: ${problems.join(' ')}`);
      return;
    }
    if (this.next !== this.confirm) {
      this.error.set('The new password and its confirmation do not match.');
      return;
    }
    const wasTemporary = this.auth.mustChangePassword();
    this.busy.set(true);
    this.auth.changeOwnPassword(this.current, this.next).subscribe({
      next: () => {
        this.busy.set(false);
        this.error.set(null);
        this.done.set(true);
        this.current = this.next = this.confirm = '';
        this.toast.success('Password changed.');
        if (wasTemporary && session) this.router.navigateByUrl(landingFor(session.portal));
      },
      error: (e: Error) => {
        this.busy.set(false);
        this.error.set(e.message);
      },
    });
  }
}
