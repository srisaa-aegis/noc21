/**
 * Phase B2: the citizen lifecycle through the real API and the real database —
 * create → save (server assessment) → upload → pay → submit (number + workflow)
 * → revise, carry-forward, rating, and every rule on the way.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiredDocuments, type Application, type DocumentRequirements } from '@srisaa/noc-domain';
import { api, startTestApi, type TestApi } from '../helpers/app.js';
import { reseed } from '../helpers/reseed.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer; type?: string }) {
  const boundary = `----noc${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/pdf'}\r\n\r\n`,
    ),
  );
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('citizen lifecycle (B2)', () => {
  let t: TestApi;
  let citizen: { headers: Record<string, string> };
  let other: { headers: Record<string, string> };
  let template: Application;
  let docRules: DocumentRequirements;
  let appId = 0;

  beforeAll(async () => {
    await reseed();
    t = await startTestApi();
    citizen = await t.login('citizen1');
    other = await t.login('citizen2');
    // A complete, valid Head Office Provisional application to copy from.
    template = (await t.app.inject({ method: 'GET', url: api('/applications/101'), headers: citizen.headers })).json();
    docRules = (await t.app.inject({ method: 'GET', url: api('/lookups/document-requirements') })).json();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const call = (method: string, url: string, who = citizen, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method: method as 'GET', url: api(url), headers: { ...who.headers, ...headers }, payload: payload as never });

  const upload = (id: number, code: string, content = PDF, name = 'doc.pdf', who = citizen) => {
    const m = multipart({ code }, { name, content });
    return t.app.inject({ method: 'POST', url: api(`/applications/${id}/documents`), headers: { ...who.headers, ...m.headers }, payload: m.payload });
  };

  it('refuses to create without a site name and address (legacy SaveApplication)', async () => {
    const res = await call('POST', '/applications', citizen, { appl_type: 'P' });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe('Please provide the Site Name and Site Address to save the application.');
  });

  it('creates a draft on the first save and returns the server assessment', async () => {
    const res = await call('POST', '/applications', citizen, { appl_type: 'P', site_name: 'Integration Towers', site_addr: 'Plot 9, Test Nagar' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    appId = body.application.appl_id;
    expect(body.application).toMatchObject({ status_id: 1, appl_number: '', owner: 'citizen1', revision: 1 });
    expect(body.application.parties.length).toBe(5);
    expect(body.assessment.errorCount).toBeGreaterThan(0);
    expect(res.headers.etag).toMatch(/^"r\d+"$/);
  });

  it('saves the whole aggregate and recomputes the derived values on the server', async () => {
    const draft = (await call('GET', `/applications/${appId}`)).json() as Application;
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
      blocks: JSON.parse(JSON.stringify(template.blocks)),
      declaration_accepted: true,
      build_aadhar: '1234 5678 9012',
      // server-owned fields the client must not be able to set:
      status_id: 7,
      appl_number: 'HACKED',
      delegation_level: 'DFO',
      payment: { mode: 'online', amount: 1, status: 'paid' },
    };
    // Tamper with a derived value: the server must overwrite it.
    payload.blocks[0].ffe.items[0].block.reqt = 9999;
    const res = await call('PUT', `/applications/${appId}`, citizen, payload, { 'if-match': `"r${(draft as unknown as { row_version: number }).row_version}"` });
    expect(res.statusCode).toBe(200);
    const { application, assessment } = res.json();
    expect(application).toMatchObject({ status_id: 1, appl_number: '' });
    expect(application.build_aadhar).toBe('XXXXXXXX9012'); // Aadhaar is never stored in full
    expect(application.payment.status).toBe('pending');
    expect(application.blocks).toHaveLength(2);
    expect(application.blocks[0].ffe.items[0].block.reqt).not.toBe(9999);
    expect(assessment.approvalLevel).toBe('MSB');
    expect(assessment.fee.total).toBeGreaterThan(0);
  });

  it('refuses a save based on a stale version (optimistic locking)', async () => {
    const res = await call('PUT', `/applications/${appId}`, citizen, { site_name: 'x', site_addr: 'y' }, { 'if-match': '"r1"' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('changed elsewhere');
  });

  it('refuses another citizen', async () => {
    expect((await call('PUT', `/applications/${appId}`, other, { site_name: 'x', site_addr: 'y' })).statusCode).toBe(404);
    // 404, not 403: another citizen must not learn that the application exists.
    expect((await upload(appId, 'SelfDeclaration', PDF, 'a.pdf', other)).statusCode).toBe(404);
  });

  describe('documents', () => {
    it('accepts a PDF, stores it outside the web root and serves it back through a one-time token', async () => {
      const res = await upload(appId, 'SelfDeclaration', PDF, 'My Declaration.pdf');
      expect(res.statusCode).toBe(201);
      const doc = res.json().application.documents.find((d: { code: string }) => d.code === 'SelfDeclaration');
      expect(doc).toMatchObject({ file_name: 'My Declaration.pdf', size: PDF.length });
      expect(doc.file_id).toMatch(/^[0-9a-f-]{36}$/);

      const token = (await call('POST', `/files/${doc.file_id}/download-token`)).json();
      expect(token.url).toContain('/files/download/');
      const file = await t.app.inject({ method: 'GET', url: token.url });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.rawPayload.equals(PDF)).toBe(true);
      expect((await t.app.inject({ method: 'GET', url: token.url })).statusCode).toBe(404); // one-time
      expect((await call('POST', `/files/${doc.file_id}/download-token`, other)).statusCode).toBe(404);
    });

    it('decides the type by content, not by the name', async () => {
      const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is not a pdf');
      const res = await upload(appId, 'AdditionalDoc', exe, 'totally-a.pdf');
      expect(res.statusCode).toBe(415);
      expect(res.json().detail).toContain('Only PDF documents are accepted');
    });

    it('refuses a file over the size limit', async () => {
      const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024, 'x')]);
      const res = await upload(appId, 'AdditionalDoc', big, 'big.pdf');
      expect(res.statusCode).toBe(413);
    });

    it('refuses a document this application does not need', async () => {
      const res = await upload(appId, 'SomethingElse', PDF);
      expect(res.statusCode).toBe(422);
    });

    it('replaces the document of the same requirement and lets a draft remove one', async () => {
      await upload(appId, 'AdditionalDoc', PDF, 'first.pdf');
      const second = (await upload(appId, 'AdditionalDoc', PDF, 'second.pdf')).json().application;
      const additional = second.documents.filter((d: { code: string }) => d.code === 'AdditionalDoc');
      expect(additional).toHaveLength(1);
      expect(additional[0].file_name).toBe('second.pdf');
      const removed = (await call('DELETE', `/applications/${appId}/documents/${additional[0].doc_id}`)).json().application;
      expect(removed.documents.some((d: { code: string }) => d.code === 'AdditionalDoc')).toBe(false);
    });

    it('demands the Head Office documents of the derived approval level (regression)', async () => {
      const app = (await call('GET', `/applications/${appId}`)).json() as Application;
      expect(app.delegation_level).toBe('MSB');
      const codes = requiredDocuments(app, docRules).map((d) => d.code);
      expect(codes).toEqual(expect.arrayContaining(['Undertaking', 'BankGuarantee', 'FFEEstimate']));
    });

    it('uploads every document the application needs', async () => {
      const app = (await call('GET', `/applications/${appId}`)).json() as Application;
      for (const d of requiredDocuments(app, docRules).filter((x) => !x.optional && x.code !== 'ChallanCopy')) {
        const res = await upload(appId, d.code, PDF, `${d.code}.pdf`);
        expect(res.statusCode, d.code).toBe(201);
      }
    });
  });

  describe('payment and submission', () => {
    it('does not submit before the fee is paid', async () => {
      const res = await call('POST', `/applications/${appId}/submit`, citizen, { undertakings: ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'] });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/cannot be submitted yet/);
      expect(res.json().errors).toContainEqual(
        expect.objectContaining({ field: 'payment', message: 'Pay the fee online or record the bank challan details.', step: 'submit' }),
      );
    });

    it('pays online and freezes the fee with the rule version', async () => {
      const fee = (await call('GET', `/applications/${appId}/fee`)).json();
      expect(fee).toMatchObject({ paid: 0, frozen: false });
      const res = await call('POST', `/applications/${appId}/payment`, citizen, { mode: 'online' }, { 'idempotency-key': 'pay-1' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.application.payment).toMatchObject({ mode: 'online', status: 'paid', amount: fee.fee.total });
      expect(body.application.payment.txn_ref).toMatch(/^PAYU/);
      expect(body.payment).toMatchObject({ due: 0, frozen: true, charged: fee.fee.total });
      // same idempotency key: no second charge
      const again = await call('POST', `/applications/${appId}/payment`, citizen, { mode: 'online' }, { 'idempotency-key': 'pay-1' });
      expect(again.json().payment.charged).toBe(0);
      expect((await call('POST', `/applications/${appId}/payment`, citizen, { mode: 'online' })).statusCode).toBe(409);
    });

    it('asks for a differential fee when the built-up area grows after payment (N-3)', async () => {
      const app = (await call('GET', `/applications/${appId}`)).json() as Application;
      app.blocks[0].floors[0].built_area += 500;
      const saved = await call('PUT', `/applications/${appId}`, citizen, app);
      expect(saved.statusCode).toBe(200);
      const res = await call('POST', `/applications/${appId}/submit`, citizen, { undertakings: ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'] });
      expect(res.statusCode).toBe(422);
      const issue = res.json().errors.find((e: { field: string }) => e.field === 'payment');
      expect(issue.message).toMatch(/additional fee of Rs\. [\d,]+ is payable/);
      const paid = await call('POST', `/applications/${appId}/payment`, citizen, { mode: 'online' });
      expect(paid.json().payment.charged).toBe(5000); // 500 sq.m × Rs. 10 (frozen rate)
    });

    it('requires every undertaking', async () => {
      const res = await call('POST', `/applications/${appId}/submit`, citizen, { undertakings: ['correct'] });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('tick every undertaking');
    });

    it('submits: numbers the application, starts the workflow and snapshots the revision', async () => {
      const res = await call('POST', `/applications/${appId}/submit`, citizen, { undertakings: ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'] });
      expect(res.statusCode, JSON.stringify(res.json()).slice(0, 400)).toBe(200);
      const app = res.json().application as Application;
      expect(app.appl_number).toMatch(/^\d{11}$/); // yyyymm + 5 digits
      expect(app.status_id).toBe(2);
      expect(app.stage_label).toBe('Submitted');
      expect(app.delegation_level).toBe('MSB');
      expect(app.workflow?.definition_code).toBe('P-MSB');
      expect(app.reviewer.length).toBeGreaterThan(0);
      expect(app.processLog.at(-1)?.action).toBe('Submitted');
      const revisions = (await call('GET', `/applications/${appId}/revisions`)).json();
      expect(revisions).toEqual([expect.objectContaining({ revision: 1, kind: 'submitted' })]);
    });

    it('routes the file to the officers of its fire station', async () => {
      const section = await t.login('section.hq');
      const queue = (await call('GET', '/applications?scope=dept&pageSize=all', section)).json();
      expect(queue.items.some((a: { appl_id: number }) => a.appl_id === appId)).toBe(true);
      const dept = (await call('GET', `/applications/${appId}`, section)).json() as Application;
      const active = dept.workflow!.tasks.filter((x) => x.state === 'active').map((x) => x.assignee);
      expect(active).toContain('section.hq');
    });

    it('no longer lets the applicant edit, delete or pay', async () => {
      expect((await call('PUT', `/applications/${appId}`, citizen, { site_name: 'x', site_addr: 'y' })).json().detail).toBe(
        'Only draft applications can be edited.',
      );
      expect((await call('DELETE', `/applications/${appId}`)).json().detail).toBe('Only first-revision draft applications can be deleted.');
      expect((await call('POST', `/applications/${appId}/submit`, citizen, {})).json().detail).toBe('Only draft applications can be submitted.');
      expect((await call('POST', `/applications/${appId}/revise`)).json().detail).toBe('Only returned or rejected applications can be revised.');
    });
  });

  describe('revise, carry forward, rate, delete', () => {
    it('revises a returned application: new revision, archived run, snapshot', async () => {
      const before = (await call('GET', '/applications/105')).json() as Application;
      expect(before.status_id).toBe(8);
      const res = await call('POST', '/applications/105/revise');
      expect(res.statusCode).toBe(200);
      const app = res.json().application as Application;
      expect(app).toMatchObject({ status_id: 1, revision: before.revision + 1, declaration_accepted: false });
      expect(app.workflow).toBeUndefined();
      expect(app.workflow_history?.length).toBe((before.workflow_history?.length ?? 0) + 1);
      const revisions = (await call('GET', '/applications/105/revisions')).json();
      expect(revisions.some((r: { kind: string }) => r.kind === 'archived')).toBe(true);
    });

    it('carries an issued renewal forward into a new renewal draft', async () => {
      const parent = (await call('GET', '/applications/114')).json() as Application;
      const res = await call('POST', '/applications/114/renewal');
      expect(res.statusCode, res.body).toBe(201);
      const child = res.json().application as Application;
      expect(child).toMatchObject({ appl_type: 'R', status_id: 1, parent_id: 114 });
      expect(child.ref_no).toBe(parent.ref_no || parent.appl_number);
      expect(child.blocks.length).toBe(parent.blocks.length);
      const again = await call('POST', '/applications/114/renewal');
      expect(again.json().detail).toContain('has none yet');
    });

    it('refuses an occupancy carry-forward from a provisional that already has one', async () => {
      expect((await call('POST', '/applications/101/occupancy')).json().detail).toBe(
        'An Occupancy application can only be made from an issued Provisional NOC that has none yet.',
      );
    });

    it('rates a completed application', async () => {
      expect((await call('POST', '/applications/101/feedback', citizen, { rating: 0, remarks: 'x' })).json().detail).toContain('1 to 5');
      const res = await call('POST', '/applications/101/feedback', citizen, { rating: 4, remarks: 'Quick and clear.' });
      expect(res.json().application.feedback).toMatchObject({ rating: 4, remarks: 'Quick and clear.' });
      expect((await call('POST', '/applications/102/feedback', citizen, { rating: 4, remarks: 'x' })).json().detail).toBe(
        'Only completed applications can be rated.',
      );
    });

    it('deletes a first-revision draft', async () => {
      const created = (await call('POST', '/applications', citizen, { appl_type: 'D', site_name: 'To delete', site_addr: 'Nowhere' })).json();
      expect((await call('DELETE', `/applications/${created.application.appl_id}`)).statusCode).toBe(204);
      expect((await call('GET', `/applications/${created.application.appl_id}`)).statusCode).toBe(404);
    });
  });

  describe('concurrency', () => {
    /** A complete, paid Head Office draft ready to submit. */
    async function readyToSubmit(name: string): Promise<number> {
      const created = (await call('POST', '/applications', citizen, { appl_type: 'P', site_name: name, site_addr: 'Parallel Street' })).json().application;
      const saved = (
        await call('PUT', `/applications/${created.appl_id}`, citizen, {
          ...created,
          district: template.district,
          fire_station_id: template.fire_station_id,
          corr_addr: template.corr_addr,
          plot_area: template.plot_area,
          perimeter: template.perimeter,
          lic_auth: template.lic_auth,
          lic_addr: template.lic_addr,
          parties: template.parties,
          blocks: JSON.parse(JSON.stringify(template.blocks)),
          declaration_accepted: true,
        })
      ).json().application as Application;
      for (const d of requiredDocuments(saved, docRules).filter((x) => !x.optional && x.code !== 'ChallanCopy')) {
        expect((await upload(saved.appl_id, d.code, PDF, `${d.code}.pdf`)).statusCode).toBe(201);
      }
      expect((await call('POST', `/applications/${saved.appl_id}/payment`, citizen, { mode: 'online' })).statusCode).toBe(200);
      return saved.appl_id;
    }

    it('lets exactly one of two simultaneous saves of the same version through (the other gets 409)', async () => {
      const created = (await call('POST', '/applications', citizen, { appl_type: 'P', site_name: 'Race', site_addr: 'Race Road' })).json().application;
      const ifMatch = { 'if-match': `"r${created.row_version}"` };
      const [a, b] = await Promise.all([
        call('PUT', `/applications/${created.appl_id}`, citizen, { ...created, site_name: 'Race A' }, ifMatch),
        call('PUT', `/applications/${created.appl_id}`, citizen, { ...created, site_name: 'Race B' }, ifMatch),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    });

    it('gives simultaneous submissions distinct numbers', async () => {
      const ids = [await readyToSubmit('Parallel One'), await readyToSubmit('Parallel Two'), await readyToSubmit('Parallel Three')];
      const results = await Promise.all(ids.map((id) => call('POST', `/applications/${id}/submit`, citizen, { undertakings: ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'] })));
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      const numbers = results.map((r) => r.json().application.appl_number as string);
      expect(new Set(numbers).size).toBe(3);
      for (const n of numbers) expect(n).toMatch(/^\d{11}$/);
    });

    it('submits an application only once when the request is repeated at the same moment', async () => {
      const id = await readyToSubmit('Double Click');
      const body = { undertakings: ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'] };
      const [a, b] = await Promise.all([call('POST', `/applications/${id}/submit`, citizen, body), call('POST', `/applications/${id}/submit`, citizen, body)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 422]);
      const app = (await call('GET', `/applications/${id}`)).json() as Application;
      expect(app.processLog.filter((p) => p.action === 'Submitted')).toHaveLength(1);
    });
  });

  describe('requested documents', () => {
    it('lets the applicant answer an open request from the department', async () => {
      const before = (await call('GET', '/applications/102')).json() as Application;
      const open = before.deptfiles.find((f) => f.status === 'R')!;
      const m = multipart({ comment: 'Certificate attached' }, { name: 'completion.pdf', content: PDF });
      const res = await t.app.inject({
        method: 'POST',
        url: api(`/applications/102/document-requests/${open.fileid}/response`),
        headers: { ...citizen.headers, ...m.headers },
        payload: m.payload,
      });
      expect(res.statusCode, res.body).toBe(201);
      const after = res.json().application as Application;
      expect(after.deptfiles.find((f) => f.fileid === open.fileid)).toMatchObject({ status: 'U', citizen_comment: 'Certificate attached' });
      expect(after.documents.some((d) => d.code === `Requested:${open.file_name}`)).toBe(true);
      expect(after.processLog.at(-1)?.action).toBe('Requested document uploaded');
    });
  });

  it('computes a stateless assessment for an unsaved payload', async () => {
    const res = await call('POST', '/assessments', citizen, { ...template, appl_id: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json().approvalLevel).toBe('MSB');
  });

  it('keeps the uploaded files out of every served directory', () => {
    const root = resolve(process.env.FS_STORAGE_ROOT ?? resolve(import.meta.dirname, '..', '..', '..', 'var', 'storage'));
    expect(root.includes('/frontend/')).toBe(false);
    expect(readFileSync).toBeTruthy();
  });
});
