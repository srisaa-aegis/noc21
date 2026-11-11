import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { PASSWORD_RULES, passwordProblem } from '../../core/domain/password';

/**
 * Landing page of the e-mailed links (`/auth/reset-password?token=…`): the password-reset link
 * (POST /auth/forgot-password, one hour) and the "set your password" link of a new registration
 * (`&welcome=1`, 24 hours). Sets a password that meets the policy; the token is single-use.
 */
@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, RouterLink],
  template: `
    <form class="field" (ngSubmit)="submit()" autocomplete="off">
      @if (!token) {
        <p class="msg msg--error" role="alert">This reset link is incomplete. Please use the link from the e-mail, or request a new one.</p>
        <a class="link" routerLink="/auth/forgot-password">Request a new reset link</a>
      } @else {
        @if (welcome) {
          <p class="msg msg--welcome">Welcome! Choose the password for your new account.</p>
        }
        @if (error()) { <p class="msg msg--error" role="alert">{{ error() }}</p> }
        <label class="field__label" for="rp-new">New password</label>
        <input id="rp-new" class="input" type="password" name="next" [(ngModel)]="next" autocomplete="new-password" />
        <span class="field__hint">{{ rules }}</span>
        <label class="field__label" for="rp-confirm" style="margin-top: 12px">Confirm new password</label>
        <input id="rp-confirm" class="input" type="password" name="confirm" [(ngModel)]="confirm" autocomplete="new-password" />
        <button type="submit" class="btn btn--primary btn--block" style="margin-top: 16px" [disabled]="busy()">{{ welcome ? 'Set Password' : 'Set New Password' }}</button>
      }
      <a class="link" routerLink="/auth/login">&larr; Back to Sign In</a>
    </form>
  `,
  styles: `
    .msg { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); font-size: var(--font-size-sm); margin-bottom: var(--space-3); }
    .msg--error { background: var(--status-rejected-bg); color: var(--status-rejected-fg); }
    .msg--welcome { background: var(--status-approved-bg); color: var(--status-approved-fg); }
    .link { display: block; text-align: center; margin-top: 16px; font-size: var(--font-size-sm); }
  `,
})
export class ResetPassword {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly token = this.query.get('token') ?? '';
  /** The "set your password" link of a new registration. */
  protected readonly welcome = this.query.get('welcome') === '1';
  protected readonly rules = PASSWORD_RULES;
  protected next = '';
  protected confirm = '';
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected submit(): void {
    const problem = passwordProblem(this.next, this.confirm);
    if (problem) {
      this.error.set(problem);
      return;
    }
    this.busy.set(true);
    this.auth.resetPassword(this.token, this.next).subscribe((r) => {
      this.busy.set(false);
      if (!r.success) {
        this.error.set(r.error ?? 'The password could not be reset.');
        return;
      }
      this.router.navigate(['/auth/login'], { queryParams: { reset: this.welcome ? 'welcome' : '1' } });
    });
  }
}
