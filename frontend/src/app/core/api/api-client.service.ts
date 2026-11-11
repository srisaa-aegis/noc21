import { HttpClient, HttpEventType, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, filter, map, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiEndpoint } from './api-endpoints';
import { toApiError } from './http-backend.service';

export type Params = Record<string, string | number>;
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  params?: Params;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * The ONLY service in the app that performs data access. Feature services call
 * it with an entry of the central catalogue (`api-endpoints.ts`) — never with a
 * literal URL. Failures arrive as `ApiError`, whose `message` is the sentence
 * the server wrote for the user.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  /** The absolute URL of an endpoint, `:param` placeholders substituted. */
  url(endpoint: ApiEndpoint, params: Params = {}): string {
    let path = endpoint.path;
    for (const [key, value] of Object.entries(params)) path = path.replace(`:${key}`, encodeURIComponent(String(value)));
    if (/:[a-zA-Z]/.test(path)) throw new Error(`Missing parameter for ${endpoint.id}: ${path}`);
    return `${environment.apiBaseUrl}${path}`;
  }

  private httpParams(query?: Query): HttpParams | undefined {
    if (!query) return undefined;
    let p = new HttpParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return p;
  }

  request<T>(endpoint: ApiEndpoint, options: RequestOptions = {}): Observable<T> {
    const url = this.url(endpoint, options.params);
    const init = { params: this.httpParams(options.query), headers: options.headers ? new HttpHeaders(options.headers) : undefined };
    const call =
      endpoint.method === 'GET'
        ? this.http.get<T>(url, init)
        : endpoint.method === 'DELETE'
          ? this.http.delete<T>(url, { ...init, body: options.body })
          : endpoint.method === 'PUT'
            ? this.http.put<T>(url, options.body ?? {}, init)
            : this.http.post<T>(url, options.body ?? {}, init);
    return call.pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }

  get<T>(endpoint: ApiEndpoint, params?: Params, query?: Query): Observable<T> {
    return this.request<T>(endpoint, { params, query });
  }

  /** Multipart upload with progress (0-100). */
  upload<T>(endpoint: ApiEndpoint, params: Params, form: FormData, onProgress?: (percent: number) => void): Observable<T> {
    return this.http.post<T>(this.url(endpoint, params), form, { reportProgress: true, observe: 'events' }).pipe(
      catchError((e: unknown) => throwError(() => toApiError(e))),
      map((event) => {
        if (event.type === HttpEventType.UploadProgress && event.total) onProgress?.(Math.round((100 * event.loaded) / event.total));
        return event;
      }),
      filter((event) => event.type === HttpEventType.Response),
      map((event) => (event as { body: T }).body),
    );
  }

  /** A file (CSV, PDF) as a Blob — the bearer token stays in the header. */
  download(endpoint: ApiEndpoint, params?: Params, query?: Query): Observable<Blob> {
    return this.http
      .get(this.url(endpoint, params), { params: this.httpParams(query), responseType: 'blob' })
      .pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }
}
