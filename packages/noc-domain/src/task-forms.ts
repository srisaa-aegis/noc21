/**
 * Note / report forms a workflow task can use (config/forms.json) — Phase 3b. Pure data shapes,
 * defaults and validation for the "structured" forms (section note, inspection report, committee
 * concurrence, RFO note) and a generic engine for the admin-picked "questionnaire" forms (ADFS /
 * DFS-CD / DFS / DFO notes). The UI (features/dept/forms/*) only renders and mutates these records;
 * `taskFormProblems` decides whether *Submit* may proceed (the engine itself only enforces the
 * remark + signed copy of the final decision — see `decide()` in workflow.ts).
 */
import { Application, FormDef, FormQuestion, WorkflowRun, WorkflowTask } from './models/index.js';

export type YN = 'Y' | 'N' | '';

function blank(v: unknown): boolean {
  return v == null || String(v).trim() === '';
}

// ---------------------------------------------------------------------------
// Section Note (scrutiny) — legacy section_note / section_note_o / section_note_r
// ---------------------------------------------------------------------------

export interface SectionNoteData {
  applicant_ok: YN;
  survey_ok: YN;
  plans_ok: YN;
  plans_signed_by: string;
  fee_ok: YN;
  /** Only for Provisional NOCs. */
  bank_guarantee_ok: YN;
  ffe_estimate_ok: YN;
  deficiencies: string;
  submitted_by: string;
  remark: string;
}

export function initialSectionNote(app: Application, officerName: string): SectionNoteData {
  return {
    applicant_ok: '',
    survey_ok: '',
    plans_ok: '',
    plans_signed_by: '',
    fee_ok: app.payment.status === 'paid' ? 'Y' : '',
    bank_guarantee_ok: app.appl_type === 'P' ? '' : 'Y',
    ffe_estimate_ok: app.appl_type === 'P' ? '' : 'Y',
    deficiencies: '',
    submitted_by: officerName,
    remark: '',
  };
}

export function sectionNoteProblems(d: SectionNoteData, app: Application): string[] {
  const out: string[] = [];
  if (!d.applicant_ok) out.push('State whether the applicant, licensing authority and committee details are in order.');
  if (!d.survey_ok) out.push('State whether the survey / revenue details are in order.');
  if (!d.plans_ok) out.push('State whether the plan documents are in order.');
  if (!d.fee_ok) out.push('State whether the fee due has been paid in full.');
  if (app.appl_type === 'P') {
    if (!d.bank_guarantee_ok) out.push('State whether the 15% bank guarantee is in order.');
    if (!d.ffe_estimate_ok) out.push('State whether the fire fighting equipment estimate is in order.');
  }
  if (blank(d.submitted_by)) out.push('Enter who the file was submitted by.');
  if (blank(d.remark)) out.push('Enter the remarks of the note.');
  return out;
}

// ---------------------------------------------------------------------------
// Inspection Report (Committee Chairman) — legacy dfo_report / dfo_report_o / dfo_report_r
// ---------------------------------------------------------------------------

export interface BlockObservation {
  block_id: number;
  block_name: string;
  discrepancy: string;
  open_spaces_ok: YN;
  open_spaces_remarks: string;
  escapes_ok: YN;
  escapes_remarks: string;
  floors_ok: YN;
  floors_remarks: string;
  ffe_ok: YN;
  ffe_remarks: string;
  /** Occupancy: remarks on photographs vs the declared construction. */
  images_remarks: string;
  /** Occupancy with Provisional NOC conditions: complied Y/N. */
  pnoc_complied: YN;
  /** Renewal: remarks on the documents produced on site. */
  documents_remarks: string;
  /** Renewal: compliance of the specific conditions of the previous NOC. */
  specific_conditions: string;
}

export interface InspectionReportData {
  blocks: BlockObservation[];
  /** Declarations (no blocks): are the installed fire safety systems maintained in working condition? */
  systems_maintained_ok: YN;
  systems_remarks: string;
  any_other_action: string;
  inspection_date: string;
  remark: string;
  /** Computed: Recommend only if every observation above is OK (legacy: computed automatically). */
  recommendation: YN;
}

