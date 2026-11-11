import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState } from '../../../testing/session';
import { ResetPassword } from './reset-password';

describe('ResetPassword (landing page of the e-mailed link)', () => {
  const resetPassword = vi.fn(() => of({ success: true }));

  async function create(token: string | null, extra: Record<string, string> = {}) {
    resetBrowserState();
    resetPassword.mockClear();
    await TestBed.configureTestingModule({
      imports: [ResetPassword],
      providers: [
        provideRouter([{ path: 'auth/login', children: [] }]),
        provideFixtureBackend(),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(token ? { token, ...extra } : extra) } } },
      ],
    }).compileComponents();
    TestBed.overrideProvider(AuthService, { useValue: { resetPassword } });
    const fixture = TestBed.createComponent(ResetPassword);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  async function submit(fixture: Awaited<ReturnType<typeof create>>, next: string, confirm: string) {
    const el = fixture.nativeElement as HTMLElement;
    const set = (id: string, v: string) => {
      const i = el.querySelector<HTMLInputElement>(id)!;
      i.value = v;
      i.dispatchEvent(new Event('input'));
    };
    set('#rp-new', next);
    set('#rp-confirm', confirm);
    fixture.detectChanges();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    return el;
  }

  it('explains an incomplete link', async () => {
    const fixture = await create(null);
    expect(fixture.nativeElement.textContent).toContain('incomplete');
  });

  it('checks the policy and the confirmation before calling the server', async () => {
    const fixture = await create('a-long-reset-token');
    expect((await submit(fixture, 'short', 'short')).textContent).toContain('at least 10');
    expect((await submit(fixture, 'Station#2025', 'Station#2026')).textContent).toContain('do not match');
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('sends the token and the new password', async () => {
    const fixture = await create('a-long-reset-token');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await submit(fixture, 'Station#2025', 'Station#2025');
    expect(resetPassword).toHaveBeenCalledWith('a-long-reset-token', 'Station#2025');
    expect(navigate).toHaveBeenCalledWith(['/auth/login'], { queryParams: { reset: '1' } });
  });

  it('welcomes a new citizen on the "set your password" link of the registration (B2-4)', async () => {
    const fixture = await create('a-long-welcome-token', { welcome: '1' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Choose the password for your new account');
    expect(el.querySelector('button[type="submit"]')?.textContent?.trim()).toBe('Set Password');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await submit(fixture, 'Station#2025', 'Station#2025');
    expect(navigate).toHaveBeenCalledWith(['/auth/login'], { queryParams: { reset: 'welcome' } });
  });
});
