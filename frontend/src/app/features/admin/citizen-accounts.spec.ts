import { TestBed } from '@angular/core/testing';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState } from '../../../testing/session';
import { UserAccount } from '../../core/models';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { CitizenAccounts } from './citizen-accounts';

describe('CitizenAccounts', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({ imports: [CitizenAccounts], providers: [provideFakeApi()] }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function render() {
    const fixture = TestBed.createComponent(CitizenAccounts);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 10));
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const api = () => TestBed.inject(FakeApi);
  const account = (u: string) => api().users.find((x) => x.username === u) as UserAccount;

  it('lists the citizen accounts the server returns, with their status', async () => {
    const fixture = await render();
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(4);
    expect(fixture.nativeElement.textContent).toContain('Deactivated');
    expect(fixture.nativeElement.textContent).not.toContain('dg.officer');
    expect(api().calls('GET', /^\/admin\/accounts$/)[0].query).toMatchObject({ portal: 'citizen' });
  });

  it('searches on the server', async () => {
    const fixture = await render();
    fixture.componentInstance['query'].set('mantri');
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    expect(api().calls('GET', /^\/admin\/accounts$/).at(-1)?.query).toMatchObject({ portal: 'citizen', q: 'mantri' });
  });

  it('modifies a profile through the modal', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    c['openEdit'](account('citizen2'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.modal')).toBeTruthy();
    c['form'].mobile = '9000000002';
    c['saveEdit']();
    await fixture.whenStable();
    expect(api().calls('PUT', /^\/admin\/accounts\/2\/profile$/)[0].body).toMatchObject({ mobile: '9000000002' });
    expect(c['editing']()).toBeNull();
  });

  it('validates a password before sending it; the citizen must change it at the next sign-in', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    c['openPassword'](account('citizen1'));
    c['newPassword'] = 'abcdef';
    c['confirmPassword'] = 'abcdef';
    c['savePassword']();
    expect(c['pwdError']()).toContain('does not meet the policy');
    c['newPassword'] = 'N3w!Passw0rdOK';
    c['confirmPassword'] = 'N3w!Passw0rdOX';
    c['savePassword']();
    expect(c['pwdError']()).toContain('do not match');
    c['confirmPassword'] = 'N3w!Passw0rdOK';
    c['savePassword']();
    await fixture.whenStable();
    expect(api().calls('POST', /^\/admin\/accounts\/1\/password$/)[0].body).toEqual({ password: 'N3w!Passw0rdOK' });
  });

  it('deactivates after confirmation', async () => {
    const fixture = await render();
    vi.spyOn(TestBed.inject(ConfirmDialogService), 'open').mockResolvedValue(true);
    await fixture.componentInstance['toggleActive'](account('citizen1'));
    await fixture.whenStable();
    expect(api().calls('PUT', /^\/admin\/accounts\/1\/active$/)[0].body).toEqual({ active: false });
  });
});
