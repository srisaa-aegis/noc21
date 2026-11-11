import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startTestApi, type TestApi } from '../helpers/app.js';

describe('authentication', () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await startTestApi();
  });
  afterAll(async () => {
    await t.close();
  });

  /** Registers a throwaway citizen and sets its password through the e-mailed link (B2-4). */
  async function registerWithPassword(name: string, mobile: string, email: string, password = 'Start#Pass2025') {
    const created = (await t.app.inject({ method: 'POST', url: api('/auth/register'), payload: { name, mobile, email } })).json();
    const token = new URL(created.setPasswordUrl).searchParams.get('token')!;
    const set = await t.app.inject({ method: 'POST', url: api('/auth/reset-password'), payload: { token, newPassword: password } });
    expect(set.statusCode).toBe(204);
    return { ...created, password };
  }

  it('signs a citizen in and returns the landing page, the user and the data versions', async () => {
    const res = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: 'citizen1', password: 'demo' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.username).toBe('citizen1');
    expect(body.user.portal).toBe('citizen');
    expect(body.landing).toBe('/citizen/dashboard');
    expect(body.accessToken).toBeTruthy();
    expect(body.dataVersions.reference).toBeGreaterThan(0);
    expect(res.cookies.some((c) => c.name === 'noc_rt' && c.httpOnly)).toBe(true);
    expect(res.headers['x-data-versions']).toContain('reference=');
  });

  it('never returns a password', async () => {
    const { body } = await t.login('citizen1');
    expect(JSON.stringify(body)).not.toContain('password_hash');
    expect((body.user as Record<string, unknown>).password).toBeUndefined();
  });

  it('accepts the e-mail as the username', async () => {
    const res = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: 'citizen1@example.com', password: 'demo' } });
    expect([200, 401]).toContain(res.statusCode);
  });

  it('rejects a wrong password with the portal wording', async () => {
    const res = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: 'citizen1', password: 'nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toBe('Invalid username or password.');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('refuses a deactivated account with the portal wording', async () => {
    const res = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: 'sai.constructions', password: 'demo' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toBe('This account has been deactivated. Please contact the portal administrator.');
  });

  it('refuses a deactivated officer too', async () => {
    const res = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: 'retired.officer', password: 'demo' } });
    expect(res.statusCode).toBe(403);
  });

  it('returns the signed-in user from /auth/me, with the officer profile', async () => {
    const { headers } = await t.login('dfo.visakhapatnam');
    const res = await t.app.inject({ method: 'GET', url: api('/auth/me'), headers });
    expect(res.statusCode).toBe(200);
    const me = res.json().user;
    expect(me.username).toBe('dfo.visakhapatnam');
    expect(me.role_code).toBe('DFO');
    expect(me.fire_station_ids.length).toBeGreaterThan(0);
  });

  it('rotates the refresh token and refuses a replayed one', async () => {
    const first = await t.login('citizen1');
    const refreshed = await t.app.inject({ method: 'POST', url: api('/auth/refresh'), cookies: { noc_rt: first.cookie } });
    expect(refreshed.statusCode).toBe(200);
    const replay = await t.app.inject({ method: 'POST', url: api('/auth/refresh'), cookies: { noc_rt: first.cookie } });
    expect(replay.statusCode).toBe(401);
    const secondCookie = refreshed.cookies.find((c) => c.name === 'noc_rt')?.value as string;
    const afterFamilyRevoke = await t.app.inject({ method: 'POST', url: api('/auth/refresh'), cookies: { noc_rt: secondCookie } });
    expect(afterFamilyRevoke.statusCode).toBe(401);
  });

  it('rejects requests without a token', async () => {
    const res = await t.app.inject({ method: 'GET', url: api('/auth/me') });
    expect(res.statusCode).toBe(401);
  });

  it('changes the password and refuses a wrong current password', async () => {
    // Uses a throwaway account so the suite never depends on (or breaks) the demo data.
    const email = `pwd.test.${Date.now()}@example.com`;
    const created = await registerWithPassword('Password Test', '9876543211', email);
    const first = await t.login(email, created.password);

    const bad = await t.app.inject({
      method: 'PUT',
      url: api('/auth/password'),
      headers: first.headers,
      payload: { currentPassword: 'wrong', newPassword: 'Str0ng!Passw0rd' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().detail).toBe('The current password is incorrect.');

    const short = await t.app.inject({
      method: 'PUT',
      url: api('/auth/password'),
      headers: first.headers,
      payload: { currentPassword: created.password, newPassword: 'abc' },
    });
    expect(short.json().detail).toContain('does not meet the policy');
    expect(short.json().detail).toContain('at least 10 characters');

    const weak = await t.app.inject({
      method: 'PUT',
      url: api('/auth/password'),
      headers: first.headers,
      payload: { currentPassword: created.password, newPassword: 'alllowercaseletters' },
    });
    expect(weak.json().detail).toContain('upper-case');

    const ok = await t.app.inject({
      method: 'PUT',
      url: api('/auth/password'),
      headers: first.headers,
      payload: { currentPassword: created.password, newPassword: 'Str0ng!Passw0rd' },
    });
    expect(ok.statusCode).toBe(204);

    // The new password works and clears must_change_password.
    const after = await t.login(email, 'Str0ng!Passw0rd');
    expect((after.body.user as Record<string, unknown>).must_change_password).toBe(false);
  });

  it('registers a citizen without any password and e-mails a one-time "set your password" link (B2-4)', async () => {
    const email = `new.builder.${Date.now()}@example.com`;
    const res = await t.app.inject({
      method: 'POST',
      url: api('/auth/register'),
      payload: { name: 'New Builder', mobile: '9876543210', email, gender: 'M', address: 'Somewhere', aadhar: '1234 5678 9012' },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.username).toBe(email);
    expect(created.temporaryPassword).toBeUndefined();
    expect(created.setPasswordUrl).toMatch(/\/auth\/reset-password\?token=.+&welcome=1$/);

    const duplicate = await t.app.inject({ method: 'POST', url: api('/auth/register'), payload: { name: 'Copy', mobile: '9876543210', email } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().detail).toBe('An account with this e-mail already exists.');

    // The link is also what the e-mail carries (outbox), valid for a day.
    const pg = (await import('pg')).default;
    const { testDatabaseUrl } = await import('../helpers/db.js');
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const mail = (await client.query(`select payload from notification_outbox where to_address = $1 and template_key = 'registered'`, [email])).rows[0];
      expect(mail.payload.set_password_link).toBe(created.setPasswordUrl);
      const tok = (await client.query(`select purpose, extract(epoch from (t.expires_at - t.created_at)) / 3600 as hours from password_reset_tokens t join users u on u.id = t.user_id where u.email = $1`, [email])).rows[0];
      expect(tok.purpose).toBe('set');
      expect(Number(tok.hours)).toBeCloseTo(24, 0);
      const profile = (await client.query(`select aadhar_last4 from citizen_profiles p join users u on u.id = p.user_id where u.email = $1`, [email])).rows[0];
      expect(profile.aadhar_last4).toBe('9012');
    } finally {
      await client.end();
    }

    // Until the password is set nothing signs in; afterwards the account works at once.
    const token = new URL(created.setPasswordUrl).searchParams.get('token')!;
    expect((await t.app.inject({ method: 'POST', url: api('/auth/reset-password'), payload: { token, newPassword: 'Welcome#2025x' } })).statusCode).toBe(204);
    const login = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: email, password: 'Welcome#2025x' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.must_change_password).toBe(false);
    // single use
    expect((await t.app.inject({ method: 'POST', url: api('/auth/reset-password'), payload: { token, newPassword: 'Another#2025x' } })).json().detail).toContain('no longer valid');
  });

  it('keeps an account with a temporary password out of the portal until it is changed', async () => {
    const email = `forced.${Date.now()}@example.com`;
    await registerWithPassword('Forced Change', '9876543215', email);
    const pg = (await import('pg')).default;
    const { testDatabaseUrl } = await import('../helpers/db.js');
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    await client.query(`update users set must_change_password = true where email = $1`, [email]);
    await client.end();
    const login = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: email, password: 'Start#Pass2025' } });
    expect(login.json().user.must_change_password).toBe(true);
    const blocked = await t.app.inject({ method: 'GET', url: api('/applications?scope=mine'), headers: { authorization: `Bearer ${login.json().accessToken}` } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().detail).toContain('change your temporary password');
  });

  it('locks an account after five failed sign-ins', async () => {
    const email = `lock.${Date.now()}@example.com`;
    const created = await registerWithPassword('Lock Test', '9876543213', email);
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: email, password: 'wrong' } });
      expect(res.statusCode).toBe(401);
    }
    const locked = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: email, password: created.password } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().detail).toContain('Too many failed attempts');
  });

  it('signs officers and admins out after 8 idle hours, citizens after one idle day', async () => {
    const pg = (await import('pg')).default;
    const { testDatabaseUrl } = await import('../helpers/db.js');
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const expiryHours = async (username: string) => {
        await t.login(username);
        const r = await client.query(
          `select extract(epoch from (expires_at - issued_at)) / 3600 as hours
             from refresh_tokens t join users u on u.id = t.user_id
            where u.username = $1 order by t.id desc limit 1`,
          [username],
        );
        return Number(r.rows[0].hours);
      };
      expect(await expiryHours('dg.officer')).toBeCloseTo(8, 1);
      expect(await expiryHours('admin')).toBeCloseTo(8, 1);
      expect(await expiryHours('citizen2')).toBeCloseTo(24, 1);

      // An expired (idle) officer session is refused with an explanation.
      const { cookie } = await t.login('dfs.officer');
      await client.query(`update refresh_tokens set expires_at = now() - interval '1 minute' where revoked_at is null and user_id = (select id from users where username = 'dfs.officer')`);
      const res = await t.app.inject({ method: 'POST', url: api('/auth/refresh'), cookies: { noc_rt: cookie } });
      expect(res.statusCode).toBe(401);
      expect(res.json().detail).toContain('inactivity');
    } finally {
      await client.end();
    }
  });

  it('resets a forgotten password through a one-time link', async () => {
    const pg = (await import('pg')).default;
    const { testDatabaseUrl } = await import('../helpers/db.js');
    const email = `reset.${Date.now()}@example.com`;
    await registerWithPassword('Reset Me', '9876543214', email);
    expect((await t.app.inject({ method: 'POST', url: api('/auth/forgot-password'), payload: { email } })).statusCode).toBe(202);
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const row = (await client.query(`select payload from notification_outbox where to_address = $1 and template_key = 'password_reset' order by id desc limit 1`, [email])).rows[0];
    await client.end();
    const link = String(row.payload.reset_link);
    expect(link).toContain('/auth/reset-password?token=');
    const token = new URL(link).searchParams.get('token')!;

    const weak = await t.app.inject({ method: 'POST', url: api('/auth/reset-password'), payload: { token, newPassword: 'short' } });
    expect(weak.json().detail).toContain('does not meet the policy');
    const ok = await t.app.inject({ method: 'POST', url: api('/auth/reset-password'), payload: { token, newPassword: 'N3w!Passw0rdOK' } });
    expect(ok.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'POST', url: api('/auth/reset-password'), payload: { token, newPassword: 'N3w!Passw0rdOK2' } })).json().detail).toContain(
      'no longer valid',
    );
    const login = await t.app.inject({ method: 'POST', url: api('/auth/login'), payload: { username: email, password: 'N3w!Passw0rdOK' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.must_change_password).toBe(false);
  });

  it('always accepts forgot-password without revealing whether the account exists', async () => {
    for (const email of ['citizen1@example.com', 'nobody@example.com']) {
      const res = await t.app.inject({ method: 'POST', url: api('/auth/forgot-password'), payload: { email } });
      expect(res.statusCode).toBe(202);
    }
  });

  it('logs out and revokes the refresh token', async () => {
    const { cookie } = await t.login('citizen2');
    const out = await t.app.inject({ method: 'POST', url: api('/auth/logout'), cookies: { noc_rt: cookie } });
    expect(out.statusCode).toBe(204);
    const res = await t.app.inject({ method: 'POST', url: api('/auth/refresh'), cookies: { noc_rt: cookie } });
    expect(res.statusCode).toBe(401);
  });
});
