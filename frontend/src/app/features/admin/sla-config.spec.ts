import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState } from '../../../testing/session';
import { SlaConfigPage } from './sla-config';

describe('SlaConfigPage (admin)', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({ imports: [SlaConfigPage], providers: [provideRouter([]), provideFakeApi()] }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function render() {
    const fixture = TestBed.createComponent(SlaConfigPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('shows the processing, inspection and step SLAs of every workflow and the escalation settings', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('section.wf').length).toBe(12);
    const pmsb = el.querySelector('section[aria-label="SLA of Provisional NOC — Head Office"]')!;
    expect(pmsb.textContent).toContain('Scrutiny by Section');
    expect(pmsb.textContent).toContain('inspection SLA'); // inspection tasks use the inspection SLA
    expect(pmsb.textContent).toContain('Sum of the steps: 47 days');
    expect(el.textContent).toContain('Notify the issuing authority of the file');
  });

  it('validates (inspection ≤ processing, at least one recipient) and saves', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    const s = c['draft']()!;
    s.workflows['P-RFO'].inspection_days = 40;
    s.escalation.notify_officer = false;
    s.escalation.notify_approver = false;
    c['touch']();
    fixture.detectChanges();
    expect(c['problems']().join(' ')).toContain('P-RFO: the inspection SLA cannot exceed the processing SLA.');
    expect(c['problems']().join(' ')).toContain('Escalations must notify');
    const save = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.savebar .btn--primary')!;
    expect(save.disabled).toBe(true);

    s.workflows['P-RFO'].inspection_days = 12;
    s.escalation.notify_officer = true;
    s.workflows['P-RFO'].step_days['dfo'] = 3;
    c['touch']();
    expect(c['problems']()).toEqual([]);
    c['save']();
    await fixture.whenStable();
    const sent = TestBed.inject(FakeApi).calls('PUT', /^\/config\/sla$/)[0].body as { workflows: Record<string, unknown>; escalation: unknown };
    expect(sent.workflows['P-RFO']).toMatchObject({ inspection_days: 12, step_days: { dfo: 3 } });
    expect(sent.escalation).toMatchObject({ notify_officer: true, notify_approver: false });
  });
});
