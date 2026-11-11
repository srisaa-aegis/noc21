import { describe, expect, it } from 'vitest';
import {
  activeStageIndex,
  activeTasks,
  allowedActions,
  archive,
  complete,
  currentTasks,
  decide,
  handover,
  pendingWith,
  reassign,
  reresolveAssignees,
  saveDraft,
  sendBack,
  skip,
  start,
  validateDefinition,
  WorkflowError,
  type Instance,
  type WorkflowEvent,
} from '../src/index.js';
import { FixedClock, InMemoryDirectory, context, decision, definition, stage, task } from '../src/testing/index.js';

// A Head-Office-like flow: scrutiny ∥ inspection ∥ committee → review → decision
const people = new InMemoryDirectory([
  { id: 1, name: 'Section', roles: ['SEC'] },
  { id: 2, name: 'DFO', roles: ['DFO'] },
  { id: 3, name: 'SFO', roles: ['SFO'] },
  { id: 4, name: 'ADFS', roles: ['ADFS'] },
  { id: 5, name: 'DG', roles: ['DG'] },
  { id: 6, name: 'Another DFO', roles: ['DFO'] },
]);

const headOffice = definition([
  stage(
    'scrutiny',
    [task('section', 'SEC'), task('inspection', 'DFO', { slaClass: 'inspection' }), task('committee', 'SFO', { optional: true })],
    { status: 3, label: 'Inspected' },
  ),
  stage('review', [task('adfs', 'ADFS', { permissions: { sendBack: true, requestInput: true, skippable: true, reassignable: false } })], {
    status: 6,
    label: 'Reviewed',
  }),
  stage('decision', [decision('DG')]),
]);

const ctx = () => context(people, new FixedClock(new Date('2025-03-01T09:00:00Z')));
const types = (events: WorkflowEvent[]) => events.map((e) => e.type);
const stateOf = (i: Instance, key: string) => currentTasks(i).find((t) => t.taskKey === key)?.state;

describe('start', () => {
  it('creates every task, resolves assignees and activates the first stage', () => {
    const { instance, events } = start(headOffice, 1, ctx());
    expect(instance.tasks).toHaveLength(5);
    expect(activeTasks(instance).map((t) => t.taskKey)).toEqual(['section', 'inspection', 'committee']);
    expect(stateOf(instance, 'adfs')).toBe('waiting');
    expect(instance.decider).toEqual({ id: 5, name: 'DG' });
    expect(types(events)).toEqual(['InstanceStarted', 'TaskActivated', 'TaskActivated', 'TaskActivated']);
    expect(pendingWith(instance, (r) => `Unassigned (${r})`)).toBe('Section, DFO, SFO');
  });

  it('leaves a task unassigned when nobody holds the role', () => {
    const lonely = definition([stage('s', [task('x', 'NOBODY')]), stage('decision', [decision('DG')])]);
    const { instance } = start(lonely, 1, ctx());
    expect(instance.tasks[0].assignee).toBeNull();
    expect(pendingWith(instance, (r) => `Unassigned (${r})`)).toBe('Unassigned (NOBODY)');
  });

  it('computes due dates through the SLA port', () => {
    const c = context(people, new FixedClock(new Date('2025-03-01T00:00:00Z')), {
      dueAt: (_t, def, at) => new Date(at.getTime() + (def?.slaClass === 'inspection' ? 15 : 5) * 86_400_000),
    });
    const { instance } = start(headOffice, 1, c);
    expect(currentTasks(instance).find((t) => t.taskKey === 'inspection')?.dueAt).toBe('2025-03-16T00:00:00.000Z');
    expect(currentTasks(instance).find((t) => t.taskKey === 'section')?.dueAt).toBe('2025-03-06T00:00:00.000Z');
  });
});

