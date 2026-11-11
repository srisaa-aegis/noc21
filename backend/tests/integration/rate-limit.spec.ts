/**
 * Rate limits (per client address, per minute): a small budget for sign-in and
 * the anonymous account operations (register, forgot / reset password), a
 * general one for everything else. The suites run with relaxed limits; this one
 * builds the API with small numbers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { testDatabaseUrl } from '../helpers/db.js';

describe('rate limits', () => {
  let app: FastifyInstance;
  const url = (p: string) => `${config().API_PREFIX}${p}`;

  beforeAll(async () => {
    app = await buildApp({ databaseUrl: testDatabaseUrl(), logger: false, limits: { global: 12, auth: 3 } });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows a few sign-in attempts per minute and address, then answers 429 with Retry-After', async () => {
    const attempt = (ip: string) =>
      app.inject({ method: 'POST', url: url('/auth/login'), remoteAddress: ip, payload: { username: 'nobody', password: 'wrong' } });
    for (let i = 0; i < 3; i++) expect((await attempt('10.0.0.1')).statusCode).toBe(401);
    const blocked = await attempt('10.0.0.1');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // another address is not affected
    expect((await attempt('10.0.0.2')).statusCode).toBe(401);
  });

  it('limits registration and the password-reset requests the same way (mail flooding)', async () => {
    const forgot = () => app.inject({ method: 'POST', url: url('/auth/forgot-password'), remoteAddress: '10.0.0.3', payload: { email: 'x@example.com' } });
    for (let i = 0; i < 3; i++) expect((await forgot()).statusCode).toBe(202);
    expect((await forgot()).statusCode).toBe(429);
  });

  it('applies the general limit to every other request', async () => {
    const read = () => app.inject({ method: 'GET', url: url('/meta/versions'), remoteAddress: '10.0.0.4' });
    for (let i = 0; i < 12; i++) expect((await read()).statusCode).toBe(200);
    const res = await read();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual(expect.objectContaining({ status: 429 }));
  });
});
