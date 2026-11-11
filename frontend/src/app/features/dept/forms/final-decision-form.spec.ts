import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { FakeApi, fixture as data, provideFakeApi } from '../../../../testing/fake-api';
import { resetBrowserState } from '../../../../testing/session';
import { LookupService, WizardLookups } from '../../../core/lookups/lookup.service';
import { Application } from '../../../core/models';
import { FinalDecisionForm } from './final-decision-form';

/** The server preview is debounced (300 ms). */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FinalDecisionForm', () => {
  const apps = data<Application[]>('assets/data/applications/applications.json');

  beforeEach(() => {
    resetBrowserState();
    TestBed.configureTestingModule({ providers: [provideFakeApi()] });
  });

  afterEach(() => resetBrowserState());

  async function render(appId: number, allowed: ('approve' | 'return' | 'reject' | 'inspect')[] = ['approve', 'return', 'reject']) {
    const lookups = await firstValueFrom(TestBed.inject(LookupService).wizard());
    const f = TestBed.createComponent(FinalDecisionForm);
    f.componentRef.setInput('app', structuredClone(apps.find((a) => a.appl_id === appId)!));
    f.componentRef.setInput('taskId', 8);
    f.componentRef.setInput('lookups', lookups as WizardLookups);
    f.componentRef.setInput('allowed', allowed);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    return f;
  }

  it('requires a remark and the signed copy before approve / return / reject can be submitted; previews the right certificate', async () => {
    const f = await render(101); // Provisional, approved
    const el = f.nativeElement as HTMLElement;
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.outcome-btn')).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Approved', 'Returned with Remarks', 'Rejected']);

    buttons.indexOf('Approved');
    el.querySelectorAll<HTMLButtonElement>('.outcome-btn')[0].click();
    f.detectChanges();
    expect(el.querySelector('.problems')?.textContent).toContain('Enter the remarks');
    expect(el.querySelector<HTMLButtonElement>('.decision-actions button')!.disabled).toBe(true);

    const remark = el.querySelector<HTMLTextAreaElement>('#fd_remark')!;
    remark.value = 'All conditions met.';
    remark.dispatchEvent(new Event('input'));
    f.detectChanges();
    await wait(350);
    f.detectChanges();
    expect(el.querySelector('.problems')?.textContent).toContain('Upload the signed copy');
    const preview = TestBed.inject(FakeApi).calls('POST', /^\/dept\/applications\/101\/tasks\/8\/decision-preview$/).at(-1)!;
    expect(preview.body).toEqual(expect.objectContaining({ outcome: 'approve', input: expect.objectContaining({ remark: 'All conditions met.' }) }));
    expect(el.querySelector('app-noc-provisional')).not.toBeNull(); // preview follows the outcome even before the file is attached

    const input = el.querySelector<HTMLInputElement>('#fd_signed')!;
    const file = new File(['x'], 'signed.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(TestBed.inject(FakeApi).calls('POST', /^\/dept\/applications\/101\/tasks\/8\/signed-copy$/)).toHaveLength(1);
    expect(el.querySelector('.problems')).toBeNull();
    const submit = el.querySelector<HTMLButtonElement>('.decision-actions button')!;
    expect(submit.disabled).toBe(false);

    let emitted: { outcome: string } | undefined;
    f.componentInstance.decided.subscribe((e) => (emitted = e));
    submit.click();
    expect(emitted?.outcome).toBe('approve');
  });

  it('does not offer "Returned with Remarks" once the processing SLA is crossed, and previews the rejection letter', async () => {
    const f = await render(106, ['approve', 'reject']); // processing SLA already exceeded
    const el = f.nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('.outcome-btn')).map((b) => b.textContent?.trim())).toEqual(['Approved', 'Rejected']);
    el.querySelectorAll<HTMLButtonElement>('.outcome-btn')[1].click();
    f.detectChanges();
    const remark = el.querySelector<HTMLTextAreaElement>('#fd_remark')!;
    remark.value = 'Deficiencies not rectified.';
    remark.dispatchEvent(new Event('input'));
    f.detectChanges();
    await wait(350);
    f.detectChanges();
    expect(el.querySelector('app-rejection-letter')).not.toBeNull();
  });

  it('defaults the validity for a non-Provisional approval and lets the officer override it', async () => {
    const f = await render(106, ['approve', 'reject']); // Renewal
    const el = f.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLButtonElement>('.outcome-btn')[0].click(); // Approved
    f.detectChanges();
    await wait(350);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    const from = el.querySelector<HTMLInputElement>('#fd_from')!;
    expect(from.value).not.toBe('');
    expect(f.componentInstance['validTo']()).not.toBe('');
  });

  it('an "inspect" decision needs no remark / signed copy', async () => {
    const f = await render(107, ['approve', 'return', 'reject', 'inspect']);
    const el = f.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLButtonElement>('.outcome-btn').item(3).click();
    f.detectChanges();
    expect(el.querySelector('.problems')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('.decision-actions button')!.disabled).toBe(false);
  });
});
