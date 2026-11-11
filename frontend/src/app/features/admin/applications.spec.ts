import { TestBed } from '@angular/core/testing';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState } from '../../../testing/session';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { AdminApplications } from './applications';

describe('AdminApplications (search & delete)', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({ imports: [AdminApplications], providers: [provideFixtureBackend()] }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function render() {
    const fixture = TestBed.createComponent(AdminApplications);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('lists every application initially', async () => {
    const fixture = await render();
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(14);
  });

  it('finds stale drafts with the preset and bulk-deletes them after confirmation', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    c['presetStaleDrafts']();
    fixture.detectChanges();
    expect(c['results']().map((r) => r.appl_id).sort()).toEqual([104, 112, 113]);

    const confirm = vi.spyOn(TestBed.inject(ConfirmDialogService), 'open').mockResolvedValue(true);
    c['toggleAll']();
    await c['deleteSelected']();
    fixture.detectChanges();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete 3 applications?', message: expect.stringContaining('3 drafts') }));
    expect(c['results']()).toEqual([]);

    c['clear']();
    expect(c['results']().length).toBe(11);
  });

  it('offers no deletion for a submitted application (kept; the server refuses it too)', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    const row = (text: string) => Array.from(el.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes(text))!;
    const submitted = fixture.componentInstance['results']().find((r) => r.appl_id === 102)!;
    expect(row(submitted.appl_number).querySelector('button')).toBeNull();
    expect(row(submitted.appl_number).querySelector('input[type=checkbox]')).toBeNull();
    expect(row(submitted.appl_number).textContent).toContain('Kept');
    expect(row('Draft #104').querySelector('button')?.textContent).toContain('Delete');
    fixture.componentInstance['toggleAll']();
    expect([...fixture.componentInstance['selected']()].sort()).toEqual([104, 112, 113]);
  });
});
