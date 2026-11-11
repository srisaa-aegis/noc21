import { Injectable, computed, inject } from '@angular/core';
import { Observable, catchError, firstValueFrom, map, of, switchMap, tap } from 'rxjs';
import { ApiClient } from '../api/api-client.service';
import { API_ENDPOINTS } from '../api/api-endpoints';
import { HttpBackend, toApiError } from '../api/http-backend.service';
import { LoginResult, RegistrationRequest, RegistrationResult, Session, UserAccount } from '../models';
import { SessionStore } from './session.store';

const SESSION_KEY = 'noc.session';

export function landingFor(portal: Session['portal']): string {
  switch (portal) {
    case 'citizen':
      return '/citizen/dashboard';
    case 'dept':
      return '/dept/dashboard';
    case 'admin':
      return '/admin/dashboard';
  }
}

interface AuthResponse {
  user: UserAccount & { role_code?: string };
  accessToken: string;
  expiresIn: number;
  landing: string;
  dataVersions: Record<string, number>;
}

/**
 * Authentication against the NOC backend: a short-lived access token held in
 * memory plus an httpOnly refresh cookie, restored silently at application start.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiClient);
  private readonly backend = inject(HttpBackend);
  private readonly store = inject(SessionStore);

  readonly session = this.store.session.asReadonly();
  readonly isAuthenticated = computed(() => this.store.session() !== null);
  readonly mustChangePassword = this.store.mustChangePassword.asReadonly();
  private currentUserAccount: UserAccount | null = null;

  private adopt(res: AuthResponse): Session {
    const session: Session = {
      username: res.user.username,
      displayName: res.user.displayName,
      portal: res.user.portal,
      role_id: res.user.role_id,
      loggedInAt: new Date().toISOString(),
    };
    this.store.set(session, res.accessToken);
    this.store.mustChangePassword.set(!!res.user.must_change_password);
    this.currentUserAccount = { ...res.user };
    return session;
  }

  /** Called once at application start: re-establishes the session from the refresh cookie. */
  async restore(): Promise<void> {
    try {
      const res = await firstValueFrom(this.backend.postPath<AuthResponse>('/auth/refresh'));
      this.adopt(res);
    } catch {
      this.store.clear();
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  /** Used by the HTTP interceptor. */
  accessToken(): string | null {
    return this.store.token();
  }

  refreshToken(): Observable<string | null> {
    return this.backend.postPath<AuthResponse>('/auth/refresh').pipe(
      map((res) => {
        this.adopt(res);
        return res.accessToken;
      }),
      catchError(() => {
        this.store.clear();
        return of(null);
      }),
    );
  }

  login(username: string, password: string): Observable<LoginResult> {
    return this.api.request<AuthResponse>(API_ENDPOINTS.authLogin, { body: { username: username.trim(), password } }).pipe(
      map((res) => {
        const session = this.adopt(res);
        return { success: true, landing: res.landing || landingFor(session.portal), session } satisfies LoginResult;
      }),
      catchError((e: unknown) => of({ success: false, error: toApiError(e).message } satisfies LoginResult)),
    );
  }

  /** Full account record of the signed-in user (for pre-filling forms). */
  currentAccount(): Observable<UserAccount | undefined> {
    if (this.currentUserAccount) return of(this.currentUserAccount);
    return this.api.get<{ user: UserAccount }>(API_ENDPOINTS.authMe).pipe(
      map((r) => {
        this.currentUserAccount = { ...r.user };
        return this.currentUserAccount;
      }),
      catchError(() => of(undefined)),
    );
  }

  /** Citizen self-registration: a "set your password" link is e-mailed (B2-4). */
  register(req: RegistrationRequest): Observable<RegistrationResult> {
    return this.api
      .request<{ username: string; setPasswordUrl?: string }>(API_ENDPOINTS.authRegister, {
        body: { name: req.name, mobile: req.mobile, email: req.email, gender: req.gender, dob: req.dob, aadhar: req.aadhar, address: req.address },
      })
      .pipe(
        map((r) => ({ success: true, username: r.username, setPasswordUrl: r.setPasswordUrl }) satisfies RegistrationResult),
        catchError((e: unknown) => of({ success: false, error: toApiError(e).message } satisfies RegistrationResult)),
      );
  }

  forgotPassword(email: string): Observable<LoginResult> {
    return this.api.request(API_ENDPOINTS.authForgotPassword, { body: { email: email.trim() } }).pipe(
      map(() => ({ success: true }) satisfies LoginResult),
      catchError((e: unknown) => of({ success: false, error: toApiError(e).message } satisfies LoginResult)),
    );
  }

  /** Completes a reset (or a first "set your password") from the e-mailed link. */
  resetPassword(token: string, newPassword: string): Observable<LoginResult> {
    return this.api.request(API_ENDPOINTS.authResetPassword, { body: { token, newPassword } }).pipe(
      map(() => ({ success: true }) satisfies LoginResult),
      catchError((e: unknown) => of({ success: false, error: toApiError(e).message } satisfies LoginResult)),
    );
  }

  changeOwnPassword(currentPassword: string, newPassword: string): Observable<void> {
    // The access token carries the "must change password" flag, so fetch a fresh one afterwards.
    return this.api.request<void>(API_ENDPOINTS.authChangePassword, { body: { currentPassword, newPassword } }).pipe(
      tap(() => this.store.mustChangePassword.set(false)),
      switchMap(() => this.refreshToken()),
      map(() => undefined),
    );
  }

  logout(): void {
    this.api.request(API_ENDPOINTS.authLogout).subscribe({ next: () => undefined, error: () => undefined });
    this.currentUserAccount = null;
    this.store.clear();
  }
}
