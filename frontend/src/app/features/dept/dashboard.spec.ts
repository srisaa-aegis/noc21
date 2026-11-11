import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { Dashboard } from './dashboard';

describe('Dashboard (dept) — queues derived from the workflow runs', () => {
  afterEach(() => resetBrowserState());

  async function render(username: string, role: string, prepare?: (api: FakeApi) => void) {
    resetBrowserState();
    seedSession(username, 'dept', role, username);
    await TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [provideRouter([]), provideFakeApi(prepare)],
    }).compileComponents();
    const fixture = TestBed.createComponent(Dashboard);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const groups = (el: HTMLElement) => Array.from(el.querySelectorAll('.group-title')).map((h) => h.childNodes[0].textContent?.trim());
  const actions = (el: HTMLElement) => Array.from(el.querySelectorAll('section[aria-labelledby="my-tasks-title"] a.btn')).map((a) => a.textContent?.trim());

  it('the DFS sees his open tasks grouped by task: the DFS note (110) and the final decision of a renewal (106)', async () => {
    const { el } = await render('dfs.officer', '2');
    expect(groups(el)).toEqual(['Final Decision', 'DFS Note']);
    expect(actions(el)).toEqual(['Issue/Reject', 'Review']);
    expect(el.querySelector('a.btn[href*="/dept/applications/106"]')?.getAttribute('href')).toContain('task=');
    // 106 has been pending with the DFS for years — past the decision SLA
    expect(el.querySelectorAll('tr.row--overdue').length).toBeGreaterThanOrEqual(1);
  });

  it('an SFO gets the committee concurrence of the Head Office file of his fire station (102)', async () => {
    const { el } = await render('sfo.officer', '9');
    expect(groups(el)).toEqual(['Committee Member Concurrence']);
    expect(el.textContent).toContain('2017030007');
    expect(el.textContent).toContain('Fire stations:');
  });

  it('the DG has no open task but monitors the Head Office files in process, grouped by stage', async () => {
    const { fixture, el } = await render('dg.officer', '1');
    expect(el.textContent).toContain('No task is waiting for you.');
    const c = fixture.componentInstance as unknown as { monitorRows: () => { app: { appl_id: number } }[]; stages: () => { label: string; count: number }[] };
    expect(c.monitorRows().map((r) => r.app.appl_id).sort()).toEqual([102, 109, 110]);
    expect(c.stages().map((s) => s.label).sort()).toEqual(['Reviewed by ADFS', 'Reviewed by DFS-CD', 'Submitted']);
  });

  it('the monitoring role sees every file in process; decided files on request', async () => {
    const { fixture, el } = await render('monitor.hq', '8');
    const c = fixture.componentInstance as unknown as { monitorRows: () => { app: { appl_id: number } }[]; showCompleted: { set: (v: boolean) => void } };
    expect(c.monitorRows().map((r) => r.app.appl_id).sort()).toEqual([102, 106, 108, 109, 110]);
    c.showCompleted.set(true);
    fixture.detectChanges();
    expect(c.monitorRows().length).toBe(11);
    expect(el.textContent).toContain('All fire stations');
  });

  it('filters both lists by type and text', async () => {
    const { fixture } = await render('monitor.hq', '8');
    const c = fixture.componentInstance as unknown as { monitorRows: () => { app: { appl_id: number } }[]; type: { set: (v: string) => void }; text: { set: (v: string) => void } };
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    c.type.set('O');
    await settle();
    expect(c.monitorRows().map((r) => r.app.appl_id).sort()).toEqual([102, 110]);
    c.text.set('coastal');
    await settle();
    expect(c.monitorRows().map((r) => r.app.appl_id)).toEqual([110]);
  });

  it('lists the decided files of the last 12 months when there are many, and all of them on request', async () => {
    const { fixture, el } = await render('monitor.hq', '8', (api) =>
      api.on('GET', /^\/dept\/monitoring$/, ({ query }) => ({
        ...(api.handleSync('GET', '/dept/monitoring', query) as object),
        decided: query['includeDecided'] === 'true' ? { window_months: query['decided'] === 'all' ? null : 12, total: 4200 } : null,
      })),
    );
    const c = fixture.componentInstance as unknown as { toggleCompleted: (v: boolean) => void };
    c.toggleCompleted(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.decided-window')?.textContent).toContain('last 12 months');
    el.querySelector<HTMLButtonElement>('.decided-window button')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const api = TestBed.inject(FakeApi);
    expect(api.calls('GET', /^\/dept\/monitoring$/).at(-1)!.query).toMatchObject({ includeDecided: 'true', decided: 'all' });
    expect(el.querySelector('.decided-window')?.textContent).toContain('All 4200 decided files');
  });

  it('lists the oldest tasks the server sends and says how many there are in all', async () => {
    const { el } = await render('dfs.officer', '2', (api) =>
      api.on('GET', /^\/dept\/tasks$/, ({ query }) => {
        expect(query['limit']).toBe('200');
        const page = api.handleSync('GET', '/dept/tasks') as { items: unknown[] };
        return { items: page.items.slice(0, 1), total: 740, overdue: 12, groups: [{ name: 'Final Decision', count: 500 }, { name: 'DFS Note', count: 240 }] };
      }),
    );
    expect(el.textContent).toContain('The 1 oldest of your 740 tasks are listed');
    expect(el.querySelector('.kpi__value')?.textContent?.trim()).toBe('740');
    expect(el.querySelector('.group-title .count')?.textContent?.trim()).toBe('500');
  });

  it('shows the citizen feedback panel with the average rating and a period selector', async () => {
    const { el } = await render('dg.officer', '1');
    const panel = el.querySelector('.feedback-panel')!;
    expect(panel.querySelector('.feedback-panel__value')?.textContent?.trim()).toBe('3.67');
    expect(panel.textContent).toContain('3 rating(s)');
    expect(panel.textContent).toContain('Renewal was processed within the promised time.');
    expect(Array.from(panel.querySelectorAll('[role="tab"]')).map((b) => b.textContent?.trim())).toEqual(['Last month', '3 months', '6 months', '12 months', 'Overall']);
    expect(panel.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe('Overall');
  });
});
