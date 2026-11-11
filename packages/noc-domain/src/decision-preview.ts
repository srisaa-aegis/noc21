/**
 * The application as it would look after a final decision — what the issuing
 * authority sees in the live NOC / letter preview while filling the decision
 * form. Never persisted; the real decision goes through the workflow engine on
 * the server, which computes the same values.
 */
import { certificateValidity, renewalPeriodYears } from './application-rules.js';
import { formatLegacyDate } from './dates.js';
import { processStep } from './application-factory.js';
import type { Application, DeptRole, RenewalRule, WorkflowOutcome, WorkflowTask } from './models/index.js';
import { currentTasks, finalStageIndex, roleCode } from './workflow-view.js';

export interface DecisionInput {
  remark: string;
  /** Signed scanned NOC / letter, uploaded before the decision. */
  signed_document?: { file_name: string; size?: number; file_id?: string } | null;
  /** Renewals: validity entered by the issuing authority (legacy dgfs_note). */
  valid_from?: string;
  valid_to?: string;
  /** Extra "Copy to" lines and remarks about the committee report. */
  addcc?: string;
  rem_comm?: string;
}

/** Process-log action of a decision. */
export function decisionAction(outcome: WorkflowOutcome, applType: string): string {
  return outcome === 'approve' ? (applType === 'D' ? 'Accepted' : 'Issued') : outcome === 'return' ? 'Returned' : outcome === 'reject' ? 'Rejected' : 'Inspection ordered';
}

/**
 * Validity of an approved certificate: the dates the authority entered, else the
 * renewal period from the issue date (Provisional NOCs carry no validity).
 */
export function decisionValidity(
  app: Pick<Application, 'appl_type' | 'blocks'>,
  issuedOn: string,
  input: Pick<DecisionInput, 'valid_from' | 'valid_to'>,
  renewal: { years: number } | { rules: RenewalRule[] },
): { valid_from: string; valid_to: string } | null {
  if (app.appl_type === 'P') return null;
  if (input.valid_from && input.valid_to) return { valid_from: input.valid_from, valid_to: input.valid_to };
  const years = 'years' in renewal ? renewal.years : renewalPeriodYears(app, renewal.rules);
  return certificateValidity(issuedOn, years);
}

export function decisionPreviewApp(
  app: Application,
  outcome: WorkflowOutcome,
  input: DecisionInput,
  roles: DeptRole[],
  renewal: { years: number } | { rules: RenewalRule[] },
  now: Date,
): Application {
  const a = JSON.parse(JSON.stringify(app)) as Application;
  const run = a.workflow;
  if (!run) return a;
  const date = formatLegacyDate(now);
  a.final_date = date;
  if (outcome === 'approve') {
    a.status_id = 7;
    const validity = decisionValidity(a, date, input, renewal);
    if (validity) Object.assign(a, validity);
  } else if (outcome === 'return') {
    a.status_id = 8;
  } else if (outcome === 'reject') {
    a.status_id = 9;
  }
  const finalKey = run.stages[finalStageIndex(run.stages)].key;
  const finalTask = currentTasks(run).find((t) => t.stage_key === finalKey)!;
  const previewTask: WorkflowTask = {
    ...JSON.parse(JSON.stringify(finalTask)),
    task_id: run.tasks.reduce((m, t) => Math.max(m, t.task_id), 0) + 1,
    data: JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
    remarks: input.remark?.trim() ?? '',
    decision: outcome,
    state: 'done',
    end_date: date,
  };
  run.tasks = [...run.tasks, previewTask];
  if (outcome !== 'inspect') {
    a.processLog = [
      ...a.processLog,
      processStep(a, decisionAction(outcome, a.appl_type), previewTask.remarks, { name: previewTask.assignee_name, role: roleCode(previewTask.role_id, roles) }, now),
    ];
  }
  return a;
}
