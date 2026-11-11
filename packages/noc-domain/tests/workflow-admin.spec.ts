import { fixture } from './fixtures.js';
import type { DeptRole, FormDef, SlaConfig, UserAccount, WorkflowDefinition } from '../src/models/index.js';
import { definitionProblems, simulate, slaProblems, workflowSetProblems } from '../src/workflow-admin.js';
import { officersFor } from '../src/workflow-view.js';

const defs = fixture<WorkflowDefinition[]>('assets/data/config/workflows.json');
const forms = fixture<FormDef[]>('assets/data/config/forms.json');
const sla = fixture<SlaConfig>('assets/data/config/sla.json');
const roles = fixture<DeptRole[]>('assets/data/lookups/dept-roles.json');
const users = fixture<UserAccount[]>('assets/data/auth/users.json');

describe('workflow configuration', () => {
  it('ships one valid workflow per application type × level (12)', () => {
    expect(defs).toHaveLength(12);
    expect(workflowSetProblems(defs, roles, forms)).toEqual([]);
    expect(slaProblems(sla, defs)).toEqual([]);
  });

  it('follows the confirmed sequences', () => {
    const seq = (code: string) => defs.find((x) => x.code === code)!.stages.map((s) => s.tasks.map((t) => roles.find((r) => r.id === t.role_id)!.code).join('+'));
    expect(seq('P-MSB')).toEqual(['SEC+DFO+SFO', 'RFO', 'ADFS', 'DFSCD', 'DFS', 'DG']);
    expect(seq('O-MSB')).toEqual(['SEC+DFO+SFO', 'RFO', 'ADFS', 'DFSCD', 'DFS', 'DG']);
    expect(seq('R-MSB')).toEqual(['SEC+DFO+SFO', 'RFO', 'ADFS', 'DFSCD', 'DFS']); // renewals decided by the DFS
    expect(seq('P-RFO')).toEqual(['SFO', 'DFO', 'RFO']);
    expect(seq('R-DFO')).toEqual(['SFO', 'DFO']);
    expect(seq('D-MSB')).toEqual(['DFO+SFO', 'DFS']);
  });

  it('rejects invalid definitions', () => {
    const base = structuredClone(defs.find((x) => x.code === 'P-RFO')!);
    const noFinal = structuredClone(base);
    noFinal.stages.pop();
    expect(definitionProblems(noFinal, roles, forms).join(' ')).toContain('last stage must have exactly one task using the Final Decision form');
    const badRole = structuredClone(base);
    badRole.stages[0].tasks[0].role_id = 99;
    expect(definitionProblems(badRole, roles, forms)).toContain('Stage 1 (Inspection), task 1 (Inspection Report): select the role that performs the task.');
    const backwards = structuredClone(base);
    backwards.stages[1].citizen_status = 3;
    backwards.stages[0].citizen_status = 4;
    expect(definitionProblems(backwards, roles, forms).join(' ')).toContain('cannot go back');
    const decisionEarly = structuredClone(base);
    decisionEarly.stages[0].tasks[0].form = 'final_decision';
    expect(definitionProblems(decisionEarly, roles, forms).join(' ')).toContain('can only be used in the last stage');
    const noReturn = structuredClone(base);
    noReturn.stages[2].tasks[0].decision!.outcomes = ['approve', 'reject'];
    expect(definitionProblems(noReturn, roles, forms)).toContain('The final decision must allow "return".');
    const inspectless = structuredClone(defs.find((x) => x.code === 'D-DFO')!);
    inspectless.stages[1].tasks[0].decision!.inspect_stage = 'nowhere';
    expect(definitionProblems(inspectless, roles, forms)).toContain('The "inspect" outcome needs the inspection stage it activates.');
    const gap = defs.filter((x) => x.code !== 'O-RFO');
    expect(workflowSetProblems(gap, roles, forms)).toContain('O · RFO: no workflow defined.');
  });

  it('checks the statuses against the configurable status list (N-4)', () => {
    const statuses = [
      { code: 2, category: 'submitted', active: true },
      { code: 3, category: 'in_process', active: true },
      { code: 4, category: 'in_process', active: false },
      { code: 6, category: 'in_process', active: true, is_pre_decision: true },
    ];
    const def = structuredClone(defs.find((x) => x.code === 'P-MSB')!);
    expect(definitionProblems(def, roles, forms, statuses).join(' ')).toContain('must be an active in-process status');
  });

  it('validates the SLA configuration', () => {
    const bad = structuredClone(sla);
    bad.workflows['P-MSB'].inspection_days = 90;
    bad.workflows['P-MSB'].processing_days = 60;
    bad.workflows['P-DFO'].step_days['decision'] = 0;
    bad.escalation.notify_officer = false;
    bad.escalation.notify_approver = false;
    expect(slaProblems(bad, defs)).toEqual([
      'P-MSB: the inspection SLA cannot exceed the processing SLA.',
      'P-DFO: SLA of step "decision" must be 1-365 days.',
      'Escalations must notify the officer, the issuing authority or both.',
    ]);
  });
});

describe('officers associated with the fire station', () => {
  const dept = users.map((u) => ({ ...u, active: u.active !== false }));
  it('picks the active officer of each designation associated with the station', () => {
    expect(officersFor(9, 62, dept).map((u) => u.username)).toEqual(['sfo.officer']);
    expect(officersFor(6, 26, dept).map((u) => u.username)).toEqual(['dfo.officer']);
    expect(officersFor(7, 111, dept).map((u) => u.username)).toEqual(['rfo.southern']);
    expect(officersFor(6, 111, dept).map((u) => u.username)).toEqual(['dfo.guntur']); // the retired DFO is inactive
    expect(officersFor(1, 193, dept).map((u) => u.username)).toEqual(['dg.officer']); // HQ: all stations
  });

  it('simulates a workflow for a station and warns about missing officers', () => {
    const sim = simulate(defs.find((x) => x.code === 'P-MSB')!, 44, dept, roles); // Tekkali — no SFO seeded
    expect(sim.find((s) => s.task === 'Inspection Report (Committee Chairman)')?.officers).toEqual(['DFO - Srikakulam']);
    expect(sim.find((s) => s.task === 'Committee Member Concurrence')?.warning).toContain('No active SFO');
  });
});
