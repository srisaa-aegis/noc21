import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideFixtureBackend } from '../../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../../testing/session';
import { ApplicationDraftStore } from './application-draft.store';
import { StepSubmit } from './step-submit';

describe('StepSubmit (fee, payment, verification, Submit)', () => {
  let store: ApplicationDraftStore;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    await TestBed.configureTestingModule({
      imports: [StepSubmit],
      providers: [ApplicationDraftStore, provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
    store = TestBed.inject(ApplicationDraftStore);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await store.load('104', 'citizen1');
  });

  afterEach(() => resetBrowserState());

  async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it('shows the fee calculation with the portal charges', () => {
    const fixture = TestBed.createComponent(StepSubmit);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('3,500 sq.m × Rs. 10 per sq.m');
    expect(text).toContain('Rs. 35,000');
    expect(text).toContain('Rs. 800 / Rs. 34,200');
    expect(text).toContain('Head Office (DGFS / MSB)');
  });

  it('shows the additional fee and the penalty years for an Occupancy without a Provisional NOC', () => {
    const a = store.app()!;
    a.appl_type = 'O';
    a.appl_mode = 'N';
    a.mcapprove_date = `01-Jan-${new Date().getFullYear() - 2}`;
    store.touch();
    const fixture = TestBed.createComponent(StepSubmit);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Additional fee for not obtaining a Provisional NOC');
    expect(text).toContain('Penalty for 2 year(s) since municipal approval');
  });

  it('Submit is enabled by the verification tick; problems are listed by page with a link to fix', async () => {
    const fixture = TestBed.createComponent(StepSubmit);
    const goTo: unknown[] = [];
    fixture.componentInstance.goTo.subscribe((s) => goTo.push(s));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const submit = el.querySelector<HTMLButtonElement>('.submit-btn')!;
    expect(submit.disabled).toBe(true);
    el.querySelector<HTMLInputElement>('.declaration input')!.click();
    fixture.detectChanges();
    expect(submit.disabled).toBe(false);
    submit.click();
    await settle(fixture);
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('cannot be submitted yet');
    expect(dialog.textContent).toContain('Licensing authority is required');
    const groups = Array.from(dialog.querySelectorAll('.problem-group h4')).map((h) => h.textContent?.replace(/\s\d+$/, '').trim());
    expect(groups).toEqual(['Application', 'Block A — Fire Fighting Equipment', 'Documents', 'Fee & Submit']);
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('.problem-group button');
    buttons[0].click();
    expect(goTo).toEqual([{ step: 'basic' }]);
    submit.click();
    await settle(fixture);
    el.querySelectorAll<HTMLButtonElement>('[role="dialog"] .problem-group button')[1].click();
    expect(goTo[1]).toEqual({ step: 'blocks', blockId: 1, blockStep: 'ffe' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the confirmation page when everything is complete', async () => {
    const a = store.app()!;
    a.lic_auth = 'Commissioner, VMC';
    a.lic_addr = 'VMC Office';
    a.perimeter = 260;
    a.blocks[0].ffe.agree_reqt = true;
    store.touch();
    for (const d of store.requiredDocs().filter((x) => !x.optional)) await store.attachDocument(d, new File(['x'], 'x.pdf', { type: 'application/pdf' }));
    await store.payOnline();
    store.set(store.app()!, 'declaration_accepted', true); // the payment adopted the server's copy
    const fixture = TestBed.createComponent(StepSubmit);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.submit-btn') as HTMLButtonElement).click();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', 104, 'confirm']);
  });
});
