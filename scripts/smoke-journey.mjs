/**
 * The journeys of phases B2 and B3 against a running API (used by scripts/smoke.sh):
 *
 *   citizen     create → save → upload every required PDF → pay → submit → the
 *               application is numbered and appears in the officer's queue; the
 *               stored file comes back through a one-time download token;
 *   department  every officer of the P-MSB workflow submits his note / report,
 *               the issuing authority uploads the signed NOC and approves;
 *   citizen     sees the NOC issued, prints the certificate, rates the service;
 *   registration  the "set your password" link works once;
 *   reports / admin  a report as CSV, statuses, escalations, unassigned tasks.
 *
 *   node scripts/smoke-journey.mjs http://127.0.0.1:3999
 *
 * Prints one ✓/✗ line per check and a final "RESULT <passed> <failed>" line.
 */
import { requiredDocuments } from '@srisaa/noc-domain';
import { advanceToDecision } from './lib/workflow.mjs';

const API = `${process.argv[2] ?? 'http://127.0.0.1:3000'}/api/v1`;
const PDF = new Blob(['%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'], { type: 'application/pdf' });
const UNDERTAKINGS = ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'];
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${name}` : `  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(username, password = 'demo') {
  const r = await call('POST', '/auth/login', null, { username, password });
  return r.json?.accessToken;
}

/**
 * Takes a submitted application through its workflow: every open task is
 * submitted by its officer (tasks that must wait for another are retried),
 * then the issuing authority uploads the signed NOC and approves.
 */
async function processToDecision(id, app) {
  const tokens = {};
  const as = async (username) => (tokens[username] ??= await login(username));
  const run = await advanceToDecision({ call, login: as, id, app });
  if (run.stuck) {
    check('every officer could submit his task', false, `stuck at ${run.stuck.join(', ')}`);
    return run.app;
  }
  app = run.app;
  check(`the officers submitted their notes (${run.officers.join(', ')})`, run.officers.length >= 5, `${run.officers.length}`);
  const decision = run.decision;
  check('the file reaches the issuing authority', !!decision, app.stage_label);
  if (!decision) return app;
  const approver = await as(decision.assignee);
  const early = await call('POST', `/dept/applications/${id}/tasks/${decision.task_id}/decide`, approver, { outcome: 'approve', input: { remark: 'Approved.' } });
  check('a decision needs the signed NOC first', early.status === 422, `${early.status}`);
  const form = new FormData();
  form.append('file', PDF, 'signed-noc.pdf');
  const signed = await call('POST', `/dept/applications/${id}/tasks/${decision.task_id}/signed-copy`, approver, form);
  check('the signed NOC is uploaded', signed.status === 201, `${signed.status} ${signed.text.slice(0, 120)}`);
  const preview = await call('POST', `/dept/applications/${id}/tasks/${decision.task_id}/decision-preview`, approver, { outcome: 'approve', input: { remark: 'All conditions met.' } });
  check('the decision is previewed on the server', preview.status === 200 && preview.json?.application?.status_id === 7, `${preview.status}`);
  const decided = await call('POST', `/dept/applications/${id}/tasks/${decision.task_id}/decide`, approver, { outcome: 'approve', input: { remark: 'All conditions met.' } });
  check(`the issuing authority (${decision.assignee}) approves`, decided.status === 200 && decided.json?.application?.status_id === 7, `${decided.status} ${decided.text.slice(0, 160)}`);
  return decided.json?.application ?? app;
}

