import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { Application } from '../../core/models';
import { ToastService } from '../../shared/ui/toast.service';
import { ApplicationView } from './application-view';

/**
 * The department processing page against the fake backend: what the officer may do comes from the
 * server's `allowed_actions`, every action is one request whose body is asserted here, and the page
 * shows the view the server returns. The workflow transitions themselves are tested against the real
 * backend (backend/tests/integration/dept-workflow.spec.ts) and in the browser (e2e/).
 */
describe('ApplicationView (dept processing page)', () => {
  beforeEach(() => resetBrowserState());
  afterEach(() => resetBrowserState());

  let api: FakeApi;

  async function open(username: string, roleId: number, id: string, prepare?: (api: FakeApi) => void) {
    TestBed.resetTestingModule();
    seedSession(username, 'dept', roleId, username);
    await TestBed.configureTestingModule({ imports: [ApplicationView], providers: [provideRouter([]), provideFakeApi(prepare)] }).compileComponents();
    api = TestBed.inject(FakeApi);
    const f = TestBed.createComponent(ApplicationView);
    f.componentRef.setInput('id', id);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement };
  }

  /** ngModel writes land one microtask later; re-settle before reading DOM values. */
  async function settle(f: { detectChanges: () => void; whenStable: () => Promise<unknown> }): Promise<void> {
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
  }

  const byName = (el: HTMLElement, name: string) => Array.from(el.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));
  const button = (root: ParentNode, text: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text));
  const tab = (root: ParentNode, text: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('.tab')).find((b) => b.textContent?.includes(text))!;
  const confirm = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Confirm')!.click();

  function toastSpy() {
    return { success: vi.spyOn(TestBed.inject(ToastService), 'success'), error: vi.spyOn(TestBed.inject(ToastService), 'error') };
  }

  function selectByText(select: HTMLSelectElement, text: string): void {
    const option = Array.from(select.options).find((o) => o.textContent?.includes(text))!;
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
  }

  /**
   * Draft 104 (Provisional, MSB, fire station 26 Krishna) as the server holds it right after its
   * submission with a bank challan: the P-MSB scrutiny stage is open (section.hq ∥ dfo.officer ∥ sfo.krishna).
   */
  function submittedP104(fake: FakeApi): void {
    const a = fake.app(104);
    const template = fake.app(109).workflow!;
    a.status_id = 2;
    a.appl_number = '20261100001';
    a.applied_date = '07-Nov-2026';
    a.stage_label = 'Submitted';
    a.payment = { ...a.payment, mode: 'challan', status: 'paid', challan_num: 'CH-7781', challan_date: '06-Nov-2026', challan_bnk: 'SBI', challan_brch: 'Vijayawada' };
    const officers: Record<number, [string, string]> = { 1: ['section.hq', 'Section Officer (HQ)'], 2: ['dfo.officer', 'DFO - Krishna'], 3: ['sfo.krishna', 'SFO - Krishna'] };
    a.workflow = {
      ...structuredClone(template),
      started_on: '07-Nov-2026',
      tasks: template.tasks.map((t) => ({
        ...structuredClone(t),
        state: t.task_id <= 3 ? 'active' : 'waiting',
        start_date: t.task_id <= 3 ? '07-Nov-2026' : undefined,
        end_date: undefined,
        data: {},
        remarks: '',
        ...(officers[t.task_id] ? { assignee: officers[t.task_id][0], assignee_name: officers[t.task_id][1] } : {}),
      })),
    };
  }

  /** The next response of a route: the server's view after the action. */
  function respondWith(method: string, pattern: RegExp, change: (a: Application) => void): void {
    api.on(method, pattern, ({ params }) => {
      const a = api.app(Number(params[0]));
      change(a);
      return api.deptView(a.appl_id);
    });
  }

  it('shows the read-only view with the stage stepper, process steps, SLA and tabs', async () => {
    const { f, el } = await open('monitor.hq', 8, '109');
    expect(el.querySelector('.my-task')).toBeNull(); // no open task, no quick actions for a non-involved officer
    expect(el.querySelector('.quick-actions button')).toBeNull();
    expect(el.querySelectorAll('.stage').length).toBe(6);
    tab(el, 'SMS').click();
    await settle(f);
    expect(el.querySelectorAll('.sms-list li').length).toBe(2);
    expect(api.calls('GET', /^\/dept\/applications\/109$/)).toHaveLength(1);
  });

  it('Section Note with a challan payment: the officer must tick "Challan verified"; saves a draft and submits', async () => {
    const { f, el } = await open('section.hq', 10, '104', submittedP104);
    const toast = toastSpy();
    expect(el.querySelector('.my-task')?.textContent).toContain('Your task: Scrutiny by Section');
    expect(el.querySelector('app-section-note-form')).not.toBeNull();
    expect(el.querySelector('.challan-check')?.textContent).toContain('CH-7781');

    for (const name of ['applicant_ok', 'survey_ok', 'plans_ok', 'bank_guarantee_ok', 'ffe_estimate_ok']) byName(el, name)[0].click();
    await settle(f);
    const submit = () => button(el.querySelector('.task-actions')!, 'Submit Note')!;
    expect(submit().disabled).toBe(true); // remark still empty, challan not verified

    button(el, 'Save draft')!.click();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Draft saved.');
    const saved = api.calls('POST', /^\/dept\/applications\/104\/tasks\/1\/save$/);
    expect((saved[0].body as { data: Record<string, unknown> }).data['applicant_ok']).toBe('Y');

    const remark = el.querySelector<HTMLTextAreaElement>('#sn_remark')!;
    remark.value = 'All documents in order.';
    remark.dispatchEvent(new Event('input'));
    await settle(f);
    expect(el.querySelector('.problems')?.textContent).toContain('Challan verified');
    el.querySelector<HTMLInputElement>('.challan-check input')!.click();
    await settle(f);
    expect(el.querySelector('.problems')).toBeNull();

    respondWith('POST', /^\/dept\/applications\/(\d+)\/tasks\/1\/submit$/, (a) => {
      const t = a.workflow!.tasks[0];
      Object.assign(t, { state: 'done', end_date: '07-Nov-2026' });
    });
    submit().click();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Scrutiny by Section submitted.');
    const body = api.calls('POST', /^\/dept\/applications\/104\/tasks\/1\/submit$/)[0].body as { data: Record<string, unknown> };
    expect(body.data).toEqual(expect.objectContaining({ remark: 'All documents in order.', challan_verified: 'Y', applicant_ok: 'Y' }));
    expect(el.querySelector('.my-task')).toBeNull(); // the server's view: section.hq has no other task on this file
  });

  it('reloading keeps the saved draft of the task (merged with the form defaults)', async () => {
    const { el } = await open('section.hq', 10, '104', (fake) => {
      submittedP104(fake);
      fake.app(104).workflow!.tasks[0].data = { applicant_ok: 'Y', remark: 'Half way' };
    });
    expect(byName(el, 'applicant_ok')[0].checked).toBe(true);
    expect(el.querySelector<HTMLTextAreaElement>('#sn_remark')!.value).toBe('Half way');
  });

  it('Inspection Report: the committee chairman fills each block and submits', async () => {
    const { f, el } = await open('dfo.visakhapatnam', 6, '102');
    const toast = toastSpy();
    expect(el.querySelectorAll('.block-card').length).toBe(2);
    const data = f.componentInstance['taskData']() as {
      blocks: { block_id: number; open_spaces_ok: string; escapes_ok: string; floors_ok: string; ffe_ok: string; pnoc_complied: string }[];
      remark: string;
    };
    data.blocks.forEach((b) => Object.assign(b, { open_spaces_ok: 'Y', escapes_ok: 'Y', floors_ok: 'Y', ffe_ok: 'Y', pnoc_complied: 'Y' }));
    data.remark = 'Everything as declared.';
    el.querySelector<HTMLInputElement>(`input[name="os${data.blocks[0].block_id}"]`)!.dispatchEvent(new Event('change'));
    f.componentInstance['onFormChanged']();
    await settle(f);
    expect(el.querySelector('.computed')?.textContent).toContain('Recommend');
    expect(el.querySelector('.challan-check')).toBeNull(); // paid online
    button(el.querySelector('.task-actions')!, 'Submit Report')!.click();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Inspection Report (Committee Chairman) submitted.');
    const body = api.calls('POST', /^\/dept\/applications\/102\/tasks\/2\/submit$/)[0].body as { data: { remark: string; blocks: unknown[] } };
    expect(body.data.remark).toBe('Everything as declared.');
    expect(body.data.blocks).toHaveLength(2);
  });

  it('shows the server’s refusal of a submission (server-side form validation)', async () => {
    const { f, el } = await open('sfo.officer', 9, '102');
    const toast = toastSpy();
    expect(el.querySelector('app-committee-concurrence-form')).not.toBeNull();
    byName(el, 'agree')[0].click();
    await settle(f);
    api.fail('POST', /\/tasks\/3\/submit$/, 422, 'The inspection report has not been submitted yet.');
    button(el.querySelector('.task-actions')!, 'Submit')!.click();
    await settle(f);
    expect(toast.error).toHaveBeenCalledWith('The inspection report has not been submitted yet.');
    expect(el.querySelector('.my-task')).not.toBeNull();
  });

  it('sends the file back to the previous stage with the comments', async () => {
    const { f, el } = await open('dfs.officer', 2, '110');
    const toast = toastSpy();
    expect(el.querySelector('app-questionnaire-form')).not.toBeNull();
    button(el.querySelector('.task-actions')!, 'Send back')!.click();
    await settle(f);
    const comments = document.querySelector<HTMLTextAreaElement>('#sb_comments')!;
    comments.value = 'Please re-check the refuge areas.';
    comments.dispatchEvent(new Event('input'));
    await settle(f);
    respondWith('POST', /^\/dept\/applications\/(\d+)\/tasks\/7\/send-back$/, (a) => {
      a.workflow!.tasks.find((t) => t.task_id === 7)!.state = 'waiting';
    });
    confirm();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Sent back to the previous stage.');
    expect(api.calls('POST', /^\/dept\/applications\/110\/tasks\/7\/send-back$/)[0].body).toEqual({ comments: 'Please re-check the refuge areas.' });
    expect(el.querySelector('.my-task')).toBeNull();
  });

  it('the issuing authority bypasses and changes the officer of a pending task', async () => {
    const { f, el } = await open('dg.officer', 1, '102');
    const toast = toastSpy();
    const rows = () => Array.from(el.querySelectorAll('.pending-officers tbody tr'));
    const row = (name: string) => rows().find((r) => r.textContent?.includes(name));
    expect(rows().length).toBeGreaterThan(0);

    respondWith('POST', /^\/dept\/applications\/(\d+)\/tasks\/3\/skip$/, (a) => {
      Object.assign(a.workflow!.tasks.find((t) => t.task_id === 3)!, { state: 'skipped' });
    });
    button(row('Committee Member Concurrence')!, 'Bypass')!.click();
    await settle(f);
    confirm();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Officer bypassed.');
    expect(api.calls('POST', /^\/dept\/applications\/102\/tasks\/3\/skip$/)).toHaveLength(1);
    expect(row('Committee Member Concurrence')).toBeUndefined();

    button(row('Inspection Report')!, 'Change officer')!.click();
    await settle(f);
    const select = document.querySelector<HTMLSelectElement>('#reassign_to')!;
    // the candidates are the server's: active officers of the task's role, except the current one
    expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual(['DFO - Krishna', 'DFO - Guntur', 'DFO - Srikakulam']);
    selectByText(select, 'DFO - Krishna');
    const krishna = api.users.find((u) => u.username === 'dfo.officer')!;
    respondWith('POST', /^\/dept\/applications\/(\d+)\/tasks\/2\/reassign$/, (a) => {
      Object.assign(a.workflow!.tasks.find((t) => t.task_id === 2)!, { assignee: 'dfo.officer', assignee_name: 'DFO - Krishna' });
    });
    confirm();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Officer changed.');
    expect(api.calls('POST', /^\/dept\/applications\/102\/tasks\/2\/reassign$/)[0].body).toEqual({ to: krishna.id });
    expect(row('Inspection Report')?.textContent).toContain('DFO - Krishna');
  });

  it('requests a document, uploads a department document and sends an SMS', async () => {
    const { f, el } = await open('dfo.visakhapatnam', 6, '102');
    tab(el, 'Documents').click();
    await settle(f);
    respondWith('POST', /^\/dept\/applications\/(\d+)\/document-requests$/, (a) => {
      a.deptfiles.push({ fileid: 9, file_desc: 'Revised NBC compliance letter', status: 'R', requested_by: 'DFO - Visakhapatnam', requested_on: '07-Nov-2026' } as never);
    });
    button(el, 'Request a document')!.click();
    await settle(f);
    const desc = document.querySelector<HTMLInputElement>('#req_desc')!;
    desc.value = 'Revised NBC compliance letter';
    desc.dispatchEvent(new Event('input'));
    confirm();
    await settle(f);
    expect(api.calls('POST', /^\/dept\/applications\/102\/document-requests$/)[0].body).toEqual({ file_desc: 'Revised NBC compliance letter' });
    expect(el.textContent).toContain('Revised NBC compliance letter');

    respondWith('POST', /^\/dept\/applications\/(\d+)\/dept-documents$/, (a) => {
      a.dept_documents = [{ doc_id: 1, file_name: 'photo.pdf', description: 'Site photo', uploaded_by: 'DFO', uploaded_on: '07-Nov-2026', file_id: 'f1' } as never];
    });
    button(el, 'Upload')!.click();
    await settle(f);
    const input = document.querySelector<HTMLInputElement>('#up_file')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'photo.pdf', { type: 'application/pdf' })], configurable: true });
    input.dispatchEvent(new Event('change'));
    const upDesc = document.querySelector<HTMLInputElement>('#up_desc')!;
    upDesc.value = 'Site photo';
    upDesc.dispatchEvent(new Event('input'));
    await settle(f);
    confirm();
    await settle(f);
    const upload = api.calls('POST', /^\/dept\/applications\/102\/dept-documents$/)[0].body as Record<string, unknown>;
    expect(upload['file']).toEqual({ name: 'photo.pdf', size: 1 });
    expect(upload['description']).toBe('Site photo');
    expect(el.textContent).toContain('photo.pdf');

    tab(el, 'SMS').click();
    await settle(f);
    respondWith('POST', /^\/dept\/applications\/(\d+)\/sms$/, (a) => {
      a.sms = [...(a.sms ?? []), { sms_id: 99, message: 'Please keep the site ready for inspection.', sent_by: 'DFO', sent_on: '07-Nov-2026' } as never];
    });
    button(el.querySelector('[role="tabpanel"]')!, 'Send SMS')!.click();
    await settle(f);
    const sms = document.querySelector<HTMLTextAreaElement>('#sms_msg')!;
    sms.value = 'Please keep the site ready for inspection.';
    sms.dispatchEvent(new Event('input'));
    await settle(f);
    confirm();
    await settle(f);
    expect(api.calls('POST', /^\/dept\/applications\/102\/sms$/)[0].body).toEqual({ message: 'Please keep the site ready for inspection.' });
    expect(el.textContent).toContain('Please keep the site ready');
  });

  it('rejects a non-PDF department document before uploading', async () => {
    const { f, el } = await open('dfo.visakhapatnam', 6, '102');
    const toast = toastSpy();
    button(el, 'Upload document')!.click();
    await settle(f);
    const input = document.querySelector<HTMLInputElement>('#up_file')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('PDF'));
    confirm();
    await settle(f);
    expect(toast.error).toHaveBeenCalledWith('Choose a PDF file to upload.');
    expect(api.calls('POST', /dept-documents$/)).toHaveLength(0);
  });

  it('changes the fire station while the file is Submitted', async () => {
    const { f, el } = await open('section.hq', 10, '104', submittedP104);
    const toast = toastSpy();
    expect(el.textContent).toContain('Krishna');
    button(el, 'Change fire station')!.click();
    await settle(f);
    selectByText(document.querySelector<HTMLSelectElement>('#fs_district')!, 'Visakhapatnam');
    await settle(f);
    selectByText(document.querySelector<HTMLSelectElement>('#fs_station')!, 'Visakhapatnam');
    await settle(f);
    const station = Number(f.componentInstance['newStation']);
    respondWith('PUT', /^\/dept\/applications\/(\d+)\/fire-station$/, (a) => {
      a.district = 1 as never;
      a.fire_station_id = station;
    });
    confirm();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Fire station changed.');
    const body = api.calls('PUT', /^\/dept\/applications\/104\/fire-station$/)[0].body as { district: number; fire_station_id: number };
    expect(body.fire_station_id).toBe(station);
    expect(station).toBeGreaterThan(0);
  });

  it('offers "Update licensing authority" only for P / O files when the server allows it', async () => {
    const { el } = await open('dfs.officer', 2, '106');
    expect(el.querySelector('app-final-decision-form')).not.toBeNull();
    expect(button(el, 'Update licensing authority')).toBeUndefined(); // R, not P/O
  });

  it('the final decision uploads the signed copy, sends the decision and shows the server’s result', async () => {
    const { f, el } = await open('dfs.officer', 2, '106');
    Array.from(el.querySelectorAll<HTMLButtonElement>('.outcome-btn'))
      .find((b) => b.textContent?.includes('Approved'))!
      .click();
    await settle(f);
    const remark = document.querySelector<HTMLTextAreaElement>('#fd_remark')!;
    remark.value = 'Renewal approved; conditions complied.';
    remark.dispatchEvent(new Event('input'));
    await settle(f);
    const input = el.querySelector<HTMLInputElement>('#fd_signed')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'signed-noc.pdf', { type: 'application/pdf' })], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle(f);
    expect(api.calls('POST', /^\/dept\/applications\/106\/tasks\/7\/signed-copy$/)).toHaveLength(1);
    const toast = toastSpy();
    respondWith('POST', /^\/dept\/applications\/(\d+)\/tasks\/7\/decide$/, (a) => {
      a.status_id = 7;
      a.workflow!.tasks.find((t) => t.task_id === 7)!.state = 'done';
      a.workflow!.completed_on = '07-Nov-2026';
    });
    Array.from(el.querySelectorAll<HTMLButtonElement>('.decision-actions button'))[0].click();
    await settle(f);
    expect(toast.success).toHaveBeenCalledWith('Decision submitted.');
    const body = api.calls('POST', /^\/dept\/applications\/106\/tasks\/7\/decide$/)[0].body as { outcome: string; input: { remark: string } };
    expect(body.outcome).toBe('approve');
    expect(body.input.remark).toBe('Renewal approved; conditions complied.');
    expect(el.querySelector('app-status-badge')?.textContent).toContain('Approved');
    expect(el.querySelector('.my-task')).toBeNull();
  });
});
