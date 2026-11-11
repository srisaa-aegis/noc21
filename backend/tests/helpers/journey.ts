/**
 * Test journeys through the real API: a complete, paid Provisional application
 * (copied from demo application 101, Visakhapatnam / Head Office level),
 * submitted; and valid data for every department form.
 */
import {
  initialTaskFormData,
  requiredDocuments,
  visibleQuestions,
  type Application,
  type DocumentRequirements,
  type FormDef,
} from '@srisaa/noc-domain';
import { api, type TestApi } from './app.js';

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export type Who = { headers: Record<string, string> };

export function multipart(fields: Record<string, string>, file: { name: string; content: Buffer; type?: string }) {
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

export function caller(t: TestApi) {
  return (method: string, url: string, who: Who, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method: method as 'GET', url: api(url), headers: { ...who.headers, ...headers }, payload: payload as never });
}

export function uploader(t: TestApi) {
  return (url: string, who: Who, fields: Record<string, string>, name = 'doc.pdf', content = PDF) => {
    const m = multipart(fields, { name, content });
    return t.app.inject({ method: 'POST', url: api(url), headers: { ...who.headers, ...m.headers }, payload: m.payload });
  };
}

export const UNDERTAKINGS = ['correct', 'nostart', 'finalnoc', 'nohite', 'onlyfire', 'ffequip'];

/**
 * A complete Provisional application of `citizen` (copied from application 101),
 * paid online or by challan, then submitted. Returns its id and number.
 */
export async function submittedApplication(
  t: TestApi,
  citizen: Who,
  opts: { name?: string; payment?: 'online' | 'challan'; overrides?: Partial<Application> } = {},
): Promise<{ id: number; number: string }> {
  const call = caller(t);
  const upload = uploader(t);
  const template = (await call('GET', '/applications/101', citizen)).json() as Application;
  const rules = (await call('GET', '/lookups/document-requirements', citizen)).json() as DocumentRequirements;
  const created = (await call('POST', '/applications', citizen, { appl_type: 'P', site_name: opts.name ?? 'Workflow Towers', site_addr: 'Plot 5, Test Nagar' })).json()
    .application as Application;
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
      ...(opts.overrides ?? {}),
    })
  ).json().application as Application;
  const payment = opts.payment ?? 'online';
  const paid = await call(
    'POST',
    `/applications/${saved.appl_id}/payment`,
    citizen,
    payment === 'online' ? { mode: 'online' } : { mode: 'challan', challan_num: 'CH-778899', challan_date: '2026-01-05', bank: 'SBI', branch: 'Dwaraka Nagar' },
  );
  if (paid.statusCode !== 200) throw new Error(`pay: ${paid.statusCode} ${paid.body}`);
  for (const d of requiredDocuments({ ...saved, payment: { ...saved.payment, mode: payment } }, rules).filter((x) => !x.optional)) {
    const res = await upload(`/applications/${saved.appl_id}/documents`, citizen, { code: d.code }, `${d.code}.pdf`);
    if (res.statusCode !== 201) throw new Error(`upload ${d.code}: ${res.statusCode} ${res.body}`);
  }
  const submitted = await call('POST', `/applications/${saved.appl_id}/submit`, citizen, { undertakings: UNDERTAKINGS });
  if (submitted.statusCode !== 200) throw new Error(`submit: ${submitted.statusCode} ${submitted.body}`);
  return { id: saved.appl_id, number: submitted.json().application.appl_number };
}

/** Valid, complete data for a department form (every question answered "OK"). */
export function validFormData(form: FormDef, app: Application, officerName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const d = initialTaskFormData(form, app, officerName, app.applied_date || '01-Jan-2026') as Record<string, unknown>;
  const yes = (o: Record<string, unknown>) => {
    for (const k of Object.keys(o)) if (/_ok$|^agree$|^conditions_complied$|^recommendation$|^pnoc_complied$/.test(k) && o[k] === '') o[k] = 'Y';
  };
  yes(d);
  for (const list of ['blocks']) {
    if (Array.isArray(d[list])) for (const b of d[list] as Record<string, unknown>[]) yes(b);
  }
  if ('remark' in d || form.kind === 'questionnaire') d['remark'] = d['remark'] || `${form.name}: in order.`;
  if ('submitted_by' in d && !d['submitted_by']) d['submitted_by'] = officerName;
  if ('inspection_date' in d && !d['inspection_date']) d['inspection_date'] = '05-Jan-2026';
  if (form.kind === 'questionnaire') {
    for (let pass = 0; pass < 3; pass++) {
      for (const q of visibleQuestions(form, d as Record<string, string>)) {
        if (!d[q.key]) d[q.key] = q.options?.length ? (q.options.find((o) => o.value === 'Y' || o.value === '1')?.value ?? q.options[0].value) : 'Satisfactory.';
      }
    }
  }
  return { ...d, ...extra };
}