try {
  const citizen = await login('citizen1');
  const template = (await call('GET', '/applications/101', citizen)).json;
  const docRules = (await call('GET', '/lookups/document-requirements')).json;

  const created = await call('POST', '/applications', citizen, { appl_type: 'P', site_name: 'Smoke Test Towers', site_addr: 'Plot 1, Smoke Nagar' });
  check('a citizen creates a draft (POST /applications)', created.status === 201, `${created.status} ${created.text.slice(0, 120)}`);
  const id = created.json?.application?.appl_id;

  const draft = (await call('GET', `/applications/${id}`, citizen)).json;
  const payload = {
    ...draft,
    district: template.district,
    fire_station_id: template.fire_station_id,
    corr_addr: template.corr_addr,
    plot_area: template.plot_area,
    perimeter: template.perimeter,
    lic_auth: template.lic_auth,
    lic_addr: template.lic_addr,
    parties: template.parties,
    blocks: template.blocks,
    declaration_accepted: true,
  };
  const saved = await call('PUT', `/applications/${id}`, citizen, payload, { 'if-match': `"r${draft.row_version}"` });
  check('the whole application is saved and assessed on the server', saved.status === 200 && saved.json?.assessment?.approvalLevel === 'MSB', `${saved.status}`);
  const stale = await call('PUT', `/applications/${id}`, citizen, payload, { 'if-match': `"r${draft.row_version}"` });
  check('a stale save is refused (409, optimistic locking)', stale.status === 409, `${stale.status}`);

  const app = saved.json.application;
  let uploaded = 0;
  let lastFile;
  for (const d of requiredDocuments(app, docRules).filter((x) => !x.optional && x.code !== 'ChallanCopy')) {
    const form = new FormData();
    form.append('code', d.code);
    form.append('file', PDF, `${d.code.replace(/:/g, '-')}.pdf`);
    const r = await call('POST', `/applications/${id}/documents`, citizen, form);
    if (r.status === 201) {
      uploaded++;
      lastFile = r.json.application.documents.find((x) => x.code === d.code);
    } else check(`upload ${d.code}`, false, `${r.status} ${r.text.slice(0, 120)}`);
  }
  check(`every required document is uploaded (${uploaded} PDFs)`, uploaded > 0);

  const fake = new FormData();
  fake.append('code', 'AdditionalDoc');
  fake.append('file', new Blob(['MZ not a pdf'], { type: 'application/pdf' }), 'fake.pdf');
  check('a non-PDF named .pdf is refused (415)', (await call('POST', `/applications/${id}/documents`, citizen, fake)).status === 415);

  const token = await call('POST', `/files/${lastFile?.file_id}/download-token`, citizen);
  const file = token.json?.url ? await fetch(`${API.replace('/api/v1', '')}${token.json.url}`) : null;
  check('the stored file is served through a one-time token', file?.status === 200 && file.headers.get('content-type') === 'application/pdf');
  const again = token.json?.url ? await fetch(`${API.replace('/api/v1', '')}${token.json.url}`) : null;
  check('the token cannot be used twice', again?.status === 404);

  const early = await call('POST', `/applications/${id}/submit`, citizen, { undertakings: UNDERTAKINGS });
  check('submission waits for the payment', early.status === 422);

  const paid = await call('POST', `/applications/${id}/payment`, citizen, { mode: 'online' }, { 'idempotency-key': `smoke-${id}` });
  check('the fee is paid online and frozen', paid.status === 200 && paid.json?.payment?.frozen === true && paid.json?.payment?.due === 0, `${paid.status}`);

  const submitted = await call('POST', `/applications/${id}/submit`, citizen, { undertakings: UNDERTAKINGS });
  const number = submitted.json?.application?.appl_number ?? '';
  check('the application is submitted and numbered (yyyymm + 5 digits)', submitted.status === 200 && /^\d{11}$/.test(number), `${submitted.status} ${number || submitted.text.slice(0, 160)}`);
  check('the workflow has started', submitted.json?.application?.workflow?.definition_code === 'P-MSB');

  const officer = await login('section.hq');
  const queue = (await call('GET', '/applications?scope=dept&pageSize=all', officer)).json;
  check('the new file is in the officer queue', !!queue?.items?.some((a) => a.appl_id === id));

  const revisions = (await call('GET', `/applications/${id}/revisions`, citizen)).json;
  check('a revision snapshot is kept', Array.isArray(revisions) && revisions.some((r) => r.kind === 'submitted'));

  // ── Department (B3): the whole P-MSB workflow ───────────────────────────────
  const decided = await processToDecision(id, submitted.json.application);
  const mine = (await call('GET', `/applications/${id}`, citizen)).json;
  check('the citizen sees the NOC issued (status 7, validity set)', mine?.status_id === 7 && !!mine?.final_date, `${mine?.status_id}`);
  const certificate = await call('GET', `/applications/${id}/certificate/certificate`, citizen);
  check('the certificate facts are served', certificate.status === 200 && certificate.json?.application?.appl_number === number, `${certificate.status}`);
  const rated = await call('POST', `/applications/${id}/feedback`, citizen, { rating: 5, remarks: 'Quick and clear.' });
  check('the citizen rates the service', rated.status === 200, `${rated.status}`);
  check('the decision kept a retained snapshot', ((await call('GET', `/applications/${id}/revisions`, citizen)).json ?? []).some((r) => r.kind === 'decided'));
  void decided;

  // ── Registration (B2-4): the "set your password" link ───────────────────────
  const email = `smoke.${Date.now()}@example.com`;
  const registered = await call('POST', '/auth/register', null, { name: 'Smoke Citizen', mobile: '9876501234', email });
  const link = registered.json?.setPasswordUrl ? new URL(registered.json.setPasswordUrl) : null;
  check('registration e-mails a "set your password" link', registered.status === 201 && !!link?.searchParams.get('token'), `${registered.status}`);
  const setPassword = await call('POST', '/auth/reset-password', null, { token: link?.searchParams.get('token'), newPassword: 'Smoke#Pass2026' });
  check('the link sets the password', setPassword.status === 204, `${setPassword.status} ${setPassword.text.slice(0, 120)}`);
  check('the new citizen signs in', !!(await login(email, 'Smoke#Pass2026')));
  const reused = await call('POST', '/auth/reset-password', null, { token: link?.searchParams.get('token'), newPassword: 'Other#Pass2026' });
  check('the link works only once', reused.status >= 400, `${reused.status}`);

  // ── Reports and administration (B3) ─────────────────────────────────────────
  const monitor = await login('monitor.hq');
  const csv = await call('GET', '/dept/reports/statistics?format=csv', monitor);
  check('a report downloads as CSV', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') ?? '') && csv.text.includes('Total'), `${csv.status}`);
  const pendency = await call('GET', '/dept/reports/pendency', monitor);
  check('the pendency report is computed on the server', pendency.status === 200 && !!pendency.json?.matrix, `${pendency.status}`);
  const admin = await login('admin');
  const statuses = await call('GET', '/admin/statuses', admin);
  check('the statuses are listed with their usage', statuses.status === 200 && statuses.json?.items?.length >= 9, `${statuses.status}`);
  const escalations = await call('GET', '/admin/escalations/preview', admin);
  check('the escalation preview lists the overdue items', escalations.status === 200 && Array.isArray(escalations.json?.overdue), `${escalations.status}`);
  const unassigned = await call('GET', '/admin/unassigned-tasks', admin);
  check('unassigned tasks are listed', unassigned.status === 200 && Array.isArray(unassigned.json?.items), `${unassigned.status}`);
} catch (e) {
  check('journey completed without an exception', false, String(e?.stack ?? e));
}

console.log(`RESULT ${pass} ${fail}`);
process.exit(fail === 0 ? 0 : 1);
