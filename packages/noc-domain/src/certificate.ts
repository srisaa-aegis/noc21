/**
 * Facts printed on the legal documents (legacy modules/dept/partials/final_noc_16.html,
 * final_noc_o.html, final_noc_r.html, rejection.html, OccCert.html). Text that depends on the
 * approval level (signatory, "Copy to" list, MSB / Non-MSB wording) is reproduced verbatim.
 */
import { Application, DelegationLevel, ProcessStep } from './models/index.js';
import { parseLegacyDate } from './dates.js';
import { decisionInput } from './workflow-view.js';

export type LetterKind = 'P' | 'O' | 'R' | 'D' | 'REJECTION';

/**
 * Date of the online inspection report (legacy application.forward_date): the inspection report
 * task of the workflow, otherwise the latest "Inspected" step of the log.
 */
export function inspectionDate(app: Pick<Application, 'processLog' | 'applied_date' | 'workflow'>): string {
  const report = (app.workflow?.tasks ?? []).filter((t) => t.form === 'inspection_report' && t.state === 'done' && t.end_date).at(-1);
  if (report?.end_date) return report.end_date;
  return [...app.processLog].reverse().find((s) => s.status_id === 3)?.at_date ?? app.applied_date;
}

/** The process step that produced the current status (approval / rejection / return). */
export function decisionStep(app: Pick<Application, 'processLog' | 'status_id'>): ProcessStep | null {
  return [...app.processLog].reverse().find((s) => s.status_id === app.status_id) ?? app.processLog.at(-1) ?? null;
}

/** Legacy: a Provisional NOC whose site name contains "revised" is printed as a "Revised Provisional" NOC. */
export function isRevisedProvisional(app: Pick<Application, 'appl_type' | 'site_name'>): boolean {
  return app.appl_type === 'P' && (app.site_name ?? '').toLowerCase().includes('revised');
}

export function buildingClass(level: DelegationLevel): string {
  return level === 'MSB' ? 'Multi Storeyed Building' : 'Non Multi Storeyed Building';
}

/** "2022-2023" — the period of an Annual Periodical Renewal Fire Certificate. */
export function renewalPeriodLabel(validFrom?: string, validTo?: string): string {
  const f = parseLegacyDate(validFrom);
  const t = parseLegacyDate(validTo);
  if (!f) return '';
  return t && t.getFullYear() !== f.getFullYear() ? `${f.getFullYear()}-${t.getFullYear()}` : String(f.getFullYear());
}

/** "dd/MM/yyyy" as printed on the legacy letters. */
export function letterDate(value?: string): string {
  const d = parseLegacyDate(value);
  if (!d) return value ?? '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Signature block lines by letter kind and approval level. `approverRole` distinguishes DG / Director at HQ. */
export function signatoryLines(kind: LetterKind, level: DelegationLevel, districtName: string, approverRole = 'DG'): string[] {
  if (level === 'DFO') return ['District Fire Officer', `Andhra Pradesh, ${districtName}`];
  if (level === 'RFO') return ['Regional Fire Officer', 'Andhra Pradesh, Vijayawada'];
  if (kind === 'D') return ['Director of Fire Services', 'State Disaster Response & Fire Services', 'Andhra Pradesh, Vijayawada'];
  const director = kind === 'R' || (kind === 'REJECTION' && approverRole !== 'DG');
  return director
    ? ['Director', 'State Disaster Response & Fire Services', 'Andhra Pradesh, Vijayawada.']
    : ['Director General', 'Prisons and Correctional Services', 'Director General', 'State Disaster Response & Fire Services', 'Andhra Pradesh, Vijayawada'];
}

/** "From" block of the renewal certificate and rejection letter. */
export function fromLines(kind: LetterKind, level: DelegationLevel, districtName: string, approverRole = 'DG'): string[] {
  if (level === 'DFO') return ['District Fire Officer', `Andhra Pradesh, ${districtName}`];
  if (level === 'RFO') return ['Regional Fire Officer', 'Andhra Pradesh, Vijayawada'];
  if (kind === 'REJECTION' && approverRole === 'DG') return ['Director General', 'State Disaster Response & Fire Services,', 'Andhra Pradesh, Vijayawada.'];
  return ['Director', 'State Disaster Response & Fire Services', 'Andhra Pradesh, Vijayawada.'];
}

/** "Copy to" list by letter kind and approval level (verbatim from the legacy letters), plus any extra lines the issuing authority added when deciding. */
export function copyToLines(kind: LetterKind, level: DelegationLevel, app: Pick<Application, 'build_name' | 'corr_addr'>, extra: string[] = []): string[] {
  const builder = `${app.build_name}, ${app.corr_addr}`;
  const concerned = (s: string) => (kind === 'R' ? `${s} Concerned` : `${s} concerned`);
  const base =
    kind === 'REJECTION' || level === 'MSB'
      ? [builder, 'Chief Office for Record Purpose', concerned('Regional Fire Officer'), concerned('District Fire Officer'), concerned('Assistant District Fire Officer')]
      : level === 'DFO'
        ? [kind === 'R' ? `Management ${builder}` : builder, concerned('Assistant District Fire Officer'), concerned('Station Fire Officer')]
        : [builder, 'Chief Office for Record Purpose', concerned('District Fire Officer'), concerned('Assistant District Fire Officer'), concerned('Station Fire Officer')];
  return [...base, ...extra];
}

/** Extra "Copy to" lines the issuing authority added on the final decision (one per line). */
export function extraCopyToLines(app: Pick<Application, 'workflow'>): string[] {
  const addcc = String(decisionInput(app)?.['addcc'] ?? '');
  return addcc
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Internal remark about the inspection committee's report, entered by the issuing authority (not printed). */
export function committeeDecisionRemark(app: Pick<Application, 'workflow'>): string {
  return String(decisionInput(app)?.['rem_comm'] ?? '').trim();
}

/** Whether the NOC terms item is printed for this building (noc_terms_16 items marked for buildings above 60 m). */
export function termsHtmlForHeight(html: string, maxHeight: number): string {
  if (maxHeight > 60) return html;
  return html.replace(/<li[^>]*class="cond-height-gt-60"[^>]*>[\s\S]*?<\/li>/g, '');
}
