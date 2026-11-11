/**
 * Administration of the department workflows (Admin → Workflows, Admin → SLA):
 * validation of one definition and of the whole set, SLA validation, and the
 * "who would do what" simulator. Used by the server when an admin saves, and
 * by the admin pages for instant feedback.
 */
import type { DeptRole, FormDef, SlaConfig, UserAccount, WorkflowDefinition, WorkflowOutcome } from './models/index.js';
import { officersFor, roleCode } from './workflow-view.js';

const TYPES = ['P', 'O', 'R', 'D'] as const;
const LEVELS = ['MSB', 'RFO', 'DFO'] as const;

/** Checks one definition. Returns the problems (empty = valid). */
export function definitionProblems(def: WorkflowDefinition, roles: DeptRole[], forms: FormDef[], statuses?: { code: number; category?: string; active?: boolean }[]): string[] {
  const out: string[] = [];
  const formIds = new Set(forms.map((f) => f.id));
  const decisionForms = new Set(forms.filter((f) => f.decision).map((f) => f.id));
  const roleIds = new Set(roles.map((r) => r.id));
  const inProcess = statuses
    ? new Set(statuses.filter((s) => s.category === 'in_process' || s.category === 'submitted').filter((s) => s.active !== false).map((s) => s.code))
    : null;
  if (!def.name?.trim()) out.push('Enter a name for the workflow.');
  if (!def.stages?.length) {
    out.push('Add at least one stage.');
    return out;
  }
  const stageKeys = new Set<string>();
  const last = def.stages[def.stages.length - 1];
  def.stages.forEach((s, si) => {
    const sn = `Stage ${si + 1}${s.name ? ` (${s.name})` : ''}`;
    if (!s.key?.trim()) out.push(`${sn}: a key is required.`);
    else if (stageKeys.has(s.key)) out.push(`${sn}: the key "${s.key}" is used twice.`);
    stageKeys.add(s.key);
    if (!s.name?.trim()) out.push(`${sn}: enter a name.`);
    if (!s.stage_label?.trim()) out.push(`${sn}: enter the queue label.`);
    if (!s.tasks?.length) out.push(`${sn}: add at least one task.`);
    if (s !== last) {
      const ok = inProcess ? inProcess.has(s.citizen_status) : s.citizen_status >= 2 && s.citizen_status <= 6;
      if (!ok) out.push(`${sn}: the status after the stage must be an active in-process status.`);
    }
    const taskKeys = new Set<string>();
    (s.tasks ?? []).forEach((t, ti) => {
      const tn = `${sn}, task ${ti + 1}${t.name ? ` (${t.name})` : ''}`;
      if (!t.key?.trim()) out.push(`${tn}: a key is required.`);
      else if (taskKeys.has(t.key)) out.push(`${tn}: the key "${t.key}" is used twice in the stage.`);
      taskKeys.add(t.key);
      if (!t.name?.trim()) out.push(`${tn}: enter a name.`);
      if (!roleIds.has(Number(t.role_id))) out.push(`${tn}: select the role that performs the task.`);
      if (!formIds.has(t.form)) out.push(`${tn}: select a form.`);
      if (!t.action_label?.trim()) out.push(`${tn}: enter the dashboard action label.`);
      if (s !== last && decisionForms.has(t.form)) out.push(`${tn}: the final decision form can only be used in the last stage.`);
    });
    if (s !== last && s.tasks?.length && s.tasks.every((t) => t.optional)) out.push(`${sn}: at least one task must be mandatory.`);
  });
  if (last.tasks?.length !== 1 || !decisionForms.has(last.tasks[0]?.form)) {
    out.push('The last stage must have exactly one task using the Final Decision form.');
  } else {
    const d = last.tasks[0].decision;
    const outcomes = new Set(d?.outcomes ?? []);
    for (const o of ['approve', 'return', 'reject'] as WorkflowOutcome[]) {
      if (!outcomes.has(o)) out.push(`The final decision must allow "${o}".`);
    }
    if (outcomes.has('inspect')) {
      const target = def.stages.find((s) => s.key === d?.inspect_stage);
      if (!target || target === last) out.push('The "inspect" outcome needs the inspection stage it activates.');
      else if (!target.tasks.every((t) => t.on_demand)) out.push(`The tasks of stage "${target.name}" must be "only when ordered" to be used by the "inspect" outcome.`);
    }
  }
  const regular = def.stages.slice(0, -1).filter((s) => !s.tasks.every((t) => t.on_demand));
  for (let i = 1; i < regular.length; i++) {
    if (regular[i].citizen_status < regular[i - 1].citizen_status) {
      out.push(`Stage "${regular[i].name}": the status cannot go back (${regular[i - 1].citizen_status} → ${regular[i].citizen_status}).`);
    }
  }
  const preDecision = statuses?.filter((s) => (s as { is_pre_decision?: boolean }).is_pre_decision).map((s) => s.code) ?? [6];
  if (regular.length && !preDecision.includes(regular[regular.length - 1].citizen_status)) {
    out.push(`The stage before the final decision ("${regular[regular.length - 1].name}") must set status ${preDecision.join(' or ')} — Pending Final Approval.`);
  }
  return out;
}

