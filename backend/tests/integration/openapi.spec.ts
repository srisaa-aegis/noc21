/**
 * The OpenAPI document (/docs/json) lists every API operation, grouped, with
 * the bearer requirement on everything that is not public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { testDatabaseUrl } from '../helpers/db.js';
import { startTestApi, type TestApi } from '../helpers/app.js';

describe('OpenAPI document', () => {
  let t: TestApi;
  let doc: { openapi: string; paths: Record<string, Record<string, { tags: string[]; security?: unknown[] }>> };

  beforeAll(async () => {
    t = await startTestApi();
    doc = (await t.app.inject({ method: 'GET', url: '/docs/json' })).json();
  });

  afterAll(async () => {
    await t.close();
  });

  it('describes every API route', () => {
    expect(doc.openapi).toBe('3.1.0');
    const prefix = config().API_PREFIX;
    const documented = new Set(Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)));
    const missing = t.app.routeTable
      .filter((r) => r.url.startsWith(`${prefix}/`))
      .map((r) => `${r.method} ${r.url.replace(/:([A-Za-z]+)/g, '{$1}')}`)
      .filter((k) => !documented.has(k));
    expect(missing).toEqual([]);
  });

  it('marks the protected operations and groups them', () => {
    const p = config().API_PREFIX;
    expect(doc.paths[`${p}/auth/login`].post.security).toBeUndefined();
    expect(doc.paths[`${p}/admin/statuses`].get.security).toEqual([{ bearer: [] }]);
    expect(doc.paths[`${p}/dept/tasks`].get.tags).toEqual(['Department']);
    expect(doc.paths[`${p}/dept/reports/{id}`].get.tags).toEqual(['Reports']);
  });

  it('serves Swagger UI', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('swagger');
  });

  it('is off in production unless ENABLE_DOCS says otherwise (decided after B3)', async () => {
    const prod = await buildApp({ databaseUrl: testDatabaseUrl(), logger: false, cfg: { ...config(), isProduction: true, ENABLE_DOCS: undefined } });
    await prod.ready();
    expect((await prod.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
    await prod.close();
  });
});