function newBlockObservation(app: Application, blockId: number, blockName: string): BlockObservation {
  return {
    block_id: blockId,
    block_name: blockName,
    discrepancy: '',
    open_spaces_ok: '',
    open_spaces_remarks: '',
    escapes_ok: '',
    escapes_remarks: '',
    floors_ok: '',
    floors_remarks: '',
    ffe_ok: '',
    ffe_remarks: '',
    images_remarks: '',
    pnoc_complied: app.appl_type === 'O' && app.conditions?.length ? '' : 'Y',
    documents_remarks: '',
    specific_conditions: '',
  };
}

export function initialInspectionReport(app: Application, inspectionDate: string): InspectionReportData {
  return {
    blocks: app.blocks.map((b) => newBlockObservation(app, b.block_id, b.block_name)),
    systems_maintained_ok: '',
    systems_remarks: '',
    any_other_action: '',
    inspection_date: inspectionDate,
    remark: '',
    recommendation: 'N',
  };
}

/** All observations OK → Recommend; anything not OK (or not yet answered) → Do not recommend. */
export function inspectionRecommendation(d: InspectionReportData): YN {
  if (!d.blocks.length) return d.systems_maintained_ok === 'Y' ? 'Y' : 'N';
  return d.blocks.every((b) => b.open_spaces_ok === 'Y' && b.escapes_ok === 'Y' && b.floors_ok === 'Y' && b.ffe_ok === 'Y' && (b.pnoc_complied !== 'N')) ? 'Y' : 'N';
}

export function inspectionReportProblems(d: InspectionReportData): string[] {
  const out: string[] = [];
  if (!d.blocks.length && !d.systems_maintained_ok) out.push('State whether the installed fire safety systems are maintained in working condition.');
  d.blocks.forEach((b) => {
    const label = b.block_name || `block ${b.block_id}`;
    if (!b.open_spaces_ok) out.push(`${label}: state whether the open spaces are OK.`);
    if (!b.escapes_ok) out.push(`${label}: state whether the means of escape are OK.`);
    if (!b.floors_ok) out.push(`${label}: state whether the floors are OK.`);
    if (!b.ffe_ok) out.push(`${label}: state whether the fire fighting equipment is OK.`);
    if (b.pnoc_complied === '') out.push(`${label}: state whether the Provisional NOC conditions are complied with.`);
  });
  if (blank(d.inspection_date)) out.push('Enter the date of inspection.');
  if (blank(d.remark)) out.push('Enter the remarks of the inspection report.');
  return out;
}

// ---------------------------------------------------------------------------
// Committee Member Concurrence — legacy dfo_others_o
// ---------------------------------------------------------------------------

export interface CommitteeConcurrenceData {
  agree: YN;
  remark: string;
}

export function initialCommitteeConcurrence(): CommitteeConcurrenceData {
  return { agree: '', remark: 'I agree with the report submitted by the Chairman of the Inspection Committee.' };
}

export function committeeConcurrenceProblems(d: CommitteeConcurrenceData): string[] {
  const out: string[] = [];
  if (!d.agree) out.push('State whether you agree with the report submitted by the Chairman of the Inspection Committee.');
  if (blank(d.remark)) out.push('Enter your remarks.');
  return out;
}

// ---------------------------------------------------------------------------
// RFO Note — legacy rfo_note / rfo_note_o / rfo_note_r (Head Office workflows only)
// ---------------------------------------------------------------------------

export interface RfoNoteBlock {
  block_id: number;
  block_name: string;
  nbc_ok: YN;
  deficiency: string;
}

export interface RfoNoteData {
  blocks: RfoNoteBlock[];
  approach_road_ok: YN;
  approach_road_remark: string;
  parking_ok: YN;
  parking_remark: string;
  other_acts: string;
  points_for_dgfs: string;
  conditions_complied: YN;
  recommendation: YN;
  remark: string;
}

export function initialRfoNote(app: Application): RfoNoteData {
  return {
    blocks: app.blocks.map((b) => ({ block_id: b.block_id, block_name: b.block_name, nbc_ok: '', deficiency: '' })),
    approach_road_ok: '',
    approach_road_remark: '',
    parking_ok: '',
    parking_remark: '',
    other_acts: '',
    points_for_dgfs: '',
    conditions_complied: '',
    recommendation: '',
    remark: '',
  };
}

