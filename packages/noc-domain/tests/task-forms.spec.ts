import { fixture } from './fixtures.js';
import { Application, FormDef } from '../src/models/index.js';
import {
  committeeConcurrenceProblems,
  initialCommitteeConcurrence,
  initialInspectionReport,
  initialQuestionnaireData,
  initialRfoNote,
  initialSectionNote,
  initialTaskFormData,
  inspectionRecommendation,
  inspectionReportProblems,
  questionnaireProblems,
  rfoNoteProblems,
  sectionNoteProblems,
  taskFormProblems,
  visibleQuestions,
} from '../src/task-forms.js';

const apps = fixture<Application[]>('assets/data/applications/applications.json');
const forms = fixture<FormDef[]>('assets/data/config/forms.json');
const byId = (id: number) => structuredClone(apps.find((a) => a.appl_id === id)!);
const form = (id: string) => forms.find((f) => f.id === id)!;

describe('Section Note', () => {
  it('defaults the fee check from the payment status and requires every observation + remark', () => {
    const p = byId(101); // Provisional: bank guarantee / FFE estimate questions apply
    const d = initialSectionNote(p, 'Section Officer (HQ)');
    expect(d.fee_ok).toBe('Y'); // paid
    expect(d.bank_guarantee_ok).toBe('');
    const o = byId(102); // Occupancy: no bank guarantee / FFE estimate questions
    expect(initialSectionNote(o, 'x').bank_guarantee_ok).toBe('Y');

    expect(sectionNoteProblems(d, p).length).toBeGreaterThan(0);
    const complete = { ...d, applicant_ok: 'Y' as const, survey_ok: 'Y' as const, plans_ok: 'Y' as const, bank_guarantee_ok: 'Y' as const, ffe_estimate_ok: 'Y' as const, remark: 'All in order.' };
    expect(sectionNoteProblems(complete, p)).toEqual([]);
  });
});

describe('Inspection Report', () => {
  it('recommends issue only when every block is OK; the PNOC conditions count for Occupancy', () => {
    const o = byId(102); // has PNOC conditions
    const d = initialInspectionReport(o, '15-Jan-2024');
    expect(d.blocks).toHaveLength(2);
    expect(d.blocks[0].pnoc_complied).toBe(''); // must be answered
    expect(inspectionRecommendation(d)).toBe('N');
    const allOk = { ...d, blocks: d.blocks.map((b) => ({ ...b, open_spaces_ok: 'Y' as const, escapes_ok: 'Y' as const, floors_ok: 'Y' as const, ffe_ok: 'Y' as const, pnoc_complied: 'Y' as const })) };
    expect(inspectionRecommendation(allOk)).toBe('Y');
    const oneBad = { ...allOk, blocks: [allOk.blocks[0], { ...allOk.blocks[1], floors_ok: 'N' as const }] };
    expect(inspectionRecommendation(oneBad)).toBe('N');
    expect(inspectionReportProblems(d).length).toBeGreaterThan(0);
    expect(inspectionReportProblems({ ...allOk, inspection_date: '15-Jan-2024', remark: 'All OK' })).toEqual([]);
  });

  it('a Declaration (no blocks) is judged on the maintenance of the installed systems', () => {
    const decl = byId(107);
    const d = initialInspectionReport(decl, '10-May-2022');
    expect(d.blocks).toHaveLength(0);
    expect(inspectionRecommendation(d)).toBe('N');
    expect(inspectionReportProblems(d)).toContain('State whether the installed fire safety systems are maintained in working condition.');
    const ok = { ...d, systems_maintained_ok: 'Y' as const, inspection_date: '10-May-2022', remark: 'Maintained.' };
    expect(inspectionRecommendation(ok)).toBe('Y');
    expect(inspectionReportProblems(ok)).toEqual([]);
  });
});

describe('Committee Member Concurrence', () => {
  it('defaults to the standard concurrence text and requires an answer', () => {
    const d = initialCommitteeConcurrence();
    expect(d.agree).toBe('');
    expect(committeeConcurrenceProblems(d).length).toBeGreaterThan(0);
    expect(committeeConcurrenceProblems({ agree: 'Y', remark: d.remark })).toEqual([]);
  });
});

describe('RFO Note', () => {
  it('requires an NBC check per block, the overall checks and a manual recommendation', () => {
    const app = byId(101);
    const d = initialRfoNote(app);
    expect(d.blocks).toHaveLength(2);
    expect(rfoNoteProblems(d).length).toBeGreaterThan(0);
    const complete = {
      ...d,
      blocks: d.blocks.map((b) => ({ ...b, nbc_ok: 'Y' as const })),
      approach_road_ok: 'Y' as const,
      parking_ok: 'Y' as const,
      conditions_complied: 'Y' as const,
      recommendation: 'Y' as const,
      remark: 'Recommended.',
    };
    expect(rfoNoteProblems(complete)).toEqual([]);
  });
});

describe('Generic questionnaire (ADFS / DFS-CD / DFS / DFO notes)', () => {
  it('hides and skips questions whose show_if does not match, and requires the visible ones', () => {
    const f = form('adfs_note');
    const d = initialQuestionnaireData(f);
    expect(Object.keys(d)).toContain('adfs_what_diff');
    expect(visibleQuestions(f, d).map((q) => q.key)).not.toContain('adfs_what_diff');
    expect(questionnaireProblems(f, d).length).toBeGreaterThan(0);
    expect(questionnaireProblems(f, d)).not.toEqual(expect.arrayContaining([expect.stringContaining('what do the Act')]));

    const withDiff = { ...d, adfs_diff_opi: '1' };
    expect(visibleQuestions(f, withDiff).map((q) => q.key)).toContain('adfs_what_diff');
    expect(questionnaireProblems(f, withDiff).some((p) => p.includes('what do the Act'))).toBe(true);

    const complete = {
      adfs_nbc_rules: 'NBC Part 4',
      adfs_diff_opi: '0',
      adfs_comm_norm: '1',
      adfs_deficits: 'None',
      remark: 'Recommended',
      recommendation: 'Y',
    };
    expect(questionnaireProblems(f, complete)).toEqual([]);
  });
});

describe('dispatch (initialTaskFormData / taskFormProblems)', () => {
  it('routes every form id to its own defaults and validation', () => {
    const app = byId(101);
    for (const id of ['section_note', 'inspection_report', 'committee_concurrence', 'rfo_note', 'adfs_note', 'dfscd_note', 'dfs_note', 'dfo_note']) {
      const f = form(id);
      const data = initialTaskFormData(f, app, 'Officer', '01-Jan-2026');
      expect(taskFormProblems(f, data, app).length).toBeGreaterThan(0);
    }
    // the final decision form has no structured data shape of its own (handled by the decision UI)
    expect(taskFormProblems(form('final_decision'), {}, app)).toEqual([]);
  });
});
