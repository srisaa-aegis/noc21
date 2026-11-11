import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { ConfirmDialogService } from '../../shared/ui/confirm-dialog.service';
import { Dashboard } from './dashboard';

describe('Dashboard (citizen)', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    await TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function render() {
    const fixture = TestBed.createComponent(Dashboard);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('renders exactly four "Apply for" cards (Existing Building dropped)', async () => {
    const fixture = await render();
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.apply-card__label')).map((e) => (e as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['Provisional', 'Occupancy', 'Renewal', 'Declaration']);
  });

  it('lists only the logged-in citizen’s applications', async () => {
    const fixture = await render();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Padma Rekha Apartments');
    expect(text).not.toContain('Harbor View Residency'); // citizen2
  });

  it('shows contextual actions according to the legacy rules', async () => {
    const fixture = await render();
    const row = (site: string) =>
      (Array.from(fixture.nativeElement.querySelectorAll('article')) as HTMLElement[]).find((a) => a.textContent?.includes(site))!;
    expect(row('So So So House').textContent).toContain('Continue');
    expect(row('So So So House').textContent).toContain('Delete');
    expect(row('Yashoda Paradise').textContent).toContain('Revise');
    expect(row('Lakeview Hospital').textContent).toContain('Apply for Renewal');
    expect(row('Green Valley Mall').textContent).toContain('document(s) requested');
  });

  it('filters by status', async () => {
    const fixture = await render();
    fixture.componentInstance['statusFilter'].set(9);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('article').length).toBe(1);
  });

  it('deletes a draft after confirmation', async () => {
    const fixture = await render();
    vi.spyOn(TestBed.inject(ConfirmDialogService), 'open').mockResolvedValue(true);
    const draft = fixture.componentInstance['applications']().find((a) => a.appl_id === 104)!;
    await fixture.componentInstance['deleteDraft'](draft);
    fixture.detectChanges();
    expect(fixture.componentInstance['applications']().some((a) => a.appl_id === 104)).toBe(false);
  });
});
