/**
 * Property-based tests: random command sequences against random (valid)
 * definitions must never break the engine's invariants.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  activeStageIndex,
  activeTasks,
  complete,
  currentTasks,
  decide,
  finalStageIndex,
  reassign,
  sendBack,
  skip,
  start,
  stageTasks,
  taskDefOf,
  validateDefinition,
  WorkflowError,
  type Instance,
  type ProcessDefinition,
} from '../src/index.js';
import { FixedClock, InMemoryDirectory, context, decision, definition, stage, task } from '../src/testing/index.js';

/** 2 000 in the default suite; `npm run test:deep` runs 10 000 (the B2 acceptance criterion). */
const DEEP_RUNS = Number(process.env.WF_PROPERTY_RUNS ?? 2000);

const ROLES = ['A', 'B', 'C', 'D'];
const people = new InMemoryDirectory([
  { id: 1, name: 'a1', roles: ['A'] },
  { id: 2, name: 'b1', roles: ['B'] },
  { id: 3, name: 'c1', roles: ['C'] },
  { id: 4, name: 'd1', roles: ['D'] },
  { id: 5, name: 'a2', roles: ['A'] },
  { id: 9, name: 'boss', roles: ['BOSS'] },
]);

const arbDefinition: fc.Arbitrary<ProcessDefinition> = fc
  .array(
    fc.record({
      tasks: fc.array(fc.record({ role: fc.constantFrom(...ROLES), optional: fc.boolean(), sendBack: fc.boolean() }), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
    { minLength: 1, maxLength: 4 },
  )
  .map((stages) =>
    definition([
      ...stages.map((s, si) =>
        stage(
          `s${si}`,
          s.tasks.map((t, ti) =>
            task(`t${si}_${ti}`, t.role, {
              optional: ti > 0 && t.optional,
              permissions: { sendBack: t.sendBack, requestInput: true, skippable: true, reassignable: true },
            }),
          ),
          { status: si + 3 },
        ),
      ),
      stage('decision', [decision('BOSS')]),
    ]),
  );

type Cmd =
  | { kind: 'complete'; pick: number }
  | { kind: 'sendBack'; pick: number }
  | { kind: 'skip'; pick: number }
  | { kind: 'reassign'; pick: number }
  | { kind: 'decide'; outcome: string };

const arbCmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ kind: fc.constant('complete' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('sendBack' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('skip' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('reassign' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('decide' as const), outcome: fc.constantFrom('approve', 'return', 'reject') }),
);

function apply(instance: Instance, cmd: Cmd, ctx: ReturnType<typeof context>): Instance {
  const active = activeTasks(instance);
  const pick = <T>(list: T[], n: number): T | undefined => (list.length ? list[n % list.length] : undefined);
  try {
    switch (cmd.kind) {
      case 'complete': {
        const t = pick(active.filter((x) => x.stageKey !== 'decision'), cmd.pick);
        return t?.assignee ? complete(instance, t.no, t.assignee.id, { data: {}, remarks: 'r' }, ctx).instance : instance;
      }
      case 'sendBack': {
        const t = pick(active, cmd.pick);
        return t?.assignee ? sendBack(instance, t.no, t.assignee.id, 'back', ctx).instance : instance;
      }
      case 'skip': {
        const t = pick(currentTasks(instance), cmd.pick);
        return t ? skip(instance, t.no, 9, ctx).instance : instance;
      }
      case 'reassign': {
        const t = pick(currentTasks(instance).filter((x) => x.role === 'A'), cmd.pick);
        return t ? reassign(instance, t.no, 9, 5, ctx).instance : instance;
      }
      case 'decide': {
        const t = active.find((x) => x.stageKey === 'decision');
        return t ? decide(instance, t.no, 9, cmd.outcome, { remarks: 'done' }, ctx).instance : instance;
      }
    }
  } catch (e) {
    if (e instanceof WorkflowError) return instance; // a rejected command leaves the instance unchanged
    throw e;
  }
}

function checkInvariants(i: Instance): void {
  const stages = i.definition.stages;
  const current = currentTasks(i);
  // 1. Task numbers are unique.
  expect(new Set(i.tasks.map((t) => t.no)).size).toBe(i.tasks.length);
  // 2. While running, exactly one stage is active (or none, when every task waits on a bypass cascade).
  if (i.status === 'running') {
    const activeStages = new Set(activeTasks(i).map((t) => t.stageKey));
    expect(activeStages.size).toBeLessThanOrEqual(1);
    // 3. The active stage is the first stage that still has unfinished mandatory work.
    const idx = activeStageIndex(i);
    if (idx >= 0) {
      for (let s = 0; s < idx; s++) {
        for (const t of stageTasks(i, stages[s].key)) {
          const def = taskDefOf(stages, t.stageKey, t.taskKey);
          expect(['done', 'skipped', 'not_required', 'waiting', 'sent_back'].includes(t.state) || !!def?.optional).toBe(true);
        }
      }
    }
  }
  // 4. The decision is the single task of the last stage.
  expect(stages[finalStageIndex(stages)].tasks).toHaveLength(1);
  // 5. A completed instance has a terminal outcome and no active task.
  if (i.status === 'completed') {
    expect(['approve', 'return', 'reject']).toContain(i.outcome);
    expect(activeTasks(i)).toHaveLength(0);
  }
  // 6. Every current task's assignee (if any) holds the task's role.
  for (const t of current) {
    if (t.assignee) expect(people.canHoldRole(t.assignee.id, t.role)).toBe(true);
  }
}

describe('workflow invariants under random command sequences', () => {
  it('every generated definition is valid', () => {
    fc.assert(
      fc.property(arbDefinition, (def) => {
        expect(validateDefinition(def)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it(`never violates the invariants (${DEEP_RUNS} random runs)`, () => {
    fc.assert(
      fc.property(arbDefinition, fc.array(arbCmd, { maxLength: 40 }), (def, cmds) => {
        const ctx = context(people, new FixedClock());
        let i = start(def, 1, ctx).instance;
        checkInvariants(i);
        for (const cmd of cmds) {
          i = apply(i, cmd, ctx);
          checkInvariants(i);
        }
      }),
      { numRuns: DEEP_RUNS },
    );
  });

  it('a rejected command never changes anything', () => {
    fc.assert(
      fc.property(arbDefinition, (def) => {
        const ctx = context(people, new FixedClock());
        const i = start(def, 1, ctx).instance;
        const before = JSON.stringify(i);
        try {
          complete(i, 999, 1, { data: {}, remarks: '' }, ctx);
        } catch {
          /* expected */
        }
        expect(JSON.stringify(i)).toBe(before);
      }),
      { numRuns: 100 },
    );
  });

  it('can always be driven to completion by its assignees', () => {
    fc.assert(
      fc.property(arbDefinition, (def) => {
        const ctx = context(people, new FixedClock());
        let i = start(def, 1, ctx).instance;
        for (let guard = 0; guard < 50 && i.status === 'running'; guard++) {
          const next = activeTasks(i)[0];
          if (!next) break;
          i =
            next.stageKey === 'decision'
              ? decide(i, next.no, 9, 'approve', { remarks: 'ok' }, ctx).instance
              : complete(i, next.no, next.assignee!.id, { data: {}, remarks: '' }, ctx).instance;
        }
        expect(i.status).toBe('completed');
      }),
      { numRuns: 300 },
    );
  });
});
