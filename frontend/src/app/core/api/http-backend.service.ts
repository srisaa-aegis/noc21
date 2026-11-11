import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';

/** An API failure with the server's user-presentable message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
    readonly issues?: { field: string; message: string; step?: string; block?: number; blockStep?: string; severity?: string }[],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Low-level transport for the few calls made before / outside the catalogue
 * (session restore, cached bundles). Everything else goes through `ApiClient`.
 */
@Injectable({ providedIn: 'root' })
export class HttpBackend {
  private readonly http = inject(HttpClient);

  getPath<T>(path: string): Observable<T> {
    return this.http.get<T>(`${environment.apiBaseUrl}${path}`).pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }

  postPath<T>(path: string, body?: unknown): Observable<T> {
    return this.http.post<T>(`${environment.apiBaseUrl}${path}`, body ?? {}).pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }

  putPath<T>(path: string, body?: unknown): Observable<T> {
    return this.http.put<T>(`${environment.apiBaseUrl}${path}`, body ?? {}).pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof HttpErrorResponse) {
    const problem = (e.error ?? {}) as { detail?: string; type?: string; errors?: ApiError['issues']; requestId?: string };
    if (e.status === 0) {
      return new ApiError('The portal cannot reach the server. Please check your connection and try again.', 0, 'offline');
    }
    if (e.status === 429 && !problem.detail) {
      return new ApiError('Too many attempts. Please wait a minute and try again.', 429, 'rate-limited');
    }
    return new ApiError(
      problem.detail ?? e.message ?? 'The request could not be completed.',
      e.status,
      problem.type ?? 'internal',
      problem.errors,
      problem.requestId,
    );
  }
  return new ApiError((e as Error)?.message ?? 'Unexpected error.', 500, 'internal');
}
