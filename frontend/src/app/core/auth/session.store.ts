import { Injectable, signal } from '@angular/core';
import { Session } from '../models';

const SESSION_KEY = 'noc.session';

/**
 * Holds the access token **in memory only** (never in localStorage, so an XSS
 * cannot steal a long-lived credential) and a small, non-sensitive session
 * descriptor in sessionStorage so a reload can render the shell before the
 * silent refresh completes.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private accessToken: string | null = null;
  readonly session = signal<Session | null>(this.restore());
  readonly mustChangePassword = signal(false);

  private restore(): Session | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  }

  token(): string | null {
    return this.accessToken;
  }

  set(session: Session | null, token: string | null): void {
    this.accessToken = token;
    this.session.set(session);
    try {
      if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* best effort */
    }
  }

  setToken(token: string | null): void {
    this.accessToken = token;
  }

  clear(): void {
    this.set(null, null);
    this.mustChangePassword.set(false);
  }
}
