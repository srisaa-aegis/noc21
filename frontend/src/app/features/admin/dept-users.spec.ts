import { TestBed } from '@angular/core/testing';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState } from '../../../testing/session';
import { UserAccount } from '../../core/models';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { DeptUsers } from './dept-users';

describe('DeptUsers', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({ imports: [DeptUsers], providers: [provideFakeApi()] }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function render() {
    const fixture = TestBed.createComponent(DeptUsers);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const api = () => TestBed.inject(FakeApi);
  const account = (u: string) => api().users.find((x) => x.username === u) as UserAccount;

  it('lists department users with role names and their fire stations', async () => {
    const fixture = await render();
    const text = fixture.nativeElement.textContent as string;
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(17);
    expect(text).toContain('Director General, Fire Services');
    expect(text).toContain('Section (Head Office scrutiny)');
    expect(text).toContain('All fire stations');
    expect(text).toContain('Krishna (all 21)');
    expect(text).toContain('Visakhapatnam: Visakhapatnam, Pedagantyada');
  });

  it('filters by role', async () => {
    const fixture = await render();
    fixture.componentInstance['roleFilter'].set('6');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(5);
  });

  it('adds a user (integer role and station ids) and shows the temporary password once', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    c['openAdd']();
    c['form'] = { username: 'sfo.tenali', displayName: 'SFO - Tenali', email: 'sfo.t@example.gov', mobile: '9440009999', role_id: 9, district: 7 };
    c['toggleStation'](112, true);
    c['save']();
    await fixture.whenStable();
    fixture.detectChanges();
    const issued = c['issued']()!;
    expect(issued.username).toBe('sfo.tenali');
    expect(fixture.nativeElement.querySelector('.temp-password')?.textContent).toBe(issued.password);
    expect(api().calls('POST', /^\/admin\/accounts\/dept$/)[0].body).toMatchObject({ username: 'sfo.tenali', role_id: 9, fire_station_ids: [112], all_stations: false });
  });

  it('shows the server validation errors in the modal', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    c['openAdd']();
    c['form'] = { username: 'dg.officer', displayName: 'Dup', email: 'x@example.gov', mobile: '9440009999', role_id: 1, district: 0 };
    c['allStations'].set(true);
    c['save']();
    await fixture.whenStable();
    expect(c['formError']()).toContain('already taken');
  });

  it('resets a password after confirmation (temporary password, shown once)', async () => {
    const fixture = await render();
    vi.spyOn(TestBed.inject(ConfirmDialogService), 'open').mockResolvedValue(true);
    await fixture.componentInstance['resetPassword'](account('rfo.officer'));
    await fixture.whenStable();
    expect(fixture.componentInstance['issued']()?.password).toBe('Temp#Pass2026');
    expect(api().calls('POST', /^\/admin\/accounts\/\d+\/password$/)).toHaveLength(1);
  });

  it('modifies the fire stations of a user (district select-all) and associates another with all stations', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    c['openEdit'](account('sfo.guntur'));
    const guntur = c['fireStations']().find((d) => d.id === 7)!;
    c['toggleDistrict'](guntur.stations, true);
    c['save']();
    await fixture.whenStable();
    const sent = api().calls('PUT', /^\/admin\/accounts\/\d+\/dept$/)[0].body as { fire_station_ids: number[] };
    expect(sent.fire_station_ids.length).toBe(guntur.stations.length);

    c['openEdit'](account('monitor.hq'));
    expect(c['allStations']()).toBe(true);
    c['save']();
    await fixture.whenStable();
    expect(api().calls('PUT', /^\/admin\/accounts\/\d+\/dept$/)[1].body).toMatchObject({ all_stations: true, fire_station_ids: [] });
  });

  it('deactivates an officer without open tasks after confirmation', async () => {
    const fixture = await render();
    vi.spyOn(TestBed.inject(ConfirmDialogService), 'open').mockResolvedValue(true);
    await fixture.componentInstance['toggleActive'](account('rfo.southern'));
    await fixture.whenStable();
    expect(api().calls('PUT', /^\/admin\/accounts\/\d+\/active$/)[0].body).toEqual({ active: false });
  });

  it('deactivating an officer with open tasks requires moving them to an officer of the same role', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    const open = vi.spyOn(TestBed.inject(ConfirmDialogService), 'open');
    await c['toggleActive'](account('dfs.officer'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(open).not.toHaveBeenCalled();
    const h = c['handover']()!;
    expect(h.tasks.map((t) => t.appl_id).sort()).toEqual([102, 106, 109, 110]);
    expect(h.candidates.length).toBe(0); // no other DFS exists
    expect(document.body.textContent).toContain('no other active officer with this role');
    c['handover'].set(null);

    // with a second DFS: hand over, then deactivate
    api().users.push({ ...account('dfs.officer'), id: 777, username: 'dfs.acting', displayName: 'DFS (acting)', email: 'dfs.acting@example.gov' });
    (c as unknown as { reload: () => void }).reload();
    await fixture.whenStable();
    await c['toggleActive'](account('dfs.officer'));
    await fixture.whenStable();
    expect(c['handover']()!.candidates.map((u) => u.username)).toEqual(['dfs.acting']);
    c['confirmHandover']();
    await fixture.whenStable();
    expect(api().calls('POST', /^\/admin\/accounts\/\d+\/handover$/)[0].body).toEqual({ to: 777 });
    expect(api().calls('PUT', /^\/admin\/accounts\/\d+\/active$/).at(-1)?.body).toEqual({ active: false });
  });
});
