import { HttpErrorResponse, HttpEvent, HttpInterceptorFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, Subject, catchError, shareReplay, switchMap, take, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SessionStore } from '../auth/session.store';
import { DataVersionBus } from './data-version.bus';

const isApiCall = (req: HttpRequest<unknown>): boolean => req.url.startsWith(environment.apiBaseUrl);
const isAuthCall = (req: HttpRequest<unknown>): boolean => req.url.includes('/auth/');

/** One refresh in flight at a time; every racing request waits for it. */
let refreshInFlight: Observable<string | null> | null = null;

function refreshOnce(store: SessionStore): Observable<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const done = new Subject<string | null>();
  refreshInFlight = done.pipe(shareReplay(1));
  void fetch(`${environment.apiBaseUrl}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => (res.ok ? ((await res.json()) as { accessToken: string }).accessToken : null))
    .catch(() => null)
    .then((token) => {
      if (token) store.setToken(token);
      else store.clear();
      done.next(token);
      done.complete();
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Attaches the access token, sends cookies, and transparently refreshes once
 * when the token has expired — replaying the original request.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiCall(req)) return next(req);
  const store = inject(SessionStore);
  const withAuth = (token: string | null): HttpRequest<unknown> =>
    token
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` }, withCredentials: true })
      : req.clone({ withCredentials: true });

  return next(withAuth(store.token())).pipe(
    catchError((error: unknown) => {
      const failed = error instanceof HttpErrorResponse ? error : null;
      if (!failed || failed.status !== 401 || isAuthCall(req)) return throwError(() => error);
      return refreshOnce(store).pipe(
        take(1),
        switchMap((token) => (token ? next(withAuth(token)) : throwError(() => error))),
      );
    }),
  );
};

/**
 * Reads `X-Data-Versions` from every response, so the app learns that
 * reference data, rules or workflow configuration changed without polling.
 */
export const dataVersionInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiCall(req)) return next(req);
  const bus = inject(DataVersionBus);
  return next(req).pipe(
    tap((event: HttpEvent<unknown>) => {
      if (event instanceof HttpResponse) {
        const header = event.headers.get('x-data-versions');
        if (header) bus.observe(header);
      }
    }),
  );
};
