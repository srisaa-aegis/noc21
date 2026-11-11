import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { ChangePassword } from './change-password';

describe('ChangePassword (self-service)', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('sfo.officer', 'dept', '9');
    await TestBed.configureTestingModule({
      imports: [ChangePassword],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function submit(current: string, next: string, confirm: string) {
    const fixture = TestBed.createComponent(ChangePassword);
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const set = (id: string, v: string) => {
      const i = el.querySelector<HTMLInputElement>(id)!;
      i.value = v;
      i.dispatchEvent(new Event('input'));
    };
    set('#cp-current', current);
    set('#cp-new', next);
    set('#cp-confirm', confirm);
    fixture.detectChanges();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
    return el;
  }

  it('changes the password of the signed-in officer', async () => {
    const el = await submit('demo', 'Station#2025', 'Station#2025');
    expect(el.querySelector('.msg--success')?.textContent).toContain('changed');
    const call = TestBed.inject(FakeApi).calls('PUT', /^\/auth\/password$/)[0];
    expect(call.body).toEqual({ currentPassword: 'demo', newPassword: 'Station#2025' });
  });

  it('enforces the password policy before calling the server', async () => {
    expect((await submit('demo', 'station9', 'station9')).querySelector('.msg--error')?.textContent).toContain('at least 10');
  });

  it('reports a mismatch and a wrong current password', async () => {
    expect((await submit('demo', 'Station#2025', 'Station#2026')).querySelector('.msg--error')?.textContent).toContain('do not match');
    expect((await submit('nope', 'Station#2025', 'Station#2025')).querySelector('.msg--error')?.textContent).toContain('incorrect');
  });
});
