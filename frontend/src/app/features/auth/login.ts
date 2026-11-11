import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly isSubmitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  /** Notice after a completed password reset (`?reset=1`) or the first password of a new account (`?reset=welcome`). */
  protected readonly notice = ((reset: string | null) =>
    reset === 'welcome'
      ? 'Your password is set. Sign in with your e-mail address and the new password.'
      : reset
        ? 'Your password has been reset. Sign in with your new password.'
        : null)(inject(ActivatedRoute).snapshot.queryParamMap.get('reset'));

  protected readonly demoAccounts = [
    { label: 'Citizen (builder)', username: 'citizen1' },
    { label: 'Citizen 2', username: 'citizen2' },
    { label: 'Dept — DG', username: 'dg.officer' },
    { label: 'Dept — DFS', username: 'dfs.officer' },
    { label: 'Dept — Section (HQ)', username: 'section.hq' },
    { label: 'Dept — RFO (Eastern)', username: 'rfo.officer' },
    { label: 'Dept — DFO Visakhapatnam', username: 'dfo.visakhapatnam' },
    { label: 'Dept — SFO Visakhapatnam', username: 'sfo.officer' },
    { label: 'Dept — Monitoring', username: 'monitor.hq' },
    { label: 'Admin', username: 'admin' },
  ];

  protected fillDemo(username: string): void {
    this.username.set(username);
    this.password.set('demo');
  }

  protected submit(): void {
    if (!this.username().trim() || !this.password().trim()) {
      this.errorMessage.set('Please enter both a username and a password.');
      return;
    }
    this.isSubmitting.set(true);
    this.errorMessage.set(null);
    this.auth.login(this.username(), this.password()).subscribe({
      next: (result) => {
        this.isSubmitting.set(false);
        if (result.success && result.landing) {
          // A temporary password (registration / admin reset) must be replaced first.
          const target = this.auth.mustChangePassword() && result.session ? `/${result.session.portal}/change-password` : result.landing;
          this.router.navigateByUrl(target);
        } else {
          this.errorMessage.set(result.error ?? 'Login failed.');
        }
      },
      error: () => {
        this.isSubmitting.set(false);
        this.errorMessage.set('Login failed. Please try again.');
      },
    });
  }
}
