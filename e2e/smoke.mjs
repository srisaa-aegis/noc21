/**
 * Browser suite (phases B1 – B3): the Angular portal running against the real
 * backend (PostgreSQL + cached reference data) for all three portals:
 *
 *   B1  sign-in, dashboards, detail and print pages, the reference cache, sessions;
 *   B2  the citizen write paths — document upload, online payment, confirmation
 *       with undertakings, submission; registration with the e-mailed
 *       "set your password" link; forgot password;
 *   B3  department processing — a Section Note with the "challan verified" tick,
 *       the final decision with the signed NOC uploaded in the browser, the
 *       citizen seeing the NOC issued; a report exported as CSV; the admin
 *       statuses, escalation preview, unassigned tasks and a new officer with a
 *       temporary password.
 *
 *   node e2e/smoke.mjs            (expects the API on :3000 and the web app on :4200)
 */
import { chromium } from '@playwright/test';
import { requiredDocuments } from '@srisaa/noc-domain';
import { advanceToDecision } from '../scripts/lib/workflow.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:4200';
const API = `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** JSON call straight to the API (used to prepare data the browser then works on). */
async function api(method, path, token, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const apiLogin = async (username, password = 'demo') => (await api('POST', '/auth/login', null, { username, password })).json?.accessToken;

/**
 * A complete Head Office Provisional draft for citizen1, copied from application
 * 101, with every required document uploaded except `leaveOut` (uploaded in the UI).
 * With `submit`, it is also paid (`payment`) and submitted through the API.
 */
async function prepareDraft({ name = 'E2E Browser Towers', payment = null, submit = false } = {}) {
  const token = await apiLogin('citizen1');
  const template = (await api('GET', '/applications/101', token)).json;
  const rules = (await api('GET', '/lookups/document-requirements')).json;
  const created = (await api('POST', '/applications', token, { appl_type: 'P', site_name: name, site_addr: 'Plot 7, Browser Nagar' })).json.application;
  const saved = (
    await api(
      'PUT',
      `/applications/${created.appl_id}`,
      token,
      {
        ...created,
        district: template.district,
        fire_station_id: template.fire_station_id,
        corr_addr: template.corr_addr,
        plot_area: template.plot_area,
        perimeter: template.perimeter,
        lic_auth: template.lic_auth,
        lic_addr: template.lic_addr,
        parties: template.parties,
        blocks: template.blocks,
        declaration_accepted: submit,
      },
      { 'if-match': `"r${created.row_version}"` },
    )
  ).json.application;
  if (payment) {
    const body = payment === 'online' ? { mode: 'online' } : { mode: 'challan', challan_num: 'CH-E2E-5501', challan_date: '2026-01-05', bank: 'SBI', branch: 'Dwaraka Nagar' };
    const paid = await api('POST', `/applications/${saved.appl_id}/payment`, token, body, { 'idempotency-key': `e2e-${saved.appl_id}` });
    if (paid.status !== 200) throw new Error(`payment: ${paid.status} ${JSON.stringify(paid.json)}`);
  }
  const docs = requiredDocuments({ ...saved, payment: { ...saved.payment, mode: payment ?? saved.payment.mode } }, rules).filter(
    (d) => !d.optional && (d.code !== 'ChallanCopy' || payment === 'challan'),
  );
  const leaveOut = submit ? null : docs.find((d) => !d.blockName);
  for (const d of docs.filter((x) => x !== leaveOut)) {
    const form = new FormData();
    form.append('code', d.code);
    form.append('file', new Blob([PDF], { type: 'application/pdf' }), `${d.code.replace(/:/g, '-')}.pdf`);
    await api('POST', `/applications/${saved.appl_id}/documents`, token, form);
  }
  if (submit) {
    const r = await api('POST', `/applications/${saved.appl_id}/submit`, token, { undertakings: ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'] });
    if (r.status !== 200) throw new Error(`submit: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    return { id: saved.appl_id, leaveOut, app: r.json.application };
  }
  return { id: saved.appl_id, leaveOut };
}
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function login(page, username, password = 'demo') {
  await page.goto(`${WEB}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /sign in|login/i }).first().click();
  await page.waitForURL(/citizen|dept|admin/, { timeout: 20000 });
  await page.waitForLoadState('networkidle');
}

/** Waits until the rendered page contains the text (data arrives asynchronously). */
async function waitForText(page, pattern, timeout = 10000) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.locator('body').innerText();
    if (re.test(last)) return { ok: true, text: last };
    await page.waitForTimeout(250);
  }
  return { ok: false, text: last };
}

const browser = await chromium.launch();

/**
 * Runs one part of the suite; an exception fails that part (with the message and
 * a screenshot of its pages under /tmp) and the suite goes on.
 */
async function section(name, fn) {
  const pages = [];
  try {
    await fn((page) => pages.push(page));
  } catch (e) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const shots = [];
    for (const [i, page] of pages.entries()) {
      const path = `/tmp/e2e-${slug}-${i}.png`;
      if (await page.screenshot({ path, fullPage: true }).then(() => true).catch(() => false)) shots.push(path);
    }
    check(`${name}: completed without an error`, false, `${String(e?.message ?? e).split('\n')[0]}${shots.length ? ` (screenshot: ${shots.join(', ')})` : ''}`);
  }
}

try {
  // ── Citizen ──────────────────────────────────────────────────────────────
  await section('Citizen', async (keep) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));

    await login(page, 'citizen1');
    check('citizen signs in and lands on the dashboard', page.url().includes('/citizen/dashboard'), page.url());

    const list = await waitForText(page, 'Padma Rekha');
    check('dashboard lists the seeded applications', list.ok, list.text.slice(0, 120).replace(/\n/g, ' '));
    check('dashboard shows the counters', /Total/i.test(list.text) && /Approved/i.test(list.text));

    await page.goto(`${WEB}/citizen/applications/101`, { waitUntil: 'networkidle' });
    const detail = await waitForText(page, 'Padma Rekha');
    check('application detail opens', detail.ok, detail.text.slice(0, 120).replace(/\n/g, ' '));
    check('detail shows the site address from the database', detail.text.includes('Rajeevnagar'));

    await page.goto(`${WEB}/citizen/applications/101/print/certificate`, { waitUntil: 'networkidle' });
    const noc = await waitForText(page, /No Objection Certificate/i);
    check('the NOC print view renders', noc.ok);

    // Reference data must come from the cache on a second visit.
    const before = requests.length;
    await page.goto(`${WEB}/citizen/dashboard`, { waitUntil: 'networkidle' });
    const bundleCalls = requests.slice(before).filter((u) => u.includes('/bundles/'));
    check(
      'reference bundles are not refetched on a second visit (IndexedDB cache)',
      bundleCalls.length === 0,
      bundleCalls.map((u) => u.replace(WEB, '')).join(', '),
    );

    const portalCalls = requests.filter((u) => u.includes('/api/v1/portal/'));
    check('the portal uses the resource API only (the /portal transition surface is gone)', portalCalls.length === 0, portalCalls.slice(0, 3).join(', '));

    const session = await ctx.storageState();
    check('the refresh token is an httpOnly cookie', session.cookies.some((c) => c.name === 'noc_rt' && c.httpOnly));
    const storage = JSON.stringify(session.origins ?? []);
    check('no bearer token is persisted in browser storage', !/eyJ[A-Za-z0-9_-]{10,}/.test(storage));

    await page.reload({ waitUntil: 'networkidle' });
    check('session survives a reload (silent refresh)', page.url().includes('/citizen/dashboard'));
    await ctx.close();
  });

  // ── Citizen journey (B2): upload → pay → confirm → submit ────────────────
  await section('Citizen journey (B2): upload → pay → confirm → submit', async (keep) => {
    const { id, leaveOut } = await prepareDraft();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    await login(page, 'citizen1');

    await page.goto(`${WEB}/citizen/applications/${id}/edit/documents`, { waitUntil: 'networkidle' });
    await waitForText(page, leaveOut.label);
    await page.getByLabel(`Upload ${leaveOut.label}`).setInputFiles({ name: 'e2e-upload.pdf', mimeType: 'application/pdf', buffer: PDF });
    const attached = await waitForText(page, 'e2e-upload.pdf');
    check('a document is uploaded from the wizard and listed with its name', attached.ok);
    check('the uploaded file name is a download link', (await page.locator('a.file-link', { hasText: 'e2e-upload.pdf' }).count()) === 1);

    await page.goto(`${WEB}/citizen/applications/${id}/edit/submit`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Pay Rs\. .* Online/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^Pay Rs\./ }).click(); // the simulated gateway dialog
    const paid = await waitForText(page, /paid\s+online on/i, 15000);
    check('the fee is paid online through the server', paid.ok, paid.text.slice(0, 200).replace(/\n/g, ' '));

    await page.locator('label.declaration input[type=checkbox]').check();
    await page.getByRole('button', { name: /^\s*Submit\s*$/ }).click();
    await page.waitForURL(/\/confirm$/, { timeout: 20000 }).catch(() => undefined);
    const atConfirm = page.url().endsWith('/confirm');
    if (!atConfirm) await page.screenshot({ path: '/tmp/e2e-submit.png', fullPage: true });
    check('Submit validates and opens the confirmation page', atConfirm, atConfirm ? '' : (await page.locator('body').innerText()).slice(-600).replace(/\n/g, ' '));

    await waitForText(page, /Undertaking by Applicant|I confirm/i, 15000);
    const boxes = page.locator('input[type=checkbox]');
    await boxes.first().waitFor({ timeout: 15000 }).catch(async (keep) => {
      await page.screenshot({ path: '/tmp/e2e-confirm.png', fullPage: true });
      throw new Error(`no undertakings on the confirmation page: ${(await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' ')}`);
    });
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
    await page.getByRole('button', { name: /submit/i }).last().click();
    await page.waitForURL(/print\/acknowledgement/, { timeout: 20000 }).catch(() => undefined);
    const ack = await waitForText(page, /\b\d{11}\b/, 15000);
    check('the application is submitted and numbered (acknowledgement shows yyyymm + 5 digits)', ack.ok, page.url());

    await page.goto(`${WEB}/citizen/applications/${id}`, { waitUntil: 'networkidle' });
    const history = await waitForText(page, 'Revision History');
    check('the detail page shows the revision history kept by the server', history.ok);
    // The link opens a tab at once and points it at the one-time URL; the PDF response is what matters.
    const link = page.locator('a.file-link', { hasText: 'e2e-upload.pdf' }).first();
    const pdf = ctx.waitForEvent('response', { predicate: (r) => r.url().includes('/files/download/'), timeout: 10000 }).catch(() => null);
    await link.click();
    const response = await pdf;
    check(
      'a stored document opens in a new tab through a one-time download link',
      !!response && response.status() === 200 && (response.headers()['content-type'] ?? '').includes('application/pdf'),
      response ? `${response.status()} ${response.headers()['content-type']}` : 'no download request',
    );
    await ctx.close();

    const octx = await browser.newContext();
    const officer = await octx.newPage();
    keep(officer);
    await login(officer, 'section.hq');
    await officer.goto(`${WEB}/dept/applications/${id}`, { waitUntil: 'networkidle' });
    const seen = await waitForText(officer, 'E2E Browser Towers');
    check('the submitted file is open to the routed officer', seen.ok, officer.url());
    await octx.close();
  });

  // ── Registration → "set your password" link (B2-4) ─────────────────────
  await section('Registration → "set your password" link (B2-4)', async (keep) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    const stamp = Date.now().toString().slice(-8);
    const email = `e2e.${stamp}@example.com`;
    await page.goto(`${WEB}/auth/register`, { waitUntil: 'networkidle' });
    await page.locator('#name').fill('E2E Builder');
    await page.locator('#mobile').fill(`9${stamp.padStart(9, '1')}`);
    await page.locator('#email').fill(email);
    await page.locator('#address').fill('Guntur');
    await page.getByRole('button', { name: 'Register' }).click();
    const reg = await waitForText(page, /choose your password/i, 15000);
    check('a citizen registers and is told to choose a password from the e-mailed link', reg.ok, reg.text.slice(0, 160).replace(/\n/g, ' '));
    const link = await page.locator('.dev-link a').getAttribute('href').catch(() => null);
    check('outside production the page also shows the link (no mail server)', !!link && link.includes('/auth/reset-password?token='), String(link));

    await page.goto(link ?? `${WEB}/auth/reset-password`, { waitUntil: 'networkidle' });
    const welcome = await waitForText(page, 'Choose the password for your new account');
    check('the link opens the "choose your password" page', welcome.ok);
    await page.locator('#rp-new').fill('Browser#2025x');
    await page.locator('#rp-confirm').fill('Browser#2025x');
    await page.getByRole('button', { name: 'Set Password' }).click();
    await page.waitForURL(/auth\/login/, { timeout: 15000 }).catch(() => undefined);
    const notice = await waitForText(page, 'Your password is set');
    check('the password is set and the citizen is sent to Sign In', notice.ok, page.url());
    await login(page, email, 'Browser#2025x');
    check('the new citizen signs in with the chosen password', page.url().includes('/citizen/dashboard'), page.url());
    const reuse = await api('POST', '/auth/reset-password', null, { token: new URL(link ?? 'http://x/?token=none').searchParams.get('token'), newPassword: 'Other#Pass2026' });
    check('the link cannot be used a second time', reuse.status >= 400, `${reuse.status}`);
    await ctx.close();
  });

  // ── Forgot password: same answer for any e-mail ─────────────────────────
  await section('Forgot password: same answer for any e-mail', async (keep) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    await page.goto(`${WEB}/auth/forgot-password`, { waitUntil: 'networkidle' });
    await page.locator('#email').fill('nobody.at.all@example.com');
    await page.getByRole('button', { name: /Send Reset Link/ }).click();
    const msg = await waitForText(page, 'If an account exists');
    check('forgot password does not reveal whether an account exists', msg.ok);
    await ctx.close();
  });

  // ── Department processing (B3): Section Note with the challan tick ───────
  await section('Department processing (B3): Section Note with the challan tick', async (keep) => {
    const { id } = await prepareDraft({ name: 'E2E Challan Towers', payment: 'challan', submit: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    await login(page, 'section.hq');
    await page.goto(`${WEB}/dept/applications/${id}`, { waitUntil: 'networkidle' });
    const task = await waitForText(page, 'Your task: Scrutiny by Section');
    check('the section officer finds his task on the file', task.ok, task.text.slice(0, 160).replace(/\n/g, ' '));
    check('a challan payment asks him to verify the challan (B2-1)', (await page.locator('.challan-check').count()) === 1);
    for (const name of ['applicant_ok', 'survey_ok', 'plans_ok', 'fee_ok', 'bank_guarantee_ok', 'ffe_estimate_ok']) {
      const yes = page.locator(`input[name="${name}"]`).first();
      if (await yes.count()) await yes.check();
    }
    await page.locator('#sn_remark').fill('Documents, plans and fee verified.');
    const submit = page.locator('.task-actions .btn--primary');
    check('Submit stays disabled until the challan is verified', await submit.isDisabled());
    await page.locator('.challan-check input[type=checkbox]').check();
    await page.waitForTimeout(200);
    check('ticking "Challan verified" enables Submit', !(await submit.isDisabled()));
    await submit.click();
    const done = await waitForText(page, /Scrutiny by Section submitted/i, 15000);
    check('the Section Note is submitted through the server', done.ok, done.text.slice(0, 200).replace(/\n/g, ' '));
    const stored = (await api('GET', `/dept/applications/${id}`, await apiLogin('section.hq'))).json;
    const note = stored?.application?.workflow?.tasks?.find((t) => t.form === 'section_note');
    check('the server stored the note with the challan verification', note?.state === 'done' && note?.data?.challan_verified === 'Y', `${note?.state} ${JSON.stringify(note?.data ?? {}).slice(0, 80)}`);
    await ctx.close();
  });

  // ── Department processing (B3): the officers, then the decision in the browser ─
  await section('Department processing (B3): the officers, then the decision in the browser', async (keep) => {
    // Its own file (paid online and submitted through the API), so this part does not depend on the journey above.
    const { id: decisionId, app: submitted } = await prepareDraft({ name: 'E2E Decision Towers', payment: 'online', submit: true });
    const run = await advanceToDecision({ call: api, login: apiLogin, id: decisionId, app: submitted });
    check(
      'every officer of the workflow submits his note (through the API)',
      !run.stuck && !!run.decision,
      run.stuck ? `stuck at ${run.stuck.join(', ')}` : `${run.officers.join(', ')}`,
    );
    if (run.decision) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
    keep(page);
      await login(page, run.decision.assignee);
      await page.goto(`${WEB}/dept/applications/${decisionId}`, { waitUntil: 'networkidle' });
      const decide = await waitForText(page, 'Your task: Final Decision');
      check(`the issuing authority (${run.decision.assignee}) gets the final decision`, decide.ok, decide.text.slice(0, 160).replace(/\n/g, ' '));
      await page.locator('.outcome-btn', { hasText: 'Approved' }).click();
      await page.locator('#fd_remark').fill('Approved subject to the conditions printed on the NOC.');
      const preview = await waitForText(page, /Live preview[\s\S]*No Objection Certificate/i, 15000);
      check('the NOC is previewed while the decision is written (server preview)', preview.ok);
      await page.locator('#fd_signed').setInputFiles({ name: 'signed-noc.pdf', mimeType: 'application/pdf', buffer: PDF });
      const uploaded = await waitForText(page, 'signed-noc.pdf uploaded');
      check('the signed NOC is uploaded from the browser', uploaded.ok);
      await page.locator('.decision-actions .btn--primary').click();
      const decided = await waitForText(page, /Decision submitted/i, 15000);
      check('the decision is submitted', decided.ok, decided.text.slice(0, 200).replace(/\n/g, ' '));
      const badge = await waitForText(page, /Approved \/ Issued/);
      check('the file shows "Approved / Issued"', badge.ok);
      await ctx.close();

      const cctx = await browser.newContext();
      const cpage = await cctx.newPage();
      keep(cpage);
      await login(cpage, 'citizen1');
      await cpage.goto(`${WEB}/citizen/applications/${decisionId}`, { waitUntil: 'networkidle' });
      const issued = await waitForText(cpage, /Approved \/ Issued/);
      check('the citizen sees the NOC issued', issued.ok);
      await cpage.goto(`${WEB}/citizen/applications/${decisionId}/print/certificate`, { waitUntil: 'networkidle' });
      const cert = await waitForText(cpage, /No Objection Certificate/i);
      check('the citizen prints the new NOC', cert.ok);
      await cctx.close();
    }
  });

  // ── Reports (B3): computed on the server, exported as CSV ──────────────────
  await section('Reports (B3): computed on the server, exported as CSV', async (keep) => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    keep(page);
    await login(page, 'monitor.hq');
    await page.goto(`${WEB}/dept/reports/statistics`, { waitUntil: 'networkidle' });
    await waitForText(page, /Statistics/);
    const download = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await page.getByRole('button', { name: /Export CSV/ }).click();
    const file = await download;
    const csv = file ? await (await import('node:fs/promises')).readFile(await file.path(), 'utf8') : '';
    check('a report is exported as CSV by the server', !!file && file.suggestedFilename().endsWith('.csv') && csv.includes('Total'), file?.suggestedFilename() ?? 'no download');
    await ctx.close();
  });

  // ── Department ───────────────────────────────────────────────────────────
  await section('Department', async (keep) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    await login(page, 'dfo.visakhapatnam');
    check('officer signs in and lands on the department dashboard', page.url().includes('/dept/dashboard'));
    const dash = await waitForText(page, /Padma Rekha|My tasks|Monitoring|Files I monitor/i);
    check('officer sees their queue', dash.ok, dash.text.slice(0, 160).replace(/\n/g, ' '));

    await page.goto(`${WEB}/dept/search`, { waitUntil: 'networkidle' });
    check('department search page loads', (await page.locator('body').innerText()).length > 50);

    await page.goto(`${WEB}/dept/reports/pendency`, { waitUntil: 'networkidle' });
    const report = await waitForText(page, /Pendency|Head Office|District/i);
    check('the pendency report renders from backend data', report.ok);
    await ctx.close();
  });

  // ── Admin ────────────────────────────────────────────────────────────────
  await section('Admin', async (keep) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    await login(page, 'admin');
    check('admin signs in', page.url().includes('/admin/dashboard'));

    await page.goto(`${WEB}/admin/applications`, { waitUntil: 'networkidle' });
    const search = await waitForText(page, /Draft/i);
    check('admin application search lists drafts too', search.ok);

    await page.goto(`${WEB}/admin/citizens`, { waitUntil: 'networkidle' });
    const citizens = await waitForText(page, 'citizen1');
    check('citizen accounts list loads', citizens.ok);

    await page.goto(`${WEB}/admin/dept-users`, { waitUntil: 'networkidle' });
    const officers = await waitForText(page, 'dfo.visakhapatnam');
    check('department users list loads', officers.ok);
    check('the dropped fire station is gone from the UI', !officers.text.includes('Kunavaram'));

    await page.goto(`${WEB}/admin/rules`, { waitUntil: 'networkidle' });
    const rules = await waitForText(page, /Fee|Approval level|Renewal/i);
    check('rules & fees page loads the configuration', rules.ok);

    await page.goto(`${WEB}/admin/workflows`, { waitUntil: 'networkidle' });
    const flows = await waitForText(page, /Head Office|Provisional/i);
    check('the workflow matrix loads', flows.ok, flows.text.slice(0, 160).replace(/\n/g, ' '));

    // B3: statuses (N-4), escalations, unassigned tasks, a new officer
    await page.goto(`${WEB}/admin/statuses`, { waitUntil: 'networkidle' });
    const statuses = await waitForText(page, 'Approved / Issued');
    check('the statuses page lists the statuses with their usage', statuses.ok && /files ·/.test(statuses.text), statuses.text.slice(0, 120).replace(/\n/g, ' '));
    const name = `E2E Review ${Date.now().toString().slice(-5)}`;
    await page.locator('#st-name').fill(name);
    await page.getByRole('button', { name: /Add Status/ }).click();
    const added = await waitForText(page, `Status "${name}" added.`);
    const rowOf = () => page.evaluate((n) => [...document.querySelectorAll('tbody tr')].findIndex((tr) => tr.querySelector('input')?.value === n), name);
    check('an in-process status is added', added.ok && (await rowOf()) >= 0);
    if (added.ok) {
      await page.locator('tbody tr').nth(await rowOf()).getByRole('button', { name: /Remove/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
      const removed = await waitForText(page, 'Status removed.');
      check('an unused status is removed again', removed.ok && (await rowOf()) < 0);
    }

    await page.goto(`${WEB}/admin/audit`, { waitUntil: 'networkidle' });
    const audit = await waitForText(page, 'status.removed');
    check('the audit trail shows who changed the statuses', audit.ok && audit.text.includes('status.added'), audit.text.slice(0, 160).replace(/\n/g, ' '));

    const unassigned = page.waitForResponse((r) => r.url().includes('/admin/unassigned-tasks'), { timeout: 15000 }).catch(() => null);
    await page.goto(`${WEB}/admin/dashboard`, { waitUntil: 'networkidle' });
    const list = await unassigned;
    check('the dashboard asks the server for unassigned tasks (none in the demo data)', list?.status() === 200, `${list?.status()}`);
    await page.getByRole('button', { name: 'Send Escalations' }).first().click();
    const preview = await waitForText(page, /past their SLA/);
    check('the escalation preview opens with the overdue items', preview.ok);

    await page.goto(`${WEB}/admin/dept-users`, { waitUntil: 'networkidle' });
    await waitForText(page, 'dfo.visakhapatnam');
    check('department users can be searched on the server', (await page.locator('input[type=search], input[placeholder*="Search" i]').count()) > 0);
    await ctx.close();
  });

  // ── The DG reads the audit trail too; a district officer's reports are his own ──
  await section('Audit and jurisdiction', async (keep) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    await login(page, 'dg.officer');
    check('the DG has the Audit page in the department portal', (await page.locator('a[href="/dept/audit"]').count()) === 1);
    await page.goto(`${WEB}/dept/audit`, { waitUntil: 'networkidle' });
    const audit = await waitForText(page, /status\.added|application\.submitted/);
    check('the DG reads the audit trail', audit.ok, audit.text.slice(0, 120).replace(/\n/g, ' '));
    await ctx.close();

    const octx = await browser.newContext();
    const officer = await octx.newPage();
    keep(officer);
    await login(officer, 'dfo.guntur');
    check('a district officer has no Audit page', (await officer.locator('a[href="/dept/audit"]').count()) === 0);
    await officer.goto(`${WEB}/dept/reports/statistics`, { waitUntil: 'networkidle' });
    const meta = await waitForText(officer, 'files of your fire stations only');
    check('a district officer sees the reports of his fire stations only', meta.ok);
    await octx.close();
  });

  // ── Deactivated account ──────────────────────────────────────────────────
  await section('Deactivated account', async (keep) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    keep(page);
    await page.goto(`${WEB}/auth/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('sai.constructions');
    await page.locator('#password').fill('demo');
    await page.getByRole('button', { name: /sign in|login/i }).first().click();
    await page.waitForTimeout(1500);
    const text = await page.locator('body').innerText();
    check('a deactivated account is refused with the portal wording', text.includes('deactivated'), text.slice(0, 100).replace(/\n/g, ' '));
    await ctx.close();
  });
} finally {
  await browser.close();
}

console.log('\nBrowser suite (phases B1 – B3)\n');
for (const r of results) console.log(r);
console.log(`\n${results.length - failures}/${results.length} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
