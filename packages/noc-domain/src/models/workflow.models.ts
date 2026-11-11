/**
 * Department workflow — configuration (admin, config/workflows.json, config/forms.json, config/sla.json)
 * and the run kept on each submitted application. See docs/06-phase-3-design.md.
 */
import { DelegationLevel } from './application.models.js';

export type WorkflowOutcome = 'approve' | 'return' | 'reject' | 'inspect';

export interface WorkflowTaskPermissions {
  /** The officer may send the file back to the officers of the previous stage. */
  send_back: boolean;
  /** The officer may request documents from the citizen. */
  request_documents: boolean;
  /** The issuing authority may bypass this officer (legacy "X"). */
  skippable: boolean;
  /** The issuing authority may change this officer (legacy "C"). */
  reassignable: boolean;
}

/** One task of a stage — legacy process step (name "d", role "rid", form "template"). */
export interface WorkflowTaskDef {
  key: string;
  name: string;
  /** dept_roles.id */
  role_id: number;
  /** Form id (config/forms.json). */
  form: string;
  /** Dashboard button (legacy NextAction). */
  action_label: string;
  /** The stage may complete without this task. */
  optional?: boolean;
  /** Only activated by a decision (Declaration → "Inspection"). */
  on_demand?: boolean;
  permissions: WorkflowTaskPermissions;
  /** Only on the final task. */
  decision?: { outcomes: WorkflowOutcome[]; inspect_stage?: string };
}

/** Stages run in order; the tasks of one stage run in parallel. */
export interface WorkflowStageDef {
  key: string;
  name: string;
  /** Queue / status label once the stage is complete (legacy RoleStatuses label). */
  stage_label: string;
  /** Status shown to the citizen once the stage is complete (2-6). */
  citizen_status: number;
  tasks: WorkflowTaskDef[];
}

export interface WorkflowDefinition {
  /** wf_definitions.id (0 for a definition not saved yet). */
  id: number;
  /** Type × level code, e.g. "P-MSB" — SLA and bindings are keyed by it. */
  code: string;
  appl_type: 'P' | 'O' | 'R' | 'D';
  level: DelegationLevel;
  name: string;
  version: number;
  updated_on: string;
  updated_by: string;
  stages: WorkflowStageDef[];
}

export interface FormQuestion {
  key: string;
  label: string;
  kind: 'text' | 'choice';
  options?: { value: string; label: string }[];
  required?: boolean;
  show_if?: Record<string, string>;
}

export interface FormDef {
  id: string;
  kind: 'structured' | 'questionnaire';
  name: string;
  legacy: string;
  summary?: string;
  questions?: FormQuestion[];
  /** Inspection forms are timed by the inspection SLA. */
  inspection?: boolean;
  /** The final decision form. */
  decision?: boolean;
}

/** SLA of one workflow: per step, for the inspection and for the whole processing (days). */
export interface WorkflowSla {
  processing_days: number;
  inspection_days: number;
  /** Days per task key (non-inspection tasks). */
  step_days: Record<string, number>;
}

export interface EscalationConfig {
  notify_officer: boolean;
  notify_approver: boolean;
  remind_every_days: number;
}

export interface SlaConfig {
  workflows: Record<string, WorkflowSla>;
  escalation: EscalationConfig;
}

export type TaskState = 'waiting' | 'active' | 'done' | 'skipped' | 'sent_back' | 'not_required';

/** One row of the workflow table (legacy process step). */
export interface WorkflowTask {
  task_id: number;
  stage_key: string;
  task_key: string;
  name: string;
  role_id: number;
  /** Username of the assigned officer. */
  assignee: string | null;
  assignee_name: string;
  state: TaskState;
  start_date?: string;
  end_date?: string;
  form: string;
  data: Record<string, unknown>;
  draft: boolean;
  remarks: string;
  recommendation?: 'Y' | 'N';
  decision?: WorkflowOutcome;
  /** Set on a task that sent the file back: the stage it went back to. */
  sent_back_to?: string;
}

export interface WorkflowRun {
  /** Code of the definition (e.g. "P-MSB"). */
  definition_code: string;
  version: number;
  revision: number;
  started_on: string;
  /** Snapshot of the definition's stages. */
  stages: WorkflowStageDef[];
  tasks: WorkflowTask[];
  /** Username of the issuing authority (legacy application.approver). */
  approver: string | null;
  completed_on?: string;
  outcome?: WorkflowOutcome;
}

export interface DeptDocument {
  doc_id: number;
  /** Stored file (download through a one-time token). */
  file_id?: string;
  file_name: string;
  description: string;
  uploaded_by: string;
  uploaded_on: string;
}

export interface SmsMessage {
  sms_id: number;
  message: string;
  sent_by: string;
  sent_on: string;
}

export type EscalationKind = 'step' | 'inspection' | 'processing';

/** One overdue item found by "Send Escalations". */
export interface EscalationNotice {
  appl_id: number;
  appl_number: string;
  kind: EscalationKind;
  /** Task name, or "Whole processing" for the processing SLA. */
  task: string;
  /** Task id (0 for the processing SLA). */
  task_id: number;
  /** Officer(s) the task is pending with (usernames / names). */
  officers: string[];
  officer_names: string[];
  approver: string | null;
  approver_name: string;
  days_pending: number;
  sla_days: number;
  /** Usernames notified (per the escalation configuration). */
  recipients: string[];
}

/** One "Send Escalations" run (admin/escalations.json). */
export interface EscalationLogEntry {
  sent_at: string;
  recipients: number;
  applications: number;
  notices: EscalationNotice[];
}