describe('completing tasks', () => {
  it('advances once the mandatory tasks of the stage are done, leaving optional ones not required', () => {
    const c = ctx();
    let i = start(headOffice, 1, c).instance;
    i = complete(i, 1, 1, { data: { remark: 'ok' }, remarks: 'ok' }, c).instance;
    expect(activeStageIndex(i)).toBe(0);
    const r = complete(i, 2, 2, { data: {}, remarks: 'inspected', resultCode: 'Y' }, c);
    expect(stateOf(r.instance, 'committee')).toBe('not_required');
    expect(stateOf(r.instance, 'adfs')).toBe('active');
    expect(r.events.find((e) => e.type === 'StageCompleted')).toMatchObject({ stage: 'scrutiny', effects: { status: 3, label: 'Inspected' } });
    expect(currentTasks(r.instance).find((t) => t.taskKey === 'inspection')?.resultCode).toBe('Y');
  });

  it('saves drafts without completing', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    const r = saveDraft(i, 1, 1, { remark: 'draft' }, c);
    expect(r.instance.tasks[0]).toMatchObject({ state: 'active', draft: true, data: { remark: 'draft' } });
  });

  it('refuses anyone but the assignee, with the portal wording', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    expect(() => complete(i, 1, 99, { data: {}, remarks: '' }, c)).toThrow('Only the officer the task is assigned to can act on it.');
    expect(() => complete(i, 4, 4, { data: {}, remarks: '' }, c)).toThrow('This task is not open.');
  });

  it('refuses to complete the decision task as an ordinary task', () => {
    const c = ctx();
    let i = start(headOffice, 1, c).instance;
    i = complete(i, 1, 1, { data: {}, remarks: '' }, c).instance;
    i = complete(i, 2, 2, { data: {}, remarks: '' }, c).instance;
    i = complete(i, 4, 4, { data: {}, remarks: '' }, c).instance;
    expect(() => complete(i, 5, 5, { data: {}, remarks: '' }, c)).toThrow('Use the final decision to complete this task.');
  });

  it('never mutates its input', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    const before = JSON.stringify(i);
    complete(i, 1, 1, { data: { a: 1 }, remarks: 'x' }, c);
    expect(JSON.stringify(i)).toBe(before);
  });
});

describe('send back', () => {
  function atReview() {
    const c = ctx();
    let i = start(headOffice, 1, c).instance;
    i = complete(i, 1, 1, { data: { remark: 'section' }, remarks: 'section' }, c).instance;
    i = complete(i, 2, 2, { data: { remark: 'inspected' }, remarks: 'inspected' }, c).instance;
    return { c, i };
  }

  it('reopens the previous stage with its data and restores the earlier effects', () => {
    const { c, i } = atReview();
    const r = sendBack(i, 4, 4, 'please re-check', c);
    const current = currentTasks(r.instance);
    expect(current.find((t) => t.taskKey === 'section')).toMatchObject({ state: 'active', data: { remark: 'section' } });
    expect(current.find((t) => t.taskKey === 'inspection')).toMatchObject({ state: 'active', data: { remark: 'inspected' } });
    expect(r.instance.tasks.find((t) => t.no === 4)).toMatchObject({ state: 'sent_back', sentBackTo: 'scrutiny' });
    expect(r.events[0]).toMatchObject({ type: 'SentBack', toStage: 'scrutiny', restore: null });
  });

  it('requires comments and the permission', () => {
    const { c, i } = atReview();
    expect(() => sendBack(i, 4, 4, '  ', c)).toThrow('Enter the comments for the officer the file is sent back to.');
    const noPerm = start(headOffice, 1, c).instance;
    expect(() => sendBack(noPerm, 1, 1, 'x', c)).toThrow('This task cannot send the file back.');
  });
});

describe('bypass and reassign (the decider)', () => {
  it('lets the decider bypass a pending officer and advance', () => {
    const c = ctx();
    let i = start(headOffice, 1, c).instance;
    i = complete(i, 1, 1, { data: {}, remarks: '' }, c).instance;
    const r = skip(i, 2, 5, c);
    expect(stateOf(r.instance, 'inspection')).toBe('skipped');
    expect(stateOf(r.instance, 'adfs')).toBe('active');
  });

  it('refuses bypass to anyone else and on the decision', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    expect(() => skip(i, 2, 1, c)).toThrow('Only the issuing authority can bypass an officer.');
    expect(() => skip(i, 5, 5, c)).toThrow(/cannot be bypassed/);
  });

  it('reassigns to someone holding the role', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    const r = reassign(i, 2, 5, 6, c);
    expect(currentTasks(r.instance).find((t) => t.taskKey === 'inspection')?.assignee).toEqual({ id: 6, name: 'Another DFO' });
    expect(() => reassign(i, 2, 5, 3, c, { roleName: () => 'DFO' })).toThrow('The task needs a DFO.');
    expect(() => reassign(i, 4, 5, 6, c)).toThrow('The officer of this task cannot be changed.');
  });

  it('hands over every pending task of an officer (administrator)', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    const r = handover(i, 2, 6, c);
    expect(currentTasks(r.instance).find((t) => t.taskKey === 'inspection')?.assignee?.id).toBe(6);
  });

  it('re-resolves assignees only before anyone has acted', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    expect(reresolveAssignees(i, c).events[0].type).toBe('AssigneesResolved');
    const acted = complete(i, 1, 1, { data: {}, remarks: '' }, c).instance;
    expect(() => reresolveAssignees(acted, c)).toThrow(/before any officer has acted/);
  });
});

