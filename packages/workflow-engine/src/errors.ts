export type WorkflowErrorCode =
  | 'no_live_instance'
  | 'already_running'
  | 'task_not_found'
  | 'task_superseded'
  | 'task_not_open'
  | 'not_assignee'
  | 'not_decider'
  | 'use_decision'
  | 'not_decision_task'
  | 'send_back_not_allowed'
  | 'remarks_required'
  | 'no_previous_stage'
  | 'not_skippable'
  | 'not_pending'
  | 'decision_not_skippable'
  | 'not_reassignable'
  | 'invalid_assignee'
  | 'outcome_not_allowed'
  | 'outcome_blocked_by_sla'
  | 'attachment_required'
  | 'stage_not_configured'
  | 'already_acted'
  | 'not_completed'
  | 'invalid_definition';

/** A rejected command. `message` is user-presentable. */
export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export function fail(code: WorkflowErrorCode, message: string): never {
  throw new WorkflowError(code, message);
}
