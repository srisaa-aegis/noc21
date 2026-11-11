/**
 * Authorization matrix: every API route × every kind of caller (anonymous,
 * citizen, department officer, administrator). The expected access of a route
 * comes from the policy below, written from the API design (50-api-design.md
 * §50.4); a route added without a deliberate decision fails here.
 *
 * The requests use ids that do not exist and empty bodies, so an allowed
 * caller gets 400 / 404 / 422 (or 200 for reads) — anything but 401 / 403 —
 * and nothing is changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config/env.js';
import { startTestApi, type TestApi } from '../helpers/app.js';
import { reseed } from '../helpers/reseed.js';

type Caller = 'anonymous' | 'citizen' | 'dept' | 'admin';
type Access = 'public' | 'signed-in' | 'citizen' | 'staff' | 'dept' | 'admin';

const WHO: Record<Access, Caller[]> = {
  public: ['anonymous', 'citizen', 'dept', 'admin'],
  'signed-in': ['citizen', 'dept', 'admin'],
  citizen: ['citizen'],
  staff: ['dept', 'admin'],
  dept: ['dept'],
  admin: ['admin'],
};

/** Who may call a route (method + path under the API prefix, `:param` placeholders). */
function policy(method: string, path: string): Access {
  if (/^\/auth\/(login|refresh|logout|register|forgot-password|reset-password)$/.test(path)) return 'public';
  if (path.startsWith('/auth/')) return 'signed-in';
  if (/^\/(meta\/versions|bootstrap|lookups\/:name|files\/download\/:token)$/.test(path)) return 'public';
  if (path.startsWith('/rules/ffe') || /^\/rules\/(other-notes|riser-width|height-limits)$/.test(path)) return 'public';
  if (path.startsWith('/bundles/')) return 'public'; // the private bundles are checked separately below
  if (path === '/admin/officers') return 'staff';
  if (path === '/audit') return 'admin'; // and the DG (admin.spec.ts); the matrix's officer is a DFO
  if (path.startsWith('/admin/')) return 'admin';
  if (path === '/dept/tasks') return 'dept';
  if (/^\/dept\/applications\/:id\/(tasks|document-requests|dept-documents|sms|fire-station|licensing-authority)/.test(path)) return 'dept';
  if (path.startsWith('/dept/')) return 'staff';
  if (path.startsWith('/rules/sets')) return 'staff';
  if (path.startsWith('/config/')) {
    if (method !== 'GET') return path === '/config/workflows/simulate' ? 'staff' : 'admin';
    if (/^\/config\/(fees|delegation-rules|renewal-rules|statuses)$/.test(path)) return 'signed-in';
    if (/^\/config\/(workflows|forms|sla)$/.test(path)) return 'staff';
    return 'admin';
  }
  // Applications: read by anyone signed in (visibility by portal and jurisdiction);
  // the lifecycle writes are the applicant's.
  if (path === '/assessments') return 'signed-in';
  if (path.startsWith('/applications') || path.startsWith('/files/')) {
    if (method === 'GET' || path.startsWith('/files/')) return 'signed-in';
    return 'citizen';
  }
  throw new Error(`No access policy for ${method} ${path}: decide who may call it.`);
}

const SAMPLE: Record<string, string> = {
  id: '999999',
  taskNo: '1',
  docNo: '1',
  requestNo: '1',
  name: 'districts',
  bundle: 'reference',
  version: '1',
  token: 'not-a-token',
  code: 'fees',
  kind: 'noc',
  equipmentId: '1',
};

describe('authorization matrix (every route × every caller)', () => {
  let t: TestApi;
  const headers: Partial<Record<Caller, Record<string, string>>> = { anonymous: {} };
  let routes: { method: string; path: string }[];

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    headers.citizen = (await t.login('citizen1')).headers;
    headers.dept = (await t.login('dfo.visakhapatnam')).headers;
    headers.admin = (await t.login('admin')).headers;
    const prefix = config().API_PREFIX;
    routes = t.app.routeTable.filter((r) => r.url.startsWith(`${prefix}/`)).map((r) => ({ method: r.method, path: r.url.slice(prefix.length) }));
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('has an access policy for every route', () => {
    expect(routes.length).toBeGreaterThan(100);
    for (const r of routes) expect(() => policy(r.method, r.path)).not.toThrow();
  });

  it('answers 401 / 403 exactly where the policy says so', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const access = policy(r.method, r.path);
      const url = `${config().API_PREFIX}${r.path.replace(/:([A-Za-z]+)/g, (_m, p: string) => SAMPLE[p] ?? '1')}`;
      for (const who of ['anonymous', 'citizen', 'dept', 'admin'] as Caller[]) {
        if (r.path === '/auth/logout' && who !== 'anonymous') continue; // would end the session used by the next rows
        if (r.path === '/auth/refresh') continue; // its credential is the refresh cookie, not the bearer (auth.spec.ts)
        // the list's default scope is the citizen's own applications; staff ask for theirs
        const query = r.path === '/applications' && r.method === 'GET' ? { dept: '?scope=dept', admin: '?scope=all' }[who as 'dept'] ?? '' : '';
        const res = await t.app.inject({
          method: r.method as 'GET',
          url: `${url}${query}`,
          headers: headers[who],
          ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
        });
        const allowed = WHO[access].includes(who);
        const denied = res.statusCode === 401 || res.statusCode === 403;
        const expected = allowed ? 'not 401/403' : who === 'anonymous' ? '401' : '403';
        const ok = allowed ? !denied : who === 'anonymous' ? res.statusCode === 401 : res.statusCode === 403;
        if (!ok) wrong.push(`${r.method} ${r.path} as ${who}: ${res.statusCode} (expected ${expected})`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('keeps the staff bundles (workflow, directory) away from anonymous callers and citizens', async () => {
    for (const bundle of ['workflow', 'directory']) {
      const url = `${config().API_PREFIX}/bundles/${bundle}`;
      expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await t.app.inject({ method: 'GET', url, headers: headers.citizen })).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'GET', url, headers: headers.dept })).statusCode).toBe(200);
    }
  });

  it('a citizen cannot read another citizen’s application; an officer only sees his jurisdiction', async () => {
    const api = (p: string) => `${config().API_PREFIX}${p}`;
    // 109 belongs to citizen2
    expect((await t.app.inject({ method: 'GET', url: api('/applications/109'), headers: headers.citizen })).statusCode).toBe(404);
    // drafts are never visible to the department
    expect((await t.app.inject({ method: 'GET', url: api('/applications/104'), headers: headers.dept })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: api('/dept/applications/104'), headers: headers.dept })).statusCode).toBe(404);
  });
});
