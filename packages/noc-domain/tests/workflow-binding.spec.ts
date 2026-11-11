/**
 * The generic workflow engine, bound to the portal's definitions, must behave
 * exactly like the browser implementation it replaces — for all 12 shipped
 * workflows, driven from submission to the final decision.
 */
import { activeTasks, complete, currentTasks, decide, start, validateDefinition, type Instance } from '@srisaa/workflow-engine';
import { effectOf, SIGNED_DECISION, toProcessDefinition } from '../src/workflow-binding.js';
import { officersFor } from '../src/workflow-view.js';
import { fixture } from './fixtures.js';
import golden from './golden/workflow-trails.json' with { type: 'json' };
import type { FormDef, UserAccount, WorkflowDefinition } from '../src/models/index.js';

/**
 * The oracle: the trails the legacy browser engine (frontend core/domain/workflow.ts,
 * removed in B3) produced for every shipped workflow, recorded before it was deleted.
 */
const GOLDEN = golden as Record<string, { trail: string[]; tasks: number }>;

const workflows = fixture<WorkflowDefinition[]>('assets/data/config/workflows.json');
const forms = fixture<FormDef[]>('assets/data/config/forms.json');
const users = fixture<(UserAccount & { portal: 'dept' })[]>('assets/data/auth/users.json');

const STATION = 62; // Visakhapatnam: every role has an officer there

function engineContext(now: Date) {
  return {
    clock: { now: () => now },
    assignees: {
      resolve: (role: number | string) => {
        const o = officersFor(Number(role), STATION, users)[0];
        return o ? { id: o.username, name: o.displayName } : null;
      },
      canHoldRole: () => true,
      nameOf: (id: number | string) => users.find((u) => u.username === id)?.displayName,
    },
  };
}

describe('workflow binding', () => {
  it('converts all 12 shipped workflows into valid engine definitions', () => {
    expect(workflows).toHaveLength(12);
    for (const w of workflows) {
      expect({ code: w.code, problems: validateDefinition(toProcessDefinition(w, forms)) }).toEqual({ code: w.code, problems: [] });
    }
  });

  it('marks the inspection forms with the inspection SLA class', () => {
    const def = toProcessDefinition(workflows.find((w) => w.code === 'P-MSB')!, forms);
    const inspection = def.stages.flatMap((s) => s.tasks).find((t) => t.form === 'inspection_report');
    expect(inspection?.slaClass).toBe('inspection');
  });

  it('requires the signed copy and remarks for terminal decisions', () => {
    const def = toProcessDefinition(workflows.find((w) => w.code === 'P-MSB')!, forms);
    const outcomes = def.stages.at(-1)!.tasks[0].decision!.outcomes;
    expect(outcomes.find((o) => o.key === 'approve')).toMatchObject({ terminal: true, requiresAttachment: SIGNED_DECISION, effects: { status_id: 7 } });
  });

  for (const w of workflows) {
    it(`drives ${w.code} exactly like the legacy browser engine did`, () => {
      const now = new Date(2025, 0, 10);
      const ctx = engineContext(now);
      let inst: Instance = start(toProcessDefinition(w, forms), 1, ctx).instance;
      const trail: string[] = [];
      let status = effectOf(null);
      for (let step = 0; step < 20; step++) {
        const next = activeTasks(inst)[0];
        trail.push(`${status.status_id}|${status.stage_label}|${next?.taskKey ?? '-'}|${next?.assignee?.id ?? '-'}`);
        if (!next) break;
        if (next.stageKey === w.stages.at(-1)!.key) {
          const r = decide(inst, next.no, next.assignee!.id, 'approve', { remarks: 'ok', attachments: [SIGNED_DECISION] }, ctx);
          inst = r.instance;
          const done = r.events.find((e) => e.type === 'InstanceCompleted');
          if (done && done.type === 'InstanceCompleted') status = effectOf(done.effects);
        } else {
          const r = complete(inst, next.no, next.assignee!.id, { data: { remark: 'ok' }, remarks: 'ok' }, ctx);
          inst = r.instance;
          for (const e of r.events) if (e.type === 'StageCompleted') status = effectOf(e.effects);
        }
      }
      trail.push(`${status.status_id}|${status.stage_label}|${inst.status}`);
      expect(trail).toEqual(GOLDEN[w.code].trail);
      expect(currentTasks(inst).length).toBe(GOLDEN[w.code].tasks);
    });
  }
});
