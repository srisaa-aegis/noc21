import { describe, expect, it } from 'vitest';
import { complete, decide, dueForReminder, overdueItems, start, validateDefinition, type ProcessDefinition } from '../src/index.js';
import { FixedClock, InMemoryDirectory, context, decision, definition, stage, task } from '../src/testing/index.js';

const people = new InMemoryDirectory([
  { id: 1, name: 'Section', roles: ['SEC'] },
  { id: 5, name: 'DG', roles: ['DG'] },
]);
const DAY = 86_400_000;
const t0 = new Date('2025-03-01T00:00:00Z');
const flow = definition([stage('s', [task('section', 'SEC')]), stage('decision', [decision('DG')])]);
const sla = {
  dueAt: (_t: unknown, _d: unknown, at: Date) => new Date(at.getTime() + 5 * DAY),
  totalDueAt: () => new Date(t0.getTime() + 30 * DAY),
};

describe('overdue detection (escalations)', () => {
  it('reports nothing before the due dates', () => {
    const { instance } = start(flow, 1, context(people, new FixedClock(t0), sla));
    expect(overdueItems(instance, new Date(t0.getTime() + 4 * DAY), sla)).toEqual([]);
  });

  it('reports an overdue task with its assignee, the decider and the days overdue', () => {
    const { instance } = start(flow, 1, context(people, new FixedClock(t0), sla));
    const items = overdueItems(instance, new Date(t0.getTime() + 8 * DAY), sla);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'task', taskName: 'section', assignee: 1, decider: 5, daysOverdue: 3 }),
    ]);
  });

  it('also reports the whole processing once the total deadline has passed', () => {
    const { instance } = start(flow, 1, context(people, new FixedClock(t0), sla));
    const items = overdueItems(instance, new Date(t0.getTime() + 31 * DAY), sla);
    expect(items.map((i) => i.kind)).toEqual(['task', 'total']);
    expect(items[1]).toMatchObject({ taskName: 'Whole processing', assignee: null, decider: 5, daysOverdue: 1 });
  });

  it('ignores finished instances', () => {
    const ctx = context(people, new FixedClock(t0), sla);
    let i = start(flow, 1, ctx).instance;
    i = complete(i, 1, 1, { data: {}, remarks: 'ok' }, ctx).instance;
    i = decide(i, 2, 5, 'approve', { remarks: 'approved' }, ctx).instance;
    expect(i.status).not.toBe('running');
    expect(overdueItems(i, new Date(t0.getTime() + 100 * DAY), sla)).toEqual([]);
  });

  it('works without an SLA policy (task due dates only)', () => {
    const { instance } = start(flow, 1, context(people, new FixedClock(t0), sla));
    expect(overdueItems(instance, new Date(t0.getTime() + 31 * DAY)).map((i) => i.kind)).toEqual(['task']);
  });

  it('does not remind again within the interval', () => {
    const now = new Date(t0.getTime() + 10 * DAY);
    const base = { kind: 'task' as const, taskName: 'x', assignee: 1, decider: 5, dueAt: t0.toISOString(), daysOverdue: 5 };
    const items = [
      { ...base, key: 'never' },
      { ...base, key: 'yesterday' },
      { ...base, key: 'last-week' },
    ];
    const last = new Map([
      ['yesterday', new Date(now.getTime() - 1 * DAY)],
      ['last-week', new Date(now.getTime() - 7 * DAY)],
    ]);
    expect(dueForReminder(items, last, 3, now).map((i) => i.key)).toEqual(['never', 'last-week']);
  });
});

describe('definition validation — every rule', () => {
  const ok = () => JSON.parse(JSON.stringify(definition([stage('a', [task('x', 'R')]), stage('decision', [decision('DG')])]))) as ProcessDefinition;

  it('needs a name and at least one stage', () => {
    expect(validateDefinition({ code: 'X', name: ' ', stages: [] })).toEqual(['Enter a name for the workflow.', 'Add at least one stage.']);
  });

  it('checks the keys, names, roles, forms and labels of stages and tasks', () => {
    const d = ok();
    d.stages[0] = { key: '', name: '', tasks: [{ ...d.stages[0].tasks[0], key: '', name: '', role: '', form: '', actionLabel: '' }] };
    const problems = validateDefinition(d).join(' | ');
    for (const text of ['a key is required', 'enter a name', 'select the role', 'select a form', 'dashboard action label']) expect(problems).toContain(text);
  });

  it('refuses a stage without tasks, a duplicate task key and a decision before the last stage', () => {
    const d = ok();
    d.stages.unshift({ key: 'empty', name: 'Empty', tasks: [] });
    d.stages[1].tasks.push({ ...d.stages[1].tasks[0] }, { ...d.stages[2].tasks[0], key: 'early' });
    const problems = validateDefinition(d).join(' | ');
    expect(problems).toContain('add at least one task');
    expect(problems).toContain('is used twice in the stage');
    expect(problems).toContain('a decision can only be taken in the last stage');
  });

  it('checks the outcomes of the decision', () => {
    const d = ok();
    const dec = d.stages[1].tasks[0].decision!;
    dec.outcomes = [
      { key: 'inspect', terminal: false, activatesStage: 'a' },
      { key: 'inspect', terminal: false, activatesStage: 'missing' },
    ];
    const problems = validateDefinition(d).join(' | ');
    expect(problems).toContain('at least one outcome that completes the workflow');
    expect(problems).toContain('defined twice');
    expect(problems).toContain('needs the stage it activates');
    expect(problems).toContain('must be "only when ordered"');
  });

  it('accepts an on-demand stage used by a non-terminal outcome', () => {
    const d = ok();
    d.stages.splice(1, 0, { key: 'extra', name: 'Extra inspection', tasks: [task('again', 'R', { onDemand: true })] });
    d.stages[2].tasks[0].decision!.outcomes.push({ key: 'inspect', terminal: false, activatesStage: 'extra' });
    expect(validateDefinition(d)).toEqual([]);
  });
});
