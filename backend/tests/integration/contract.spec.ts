/**
 * Contract between the portal and the API: every operation in the frontend's
 * REST catalogue (frontend/src/app/core/api/api-endpoints.ts — the one file
 * that knows the URLs the portal calls) is served by this backend, and every
 * route the backend serves is either used by the portal or is listed below as
 * server-only on purpose. A route renamed on one side fails here, not in the
 * browser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ENDPOINTS } from '../../../frontend/src/app/core/api/api-endpoints';
import { config } from '../../src/config/env.js';
import { startTestApi, type TestApi } from '../helpers/app.js';

/** Served by the API but not called through the portal's catalogue (with the reason). */
const SERVER_ONLY: Record<string, string> = {
  'GET /files/download/:token': 'the one-time link the browser opens (issued by POST /files/:id/download-token)',
  'GET /files/:id/metadata': 'file metadata for API clients (the portal gets it inside the aggregate)',
  'GET /bootstrap': 'everything an anonymous visitor needs in one call (API clients, kiosks)',
  'GET /rules/sets': 'rule-set catalogue for API clients (the portal reads the rules bundle)',
  'GET /rules/sets/:code': 'one published rule set (API clients)',
  'GET /applications/:id/summary': 'lightweight summary (API clients)',
  'GET /applications/:id/validation': 'validation issues of a stored application (API clients)',
  'GET /applications/:id/process-log': 'process log only (API clients)',
  'GET /dept/reports': 'the list of report ids (API clients)',
};

const normalise = (path: string) => path.replace(/:[A-Za-z_]+/g, ':p');
/** A route pattern as a regular expression (`:param` matches one segment). */
const pattern = (key: string) => new RegExp(`^${normalise(key).replace(/:p/g, '[^/]+')}$`);
/** A concrete request for a catalogue entry (its parameters filled in). */
const sample = (key: string) => normalise(key).replace(/:p/g, 'x1');

describe('portal ↔ API contract', () => {
  let t: TestApi;
  let served: string[];

  beforeAll(async () => {
    t = await startTestApi();
    const prefix = config().API_PREFIX;
    served = t.app.routeTable.filter((r) => r.url.startsWith(`${prefix}/`)).map((r) => `${r.method} ${normalise(r.url.slice(prefix.length))}`);
  });

  afterAll(async () => {
    await t.close();
  });

  it('serves every operation of the portal catalogue', () => {
    const missing = Object.values(API_ENDPOINTS)
      .map((e) => `${e.method} ${e.path}`)
      .filter((key) => !served.some((route) => pattern(route).test(sample(key))));
    expect(missing).toEqual([]);
  });

  it('has no route the portal does not use, except the documented server-only ones', () => {
    const calls = Object.values(API_ENDPOINTS).map((e) => sample(`${e.method} ${e.path}`));
    const allowed = new Set(Object.keys(SERVER_ONLY).map(normalise));
    const unused = served.filter((route) => !allowed.has(route) && !calls.some((c) => pattern(route).test(c))).sort();
    expect(unused).toEqual([]);
  });
});
