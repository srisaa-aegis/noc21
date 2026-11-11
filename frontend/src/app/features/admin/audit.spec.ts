import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { AdminAudit } from './audit';

describe('AdminAudit', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('admin', 'admin');
    await TestBed.configureTestingModule({ imports: [AdminAudit], providers: [provideRouter([]), provideFakeApi()] }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(AdminAudit);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('lists the audit trail newest first with who, what and the record', async () => {
    const fixture = await render();
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr')).map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('status.added');
    expect(rows[0]).toContain('admin');
    expect(rows[2]).toContain('application 101');
  });

  it('filters on the server by action prefix and kind of record, and pages', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    const action = el.querySelector<HTMLInputElement>('input[aria-label="Action"]')!;
    action.value = 'workflow.';
    action.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const api = TestBed.inject(FakeApi);
    expect(api.calls('GET', /^\/audit$/).at(-1)!.query).toMatchObject({ action: 'workflow.', page: '1' });
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Kind of record"]')!;
    select.value = 'status';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.calls('GET', /^\/audit$/).at(-1)!.query).toMatchObject({ action: 'workflow.', entityType: 'status' });
    expect(el.textContent).toContain('No entry matches.');
  });
});