/** Checks the full set: exactly one workflow per application type × level. */
export function workflowSetProblems(defs: WorkflowDefinition[], roles: DeptRole[], forms: FormDef[], statuses?: { code: number; category?: string; active?: boolean }[]): string[] {
  const out: string[] = [];
  for (const t of TYPES) {
    for (const l of LEVELS) {
      const n = defs.filter((d) => d.appl_type === t && d.level === l).length;
      if (n !== 1) out.push(`${t} · ${l}: ${n === 0 ? 'no workflow defined' : `${n} workflows defined (exactly one allowed)`}.`);
    }
  }
  for (const d of defs) out.push(...definitionProblems(d, roles, forms, statuses).map((p) => `${d.code}: ${p}`));
  return out;
}

export function slaProblems(sla: SlaConfig, defs: Pick<WorkflowDefinition, 'code'>[]): string[] {
  const out: string[] = [];
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 365;
  for (const d of defs) {
    const s = sla.workflows[d.code];
    if (!s) {
      out.push(`${d.code}: SLA not defined.`);
      continue;
    }
    if (!ok(s.processing_days)) out.push(`${d.code}: processing SLA must be 1-365 days.`);
    if (!ok(s.inspection_days)) out.push(`${d.code}: inspection SLA must be 1-365 days.`);
    if (ok(s.processing_days) && ok(s.inspection_days) && s.inspection_days > s.processing_days) out.push(`${d.code}: the inspection SLA cannot exceed the processing SLA.`);
    for (const [k, v] of Object.entries(s.step_days ?? {})) {
      if (!ok(v)) out.push(`${d.code}: SLA of step "${k}" must be 1-365 days.`);
    }
  }
  if (!(Number.isInteger(sla.escalation.remind_every_days) && sla.escalation.remind_every_days >= 1)) out.push('Escalation reminder interval must be at least 1 day.');
  if (!sla.escalation.notify_officer && !sla.escalation.notify_approver) out.push('Escalations must notify the officer, the issuing authority or both.');
  return out;
}

export interface SimulatedTask {
  stage: string;
  task: string;
  role: string;
  officers: string[];
  warning?: string;
}

/** "Who would do what" for a fire station — the admin simulator. */
export function simulate(def: WorkflowDefinition, fireStationId: number, users: UserAccount[], roles: DeptRole[]): SimulatedTask[] {
  return def.stages.flatMap((s) =>
    s.tasks.map((t) => {
      const officers = officersFor(Number(t.role_id), fireStationId, users);
      const role = roleCode(Number(t.role_id), roles);
      return {
        stage: s.name,
        task: t.name,
        role,
        officers: officers.map((o) => o.displayName),
        warning: !t.role_id
          ? 'Select the role that performs the task.'
          : officers.length === 0
            ? `No active ${role} is associated with this fire station — the task would be unassigned.`
            : officers.length > 1
              ? `${officers.length} ${role} officers are associated — the first (${officers[0].displayName}) is used.`
              : undefined,
      };
    }),
  );
}
