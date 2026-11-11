import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFakeApi } from '../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../testing/session';
import { DeptShell } from './dept-shell';

describe('DeptShell', () => {
  async function render(username: string, roleId: number) {
    resetBrowserState();
    seedSession(username, 'dept', roleId);
    await TestBed.configureTestingModule({ imports: [DeptShell], providers: [provideRouter([]), provideFakeApi()] }).compileComponents();
    const fixture = TestBed.createComponent(DeptShell);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => resetBrowserState());

  it('renders the department portal header', async () => {
    const el = await render('dfo.visakhapatnam', 6);
    expect(el.textContent).toContain('Department Workbench');
    expect(el.textContent).not.toContain('Audit');
  });

  it('offers the audit trail to the DG', async () => {
    const el = await render('dg.officer', 1);
    expect(Array.from(el.querySelectorAll('a')).some((a) => a.getAttribute('href') === '/dept/audit')).toBe(true);
  });
});