export function rfoNoteProblems(d: RfoNoteData): string[] {
  const out: string[] = [];
  d.blocks.forEach((b) => {
    if (!b.nbc_ok) out.push(`${b.block_name || 'block'}: state whether the NBC guidelines (open spaces, staircases, occupant load, FFE) are met.`);
  });
  if (!d.approach_road_ok) out.push('State whether the approach road width is adequate.');
  if (!d.parking_ok) out.push('State whether the parking provided is adequate.');
  if (!d.conditions_complied) out.push('State whether the specific conditions are complied with.');
  if (!d.recommendation) out.push('Select the recommendation.');
  if (blank(d.remark)) out.push('Enter the remarks of the note.');
  return out;
}

// ---------------------------------------------------------------------------
// Generic questionnaire engine — ADFS / DFS-CD / DFS / DFO notes (admin picks the form; the
// questions themselves are not editable — review decision §0.10)
// ---------------------------------------------------------------------------

export type QuestionnaireData = Record<string, string>;

/** Questions whose `show_if` (if any) matches the current answers. */
export function visibleQuestions(form: FormDef, data: QuestionnaireData): FormQuestion[] {
  return (form.questions ?? []).filter((q) => !q.show_if || Object.entries(q.show_if).every(([k, v]) => data[k] === v));
}

export function initialQuestionnaireData(form: FormDef): QuestionnaireData {
  return Object.fromEntries((form.questions ?? []).map((q) => [q.key, '']));
}

export function questionnaireProblems(form: FormDef, data: QuestionnaireData): string[] {
  const out: string[] = [];
  for (const q of visibleQuestions(form, data)) {
    if (q.required && blank(data[q.key])) out.push(`${q.label.replace(/^\d+\)\s*/, '')} is required.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function initialTaskFormData(form: FormDef, app: Application, officerName: string, inspectionDate: string): Record<string, unknown> {
  switch (form.id) {
    case 'section_note':
      return initialSectionNote(app, officerName) as unknown as Record<string, unknown>;
    case 'inspection_report':
      return initialInspectionReport(app, inspectionDate) as unknown as Record<string, unknown>;
    case 'committee_concurrence':
      return initialCommitteeConcurrence() as unknown as Record<string, unknown>;
    case 'rfo_note':
      return initialRfoNote(app) as unknown as Record<string, unknown>;
    default:
      return form.kind === 'questionnaire' ? initialQuestionnaireData(form) : {};
  }
}

export function taskFormProblems(form: FormDef, data: Record<string, unknown>, app: Application): string[] {
  switch (form.id) {
    case 'section_note':
      return sectionNoteProblems(data as unknown as SectionNoteData, app);
    case 'inspection_report':
      return inspectionReportProblems(data as unknown as InspectionReportData);
    case 'committee_concurrence':
      return committeeConcurrenceProblems(data as unknown as CommitteeConcurrenceData);
    case 'rfo_note':
      return rfoNoteProblems(data as unknown as RfoNoteData);
    default:
      return form.kind === 'questionnaire' ? questionnaireProblems(form, data as QuestionnaireData) : [];
  }
}

// ---------------------------------------------------------------------------
// Challan verification (decision B2-1)
// ---------------------------------------------------------------------------

/** Field every note form carries when the fee was paid by bank challan. */
export const CHALLAN_VERIFIED = 'challan_verified';

/**
 * A fee paid by bank challan is accepted at once (as in the legacy portal) and
 * verified by the department during scrutiny: the Section officer's note —
 * or, in workflows without a Section scrutiny, the first task of the first
 * stage — must confirm that the challan was checked before it is submitted.
 */
export function challanVerificationRequired(
  app: Pick<Application, 'payment'>,
  run: Pick<WorkflowRun, 'stages'>,
  task: Pick<WorkflowTask, 'stage_key' | 'task_key' | 'form'>,
): boolean {
  if (app.payment?.mode !== 'challan') return false;
  const hasSection = run.stages.some((s) => s.tasks.some((t) => t.form === 'section_note'));
  if (hasSection) return task.form === 'section_note';
  const first = run.stages.find((s) => !s.tasks.every((t) => t.on_demand));
  return !!first && first.key === task.stage_key && first.tasks[0]?.key === task.task_key;
}

export function challanProblems(required: boolean, data: Record<string, unknown>): string[] {
  return required && data[CHALLAN_VERIFIED] !== 'Y'
    ? ['Verify the bank challan (number, date, bank and amount) and tick "Challan verified" before submitting.']
    : [];
}
