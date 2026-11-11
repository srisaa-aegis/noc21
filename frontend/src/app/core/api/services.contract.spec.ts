import { TestBed } from '@angular/core/testing';
import { Observable, firstValueFrom } from 'rxjs';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { AdminService } from '../../features/admin/admin.service';
import { RulesConfigService } from '../../features/admin/rules-config.service';
import { WorkflowsAdminService } from '../../features/admin/workflows-admin.service';
import { DeptWorkflowService } from '../../features/dept/dept-workflow.service';
import { AccountsService } from '../accounts/accounts.service';
import { CitizenApi } from './citizen-api.service';

/**
 * The requests the feature services send: method, path, query and body. The
 * backend serves every path of the catalogue (backend/tests/integration/
 * contract.spec.ts) and the browser suites (e2e/) run these calls against it.
 */
describe('API services — the requests they send', () => {
  let api: FakeApi;

  beforeEach(() => {
    resetBrowserState();
    seedSession('admin', 'admin', 11);
    TestBed.configureTestingModule({ providers: [provideFakeApi()] });
    api = TestBed.inject(FakeApi);
    // Answer every write with an empty success; this suite only looks at the requests.
    for (const method of ['POST', 'PUT', 'DELETE']) api.on(method, /.*/, () => ({ items: [], application: null, account: null }));
  });

  afterEach(() => resetBrowserState());

  /** Runs a call and returns the request it made (errors are irrelevant here). */
  async function sent(call: () => Observable<unknown>) {
    const before = api.requests.length;
    await firstValueFrom(call()).catch(() => undefined);
    expect(api.requests.length, 'one request').toBe(before + 1);
    const r = api.requests.at(-1)!;
    return { method: r.method, path: r.path, query: r.query, body: r.body };
  }

  const pdf = () => new File(['%PDF'], 'a.pdf', { type: 'application/pdf' });

  it('CitizenApi: lifecycle, payment, documents, feedback', async () => {
    const c = TestBed.inject(CitizenApi);
    expect(await sent(() => c.listMine())).toEqual({ method: 'GET', path: '/applications', query: { scope: 'mine', pageSize: 'all' }, body: null });
    expect(await sent(() => c.submit(104, ['u1']))).toMatchObject({ method: 'POST', path: '/applications/104/submit', body: { undertakings: ['u1'] } });
    expect(await sent(() => c.pay(104, { mode: 'online' }))).toMatchObject({ method: 'POST', path: '/applications/104/payment', body: { mode: 'online' } });
    expect(await sent(() => c.revise(105))).toMatchObject({ method: 'POST', path: '/applications/105/revise' });
    expect(await sent(() => c.feedback(101, 4, 'Good'))).toMatchObject({ path: '/applications/101/feedback', body: { rating: 4, remarks: 'Good' } });
    expect(await sent(() => c.uploadDocument(104, 'SitePlan:1', pdf()))).toMatchObject({ path: '/applications/104/documents', body: { code: 'SitePlan:1', file: { name: 'a.pdf' } } });
    expect(await sent(() => c.removeDocument(104, 7))).toMatchObject({ method: 'DELETE', path: '/applications/104/documents/7' });
    expect(await sent(() => c.respondToRequest(102, 3, 'Here it is', pdf()))).toMatchObject({ path: '/applications/102/document-requests/3/response', body: { comment: 'Here it is' } });
    expect(await sent(() => c.occupancyFrom(101, []))).toMatchObject({ path: '/applications/101/occupancy', body: { conditions: [] } });
    expect(await sent(() => c.renewalFrom(111))).toMatchObject({ path: '/applications/111/renewal' });
    expect(await sent(() => c.downloadUrl('abc'))).toMatchObject({ method: 'POST', path: '/files/abc/download-token' });
  });

  it('DeptWorkflowService: queues and every task action', async () => {
    const d = TestBed.inject(DeptWorkflowService);
    expect(await sent(() => d.tasks())).toMatchObject({ method: 'GET', path: '/dept/tasks', query: { limit: '200' } });
    expect(await sent(() => d.tasks({ type: 'O', text: ' tower ' }))).toMatchObject({ query: { type: 'O', text: 'tower', limit: '200' } });
    expect(await sent(() => d.monitoring({ type: 'O', includeDecided: true, page: 2 }))).toMatchObject({
      path: '/dept/monitoring',
      query: { type: 'O', includeDecided: 'true', page: '2', pageSize: '50' },
    });
    expect(await sent(() => d.monitoring({ includeDecided: true, decidedAll: true }))).toMatchObject({ query: { includeDecided: 'true', decided: 'all' } });
    expect(await sent(() => d.search({ text: 'tower' }))).toMatchObject({ path: '/applications', query: { scope: 'dept', text: 'tower', pageSize: '50' } });
    expect(await sent(() => d.feedback(3))).toMatchObject({ path: '/dept/feedback-summary', query: { months: '3' } });
    expect(await sent(() => d.view(102))).toMatchObject({ method: 'GET', path: '/dept/applications/102' });
    expect(await sent(() => d.saveTask(102, 2, { remark: 'x' }))).toMatchObject({ path: '/dept/applications/102/tasks/2/save', body: { data: { remark: 'x' } } });
    expect(await sent(() => d.submitTask(102, 2, { remark: 'x' }))).toMatchObject({ path: '/dept/applications/102/tasks/2/submit', body: { data: { remark: 'x' } } });
    expect(await sent(() => d.sendBack(110, 7, 'why'))).toMatchObject({ path: '/dept/applications/110/tasks/7/send-back', body: { comments: 'why' } });
    expect(await sent(() => d.skipTask(102, 3))).toMatchObject({ path: '/dept/applications/102/tasks/3/skip' });
    expect(await sent(() => d.reassignTask(102, 2, 14))).toMatchObject({ path: '/dept/applications/102/tasks/2/reassign', body: { to: 14 } });
    expect(await sent(() => d.uploadSignedCopy(106, 7, pdf()))).toMatchObject({ path: '/dept/applications/106/tasks/7/signed-copy', body: { file: { name: 'a.pdf' } } });
    expect(await sent(() => d.decisionPreview(106, 7, 'approve', { remark: 'ok' }))).toMatchObject({
      path: '/dept/applications/106/tasks/7/decision-preview',
      body: { outcome: 'approve', input: { remark: 'ok' } },
    });
    expect(await sent(() => d.decide(106, 7, 'reject', { remark: 'no' }))).toMatchObject({ path: '/dept/applications/106/tasks/7/decide', body: { outcome: 'reject', input: { remark: 'no' } } });
    expect(await sent(() => d.requestDocuments(102, 'NBC letter'))).toMatchObject({ path: '/dept/applications/102/document-requests', body: { file_desc: 'NBC letter' } });
    expect(await sent(() => d.uploadDocument(102, pdf(), 'photo'))).toMatchObject({ path: '/dept/applications/102/dept-documents', body: { description: 'photo' } });
    expect(await sent(() => d.sendSms(102, 'hello'))).toMatchObject({ path: '/dept/applications/102/sms', body: { message: 'hello' } });
    expect(await sent(() => d.changeFireStation(104, 1, 3))).toMatchObject({ method: 'PUT', path: '/dept/applications/104/fire-station', body: { district: 1, fire_station_id: 3 } });
    expect(await sent(() => d.updateLicensingAuthority(102, 'VMC', 'MG Road'))).toMatchObject({
      method: 'PUT',
      path: '/dept/applications/102/licensing-authority',
      body: { lic_auth: 'VMC', lic_addr: 'MG Road' },
    });
    expect(await sent(() => d.report('pendency', { level: 'MSB' }))).toMatchObject({ path: '/dept/reports/pendency', query: { level: 'MSB' } });
    expect(await sent(() => d.reportCsv('sms', {}))).toMatchObject({ path: '/dept/reports/sms', query: { format: 'csv' } });
  });

  it('AccountsService: accounts, passwords, activation and hand-over', async () => {
    const a = TestBed.inject(AccountsService);
    expect(await sent(() => a.page({ portal: 'dept', q: 'dfo', active: false }))).toMatchObject({
      path: '/admin/accounts',
      query: { portal: 'dept', q: 'dfo', active: 'false', page: '1', pageSize: '100' },
    });
    expect(await sent(() => a.setPassword(5))).toMatchObject({ method: 'POST', path: '/admin/accounts/5/password', body: {} });
    expect(await sent(() => a.setPassword(5, 'Str0ng#Pass'))).toMatchObject({ body: { password: 'Str0ng#Pass' } });
    expect(await sent(() => a.setActive(5, false))).toMatchObject({ method: 'PUT', path: '/admin/accounts/5/active', body: { active: false } });
    expect(await sent(() => a.updateCitizen(1, { displayName: 'A', email: 'a@b.c', mobile: '9876543210' }))).toMatchObject({ method: 'PUT', path: '/admin/accounts/1/profile' });
    const officer = { displayName: 'DFO', email: 'd@f.o', mobile: '9876543210', role_id: 6, fire_station_ids: [1] };
    expect(await sent(() => a.createDeptUser({ username: 'dfo.x', ...officer }))).toMatchObject({ method: 'POST', path: '/admin/accounts/dept', body: { username: 'dfo.x', role_id: 6 } });
    expect(await sent(() => a.updateDeptUser(9, officer))).toMatchObject({ method: 'PUT', path: '/admin/accounts/9/dept', body: { fire_station_ids: [1] } });
    expect(await sent(() => a.openTasks(9))).toMatchObject({ method: 'GET', path: '/admin/accounts/9/open-tasks' });
    expect(await sent(() => a.handOver(9, 10))).toMatchObject({ method: 'POST', path: '/admin/accounts/9/handover', body: { to: 10 } });
  });

  it('AdminService: search, delete, escalations, unassigned tasks, statuses', async () => {
    const s = TestBed.inject(AdminService);
    expect(await sent(() => s.search({ draftsOnly: true, staleDays: 90 }))).toMatchObject({
      path: '/applications',
      query: { scope: 'all', draftsOnly: 'true', idleDays: '90', sort: '-days_idle', page: '1', pageSize: '100' },
    });
    expect(await sent(() => s.deleteApplications([112, 113]))).toMatchObject({ method: 'DELETE', path: '/admin/applications', body: { ids: [112, 113] } });
    expect(await sent(() => s.escalationPreview())).toMatchObject({ method: 'GET', path: '/admin/escalations/preview' });
    expect(await sent(() => s.sendEscalations())).toMatchObject({ method: 'POST', path: '/admin/escalations/send' });
    expect(await sent(() => s.escalationLog())).toMatchObject({ method: 'GET', path: '/admin/escalations/log' });
    expect(await sent(() => s.unassignedTasks())).toMatchObject({ method: 'GET', path: '/admin/unassigned-tasks' });
    expect(await sent(() => s.assignTask(102, 2, 14))).toMatchObject({ path: '/admin/applications/102/tasks/2/reassign', body: { to: 14 } });
    expect(await sent(() => s.addStatus({ desc: 'Site visit' }))).toMatchObject({ method: 'POST', path: '/admin/statuses', body: { desc: 'Site visit' } });
    expect(await sent(() => s.updateStatus(10, { active: false }))).toMatchObject({ method: 'PUT', path: '/admin/statuses/10', body: { active: false } });
    expect(await sent(() => s.removeStatus(10))).toMatchObject({ method: 'DELETE', path: '/admin/statuses/10' });
    expect(await sent(() => s.audit({ action: 'status.', page: 2 }))).toMatchObject({ method: 'GET', path: '/audit', query: { action: 'status.', page: '2', pageSize: '50' } });
  });

  it('Configuration: rules are validated in the browser first, then published on the server', async () => {
    const r = TestBed.inject(RulesConfigService);
    const before = api.requests.length;
    await expect(firstValueFrom(r.saveDelegationRules([]))).rejects.toThrow();
    expect(api.requests.length, 'an invalid rule set is not sent').toBe(before);
    const fees = api.feeConfig as never;
    expect(await sent(() => r.saveFees(fees))).toMatchObject({ method: 'PUT', path: '/config/fees' });
    const w = TestBed.inject(WorkflowsAdminService);
    expect(await sent(() => w.save({ ...api.workflows[0] }))).toMatchObject({ method: 'PUT', path: `/config/workflows/${api.workflows[0].code}` });
    expect(await sent(() => w.saveSla(api.sla))).toMatchObject({ method: 'PUT', path: '/config/sla' });
  });
});