describe('decision', () => {
  function atDecision(withInspect = false) {
    const c = ctx();
    const def = withInspect
      ? definition([
          stage('inspection', [task('sfo', 'SFO', { onDemand: true })], { status: 3 }),
          stage('decision', [
            {
              ...decision('DG'),
              decision: {
                outcomes: [
                  { key: 'approve', terminal: true, effects: { status: 7 }, requiresAttachment: 'signed', requiresRemarks: true },
                  { key: 'reject', terminal: true, effects: { status: 9 } },
                  { key: 'inspect', terminal: false, activatesStage: 'inspection' },
                ],
              },
            },
          ]),
        ])
      : headOffice;
    let i = start(def, 1, c).instance;
    if (!withInspect) {
      i = complete(i, 1, 1, { data: {}, remarks: '' }, c).instance;
      i = complete(i, 2, 2, { data: {}, remarks: '' }, c).instance;
      i = complete(i, 4, 4, { data: {}, remarks: '' }, c).instance;
    }
    return { c, i };
  }

  it('completes the instance on a terminal outcome', () => {
    const { c, i } = atDecision();
    const r = decide(i, 5, 5, 'approve', { remarks: 'Issued' }, c);
    expect(r.instance.status).toBe('completed');
    expect(r.instance.outcome).toBe('approve');
    expect(r.events.at(-1)).toMatchObject({ type: 'InstanceCompleted', outcome: 'approve', effects: { outcome: 'approve' } });
  });

  it('enforces required attachments and remarks', () => {
    const { c, i } = atDecision(true);
    expect(() => decide(i, 2, 5, 'approve', { remarks: 'x' }, c)).toThrow(/Attach the signed/);
    expect(() => decide(i, 2, 5, 'approve', { remarks: '', attachments: ['signed'] }, c)).toThrow(/remarks/);
    expect(decide(i, 2, 5, 'approve', { remarks: 'ok', attachments: ['signed'] }, c).instance.status).toBe('completed');
  });

  it('activates the on-demand stage and brings the decision back afterwards', () => {
    const { c, i } = atDecision(true);
    const ordered = decide(i, 2, 5, 'inspect', { remarks: 'go inspect' }, c);
    expect(ordered.instance.status).toBe('running');
    expect(stateOf(ordered.instance, 'sfo')).toBe('active');
    expect(stateOf(ordered.instance, 'decision')).toBe('waiting');
    const inspected = complete(ordered.instance, 1, 3, { data: {}, remarks: 'fine' }, c);
    expect(stateOf(inspected.instance, 'decision')).toBe('active');
  });

  it('blocks outcomes once the total deadline has passed', () => {
    const clock = new FixedClock(new Date('2025-03-01T00:00:00Z'));
    const c = context(people, clock, {
      dueAt: () => undefined,
      totalDueAt: (inst) => new Date(new Date(inst.startedAt).getTime() + 30 * 86_400_000),
      outcomesBlockedAfterDeadline: ['return'],
    });
    let i = start(headOffice, 1, c).instance;
    i = complete(i, 1, 1, { data: {}, remarks: '' }, c).instance;
    i = complete(i, 2, 2, { data: {}, remarks: '' }, c).instance;
    i = complete(i, 4, 4, { data: {}, remarks: '' }, c).instance;
    clock.advanceDays(45);
    expect(() => decide(i, 5, 5, 'return', { remarks: 'x' }, c, { slaBlocked: 'SLA crossed.' })).toThrow('SLA crossed.');
    expect(allowedActions(i, 5, { blockedOutcomes: ['return'] }).outcomes).toEqual(['approve', 'reject']);
  });

  it('archives a finished run', () => {
    const { c, i } = atDecision();
    const done = decide(i, 5, 5, 'reject', { remarks: 'no' }, c).instance;
    expect(archive(done, c).instance.status).toBe('archived');
    expect(() => complete(archive(done, c).instance, 5, 5, { data: {}, remarks: '' }, c)).toThrow(WorkflowError);
  });
});

describe('allowedActions', () => {
  it('reports exactly what each actor may do', () => {
    const c = ctx();
    const i = start(headOffice, 1, c).instance;
    expect(allowedActions(i, 1)).toMatchObject({ save: [1], complete: [1], involved: true, decide: null });
    expect(allowedActions(i, 5)).toMatchObject({ skip: [1, 2, 3, 4], reassign: [1, 2, 3], involved: true });
    expect(allowedActions(i, 99)).toMatchObject({ save: [], complete: [], involved: false });
  });
});

describe('definition validation', () => {
  it('accepts a correct definition', () => {
    expect(validateDefinition(headOffice)).toEqual([]);
  });

  it('reports the structural problems', () => {
    const problems = validateDefinition(
      definition([stage('a', [task('x', 'R', { optional: true })]), stage('a', [task('y', 'R'), task('z', 'R')])]),
    );
    expect(problems.join(' ')).toContain('is used twice');
    expect(problems.join(' ')).toContain('at least one task must be mandatory');
    expect(problems.join(' ')).toContain('exactly one task');
  });

  it('runs host validators', () => {
    expect(validateDefinition(headOffice, [() => ['host says no']])).toEqual(['host says no']);
  });
});
