/**
 * Administration (B3): officers and citizens, passwords set by the admin,
 * deactivation with the hand-over of open tasks, unassigned tasks, deleting
 * applications, and the configurable statuses (N-4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startTestApi, type TestApi } from '../helpers/app.js';
import { testDatabaseUrl } from '../helpers/db.js';
import { caller, submittedApplication, type Who } from '../helpers/journey.js';
import { reseed } from '../helpers/reseed.js';

describe('administration', () => {
  let t: TestApi;
  let call: ReturnType<typeof caller>;
  let admin: Who;
  let db: pg.Client;

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    call = caller(t);
    admin = await t.login('admin');
    db = new pg.Client({ connectionString: testDatabaseUrl() });
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db.end();
    await t.close();
  });

  describe('officers', () => {
    let id = 0;
    let temporary = '';

    it('creates an officer with a temporary password that must be changed at first sign-in', async () => {
      const res = await call('POST', '/admin/accounts/dept', admin, {
        username: 'sfo.test',
        displayName: 'SFO - Test Station',
        email: 'sfo.test@firedept.example.gov',
        mobile: '9440001234',
        role_id: 9,
        fire_station_ids: [62],
      });
      expect(res.statusCode, res.body).toBe(201);
      ({ account: { id }, temporaryPassword: temporary } = res.json());
      expect(temporary).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12}$/);
      const login = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'sfo.test', password: temporary } });
      expect(login.json().user).toMatchObject({ must_change_password: true, role_id: 9, fire_station_ids: [62] });
      // the directory (and with it the assignment of new tasks) knows him at once
      const officers = (await call('GET', '/admin/officers', admin)).json();
      expect(officers.some((o: { username: string }) => o.username === 'sfo.test')).toBe(true);
    });

    it('validates the officer', async () => {
      const dup = await call('POST', '/admin/accounts/dept', admin, { username: 'sfo.test', displayName: 'x y', email: 'a@b.co', mobile: '9440001235', role_id: 9, fire_station_ids: [62] });
      expect(dup.json().detail).toBe('This username is already taken.');
      const noStation = await call('POST', '/admin/accounts/dept', admin, { username: 'sfo.test2', displayName: 'SFO 2', email: 'a2@b.co', mobile: '9440001235', role_id: 9 });
      expect(noStation.json().detail).toBe('Associate the officer with at least one fire station (or with all fire stations).');
      const officer = await t.login('dg.officer');
      expect((await call('POST', '/admin/accounts/dept', officer, {})).statusCode).toBe(403);
    });

    it('updates the officer (role, stations)', async () => {
      const res = await call('PUT', `/admin/accounts/${id}/dept`, admin, {
        displayName: 'SFO - Test Station (2)',
        email: 'sfo.test@firedept.example.gov',
        mobile: '9440001234',
        role_id: 9,
        fire_station_ids: [62, 64],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().account).toMatchObject({ displayName: 'SFO - Test Station (2)', fire_station_ids: [62, 64] });
    });

    it('resets a password: a new temporary one, every session signed out', async () => {
      const res = await call('POST', `/admin/accounts/${id}/password`, admin, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().temporaryPassword).toBeTruthy();
      expect(res.json().temporaryPassword).not.toBe(temporary);
      const old = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'sfo.test', password: temporary } });
      expect(old.statusCode).toBe(401);
    });
  });

  describe('deactivation and hand-over', () => {
    it('refuses to deactivate an officer with open tasks, hands them over, then deactivates', async () => {
      const citizen = await t.login('citizen1');
      await submittedApplication(t, citizen, { name: 'Handover Towers' });
      const sfo = (await db.query(`select id from users where username = 'sfo.officer'`)).rows[0].id;
      const krishna = (await db.query(`select id from users where username = 'sfo.krishna'`)).rows[0].id;
      const open = (await call('GET', `/admin/accounts/${sfo}/open-tasks`, admin)).json().items;
      expect(open.length).toBeGreaterThan(0);
      const refused = await call('PUT', `/admin/accounts/${sfo}/active`, admin, { active: false });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().detail).toMatch(/has \d+ open tasks?\. Hand them over/);
      const wrongRole = await call('POST', `/admin/accounts/${sfo}/handover`, admin, { to: (await db.query(`select id from users where username = 'dfo.guntur'`)).rows[0].id });
      expect(wrongRole.json().detail).toBe('Tasks can only be handed over to an officer of the same role.');
      const moved = await call('POST', `/admin/accounts/${sfo}/handover`, admin, { to: krishna });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().moved).toBe(open.length);
      expect((await call('GET', `/admin/accounts/${sfo}/open-tasks`, admin)).json().items).toEqual([]);
      const done = await call('PUT', `/admin/accounts/${sfo}/active`, admin, { active: false });
      expect(done.statusCode).toBe(200);
      expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'sfo.officer', password: 'demo' } })).statusCode).toBe(403);
      await call('PUT', `/admin/accounts/${sfo}/active`, admin, { active: true });
    }, 60_000);
  });

  describe('unassigned tasks (Q-59)', () => {
    it('lists tasks nobody could be found for and lets the admin assign them', async () => {
      // nobody holds the SFO role at station 44 (Tekkali): a file there gets an unassigned committee task
      const citizen = await t.login('citizen1');
      const srikakulam = (await db.query(`select district_id from fire_stations where id = 44`)).rows[0].district_id;
      const { id } = await submittedApplication(t, citizen, { name: 'Unassigned Towers', overrides: { district: srikakulam, fire_station_id: 44 } as never });
      const list = (await call('GET', '/admin/unassigned-tasks', admin)).json().items as { appl_id: number; task: { task_id: number; name: string }; candidates: { id: number; username: string }[] }[];
      const mine = list.find((x) => x.appl_id === id)!;
      expect(mine.task.name).toBe('Committee Member Concurrence');
      expect(mine.candidates.length).toBeGreaterThan(0);
      const res = await call('POST', `/admin/applications/${id}/tasks/${mine.task.task_id}/reassign`, admin, { to: mine.candidates[0].id });
      expect(res.statusCode, res.body).toBe(200);
      expect((await call('GET', '/admin/unassigned-tasks', admin)).json().items.some((x: { appl_id: number }) => x.appl_id === id)).toBe(false);
    }, 60_000);
  });

  describe('applications', () => {
    it('never deletes a submitted application (decided after B3) — nothing is deleted when one is in the list', async () => {
      const res = await call('DELETE', '/admin/applications', admin, { ids: [112, 101] });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('Submitted applications cannot be deleted');
      expect((await call('GET', '/applications/112', admin)).statusCode).toBe(200);
      expect((await call('GET', '/applications/101', admin)).statusCode).toBe(200);
    });

    it('deletes drafts (soft)', async () => {
      const res = await call('DELETE', '/admin/applications', admin, { ids: [113] });
      expect(res.json().deleted).toBe(1);
      expect((await call('GET', '/applications/113', admin)).statusCode).toBe(404);
      const search = (await call('GET', '/applications?scope=all&draftsOnly=true&pageSize=all', admin)).json();
      expect(search.items.some((a: { appl_id: number }) => a.appl_id === 113)).toBe(false);
    });
  });

  describe('statuses (N-4)', () => {
    it('lists the statuses with their usage', async () => {
      const items = (await call('GET', '/admin/statuses', admin)).json().items;
      expect(items).toHaveLength(9);
      expect(items.find((x: { code: number }) => x.code === 4)).toMatchObject({ desc: 'Reviewed (ADFS)', is_system: false, category: 'in_process' });
      expect(items.find((x: { code: number }) => x.code === 4).used_by.workflows).toBeGreaterThan(0);
    });

    it('adds an in-process status, renames and removes it while unused', async () => {
      const added = (await call('POST', '/admin/statuses', admin, { desc: 'Reviewed (Legal)', badge: 'review', sort_order: 55 })).json().items;
      const legal = added.find((x: { desc: string }) => x.desc === 'Reviewed (Legal)');
      expect(legal.code).toBeGreaterThanOrEqual(10);
      const renamed = (await call('PUT', `/admin/statuses/${legal.code}`, admin, { desc: 'Reviewed (Legal Cell)' })).json().items;
      expect(renamed.some((x: { desc: string }) => x.desc === 'Reviewed (Legal Cell)')).toBe(true);
      // the reference bundle carries it (the portal shows it)
      await t.app.ctx.cache.checkVersions();
      expect((t.app.ctx.cache.data<{ statuses: { desc: string }[] }>('reference').statuses).some((x) => x.desc === 'Reviewed (Legal Cell)')).toBe(true);
      const removed = await call('DELETE', `/admin/statuses/${legal.code}`, admin);
      expect(removed.statusCode).toBe(200);
    });

    it('protects the system statuses and the statuses in use', async () => {
      expect((await call('PUT', '/admin/statuses/7', admin, { desc: 'Granted' })).json().detail).toBe('Statuses 1, 2, 7, 8 and 9 are system statuses and cannot be changed.');
      expect((await call('DELETE', '/admin/statuses/4', admin)).json().detail).toBe('This status has been used, so it is kept for the history. Deactivate it instead.');
      expect((await call('PUT', '/admin/statuses/4', admin, { active: false })).json().detail).toBe('This status is still set by a workflow. Change the workflows first, then deactivate it.');
    });
  });

  describe('audit trail', () => {
    it('lists the actions newest first, filtered by an action prefix, with a "more" flag for paging (admin and DG)', async () => {
      const all = (await call('GET', '/audit?pageSize=200', admin)).json();
      expect(all.items.length).toBeGreaterThan(3);
      const times = all.items.map((x: { at: string }) => new Date(x.at).getTime());
      expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
      const statuses = (await call('GET', '/audit?action=status.', admin)).json();
      expect(statuses.items.length).toBeGreaterThanOrEqual(3);
      expect(statuses.items.every((x: { action: string; actorUsername: string }) => x.action.startsWith('status.') && x.actorUsername === 'admin')).toBe(true);
      const first = (await call('GET', '/audit?action=status.&pageSize=1', admin)).json();
      expect(first).toMatchObject({ page: 1, pageSize: 1, more: true });
      expect((await call('GET', '/audit?action=%25', admin)).json().items).toEqual([]);
      // readers: the administrator and the DG
      expect((await call('GET', '/audit?action=status.', await t.login('dg.officer'))).json().items.length).toBe(statuses.items.length);
      expect((await call('GET', '/audit', await t.login('dfs.officer'))).statusCode).toBe(403);
      expect((await call('GET', '/audit', await t.login('monitor.hq'))).statusCode).toBe(403);
      expect((await call('GET', '/audit', await t.login('citizen1'))).statusCode).toBe(403);
    });
  });
});
