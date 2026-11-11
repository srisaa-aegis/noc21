import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState } from '../../../testing/session';
import { ToastService } from '../../shared/ui/toast.service';
import { Dashboard } from './dashboard';

describe('Dashboard (admin workbench)', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(Dashboard);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('no longer shows the stale applications grid, but shows summary statistics', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('Citizen accounts');
    expect(el.textContent).toContain('Department users');
    expect(fixture.componentInstance['stats']().staleDrafts).toBe(3);
  });

  it('previews the overdue items with their recipients, sends the reminders and reports the result', async () => {
    const fixture = await render();
    const toast = vi.spyOn(TestBed.inject(ToastService), 'success');
    (Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[]).find((b) => b.textContent?.includes('Send Escalations'))!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    const preview = fixture.componentInstance['preview']()!;
    expect(preview.due.length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('Processing SLA');
    fixture.componentInstance['sendEscalations']();
    await fixture.whenStable();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('overdue item(s)'));
    // a second run right away has nothing due (reminder interval)
    fixture.componentInstance['openEscalations']();
    await fixture.whenStable();
    expect(fixture.componentInstance['preview']()!.due.length).toBe(0);
  });
});
