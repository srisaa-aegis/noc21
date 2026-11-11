import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../../../testing/session';
import { Reports } from './reports';

describe('Reports (dept)', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('monitor.hq', 'dept', 8, 'Monitoring Cell (HQ)');
    await TestBed.configureTestingModule({ imports: [Reports], providers: [provideRouter([]), provideFakeApi()] }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function open(report: string) {
    const fixture = TestBed.createComponent(Reports);
    fixture.componentRef.setInput('report', report);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists the ten reports and shows the pendency dashboard with two charts', async () => {
    const { el } = await open('pendency');
    expect(el.querySelectorAll('.side__link').length).toBe(10);
    expect(el.querySelector('.side__link.is-active')?.textContent).toContain('Pendency');
    expect(el.querySelectorAll('app-bar-chart svg').length).toBe(2);
    expect(el.querySelector('.kpi__value')?.textContent?.trim()).toBe('5');
    expect(el.textContent).toContain('2026100071');
  });

  it('filters by level and shows only the filters of the report', async () => {
    const { fixture, el } = await open('pendency');
    expect(el.querySelectorAll('.filters .f').length).toBe(2); // level, region
    fixture.componentInstance['level'].set('RFO');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(TestBed.inject(FakeApi).calls('GET', /^\/dept\/reports\/pendency$/).at(-1)!.query).toEqual({ level: 'RFO' });
    expect(el.querySelector('.kpi__value')?.textContent?.trim()).toBe('1');
    expect(el.querySelector('.print-meta')?.textContent).toContain('Regional (RFO)');
  });

  it('renders the challan report with totals and hides districts without applications', async () => {
    const { fixture, el } = await open('challan');
    expect(el.querySelectorAll('table.challan > tbody').length).toBe(4); // Srikakulam, Visakhapatnam, Krishna, Guntur
    expect(el.querySelector('table.challan tfoot')?.textContent).toContain('952,627');
    fixture.componentInstance['hideEmpty'].set(false);
    fixture.detectChanges();
    expect(el.querySelectorAll('table.challan > tbody').length).toBe(13);
  });

  it('shows the statistics totals', async () => {
    const { el } = await open('statistics');
    expect(el.textContent).toContain('Total');
  });

  it('downloads the CSV of the current report from the server (every row, with the filters)', async () => {
    const { fixture } = await open('statistics');
    const createUrl = vi.fn(() => 'blob:csv');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fixture.componentInstance['level'].set('MSB');
    fixture.componentInstance['exportCsv']();
    await fixture.whenStable();
    const call = TestBed.inject(FakeApi)
      .calls('GET', /^\/dept\/reports\/statistics$/)
      .find((c) => c.query['format'] === 'csv')!;
    expect(call.query).toEqual({ level: 'MSB', format: 'csv' });
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('says a district officer sees only the files of his fire stations (the server filters)', async () => {
    seedSession('dfo.guntur', 'dept', 6, 'DFO - Guntur');
    const { el } = await open('statistics');
    expect(el.querySelector('.print-meta')?.textContent).toContain('files of your fire stations only');
  });

  it('shows every file to the monitoring role', async () => {
    const { el } = await open('statistics');
    expect(el.querySelector('.print-meta')?.textContent).not.toContain('fire stations only');
  });

  it('shows the level-wise particulars in three tables', async () => {
    const { el } = await open('levels');
    expect(el.querySelectorAll('section.block table').length).toBe(3);
    expect(el.textContent).toContain('Above 15 m (Head Office)');
  });
});
