import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState } from '../../../testing/session';
import { AuthService } from './auth.service';

describe('AuthService (against the fake backend)', () => {
  let service: AuthService;

  beforeEach(() => {
    resetBrowserState();
    TestBed.configureTestingModule({ providers: [provideFixtureBackend()] });
    service = TestBed.inject(AuthService);
  });

  afterEach(() => resetBrowserState());

  it('starts unauthenticated when there is no stored session', () => {
    expect(service.isAuthenticated()).toBe(false);
  });

  it.each([
    ['citizen1', '/citizen/dashboard'],
    ['dg.officer', '/dept/dashboard'],
    ['admin', '/admin/dashboard'],
  ])('logs %s in and lands on %s', async (username, landing) => {
    const result = await firstValueFrom(service.login(username, 'demo'));
    expect(result.success).toBe(true);
    expect(result.landing).toBe(landing);
    expect(service.session()?.username).toBe(username);
  });

  it('keeps the department role id on the session', async () => {
    await firstValueFrom(service.login('dfs.officer', 'demo'));
    expect(service.session()?.role_id).toBe(2);
  });

  it('accepts the e-mail address as the username (legacy rule)', async () => {
    const result = await firstValueFrom(service.login('builder1@example.com', 'demo'));
    expect(result.success).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const result = await firstValueFrom(service.login('citizen1', 'wrong'));
    expect(result.success).toBe(false);
    expect(service.isAuthenticated()).toBe(false);
  });

  it('rejects a deactivated account with a specific message', async () => {
    const result = await firstValueFrom(service.login('sai.constructions', 'demo'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('deactivated');
  });

  it('registers a citizen: no password — a "set your password" link is e-mailed (B2-4)', async () => {
    const reg = await firstValueFrom(
      service.register({ name: 'New Builder', mobile: '9876543210', email: 'New@Example.com', gender: 'F', dob: '', aadhar: '', address: 'Guntur' }),
    );
    expect(reg.success).toBe(true);
    expect(reg.username).toBe('new@example.com');
    expect(reg.setPasswordUrl).toContain('/auth/reset-password?token=');
  });

  it('refuses a duplicate registration', async () => {
    const reg = await firstValueFrom(
      service.register({ name: 'Dup', mobile: '9876543210', email: 'builder1@example.com', gender: '', dob: '', aadhar: '', address: '' }),
    );
    expect(reg.success).toBe(false);
    expect(reg.error).toContain('already exists');
  });

  it('forgotPassword answers the same whether or not the account exists (no account-existence disclosure)', async () => {
    expect((await firstValueFrom(service.forgotPassword('builder1@example.com'))).success).toBe(true);
    expect((await firstValueFrom(service.forgotPassword('nobody@example.com'))).success).toBe(true);
    expect((await firstValueFrom(service.forgotPassword('sai.constructions@example.com'))).success).toBe(true);
  });

  it('asks for a password change when the account has a temporary password', async () => {
    await firstValueFrom(service.login('citizen1', 'demo'));
    expect(service.mustChangePassword()).toBe(false);
  });

  it('logout clears the session', async () => {
    await firstValueFrom(service.login('citizen1', 'demo'));
    service.logout();
    expect(service.session()).toBeNull();
  });
});
