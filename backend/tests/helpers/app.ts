/**
 * Builds the API against the test database and drives it with `app.inject()`
 * (no socket, no port). One instance per test file.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { testDatabaseUrl } from './db.js';

export interface TestApi {
  app: FastifyInstance;
  /** Log in and return a bearer header plus the refresh cookie. */
  login(username: string, password?: string): Promise<{ headers: Record<string, string>; cookie: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function startTestApi(): Promise<TestApi> {
  const app = await buildApp({ databaseUrl: testDatabaseUrl(), logger: false });
  await app.ready();
  return {
    app,
    async login(username: string, password = config().SEED_DEMO_PASSWORD) {
      const res = await app.inject({ method: 'POST', url: `${config().API_PREFIX}/auth/login`, payload: { username, password } });
      if (res.statusCode !== 200) throw new Error(`login failed for ${username}: ${res.statusCode} ${res.body}`);
      const body = res.json() as Record<string, unknown>;
      const cookie = (res.cookies.find((c) => c.name === 'noc_rt')?.value ?? '') as string;
      return { headers: { authorization: `Bearer ${body.accessToken as string}` }, cookie, body };
    },
    async close() {
      await app.close();
    },
  };
}

export const api = (path: string): string => `${config().API_PREFIX}${path}`;
