/**
 * @srisaa/workflow-engine — public types.
 *
 * The engine knows nothing about what is being processed. A *subject* (an
 * application, a leave request, a purchase order…) goes through a *process
 * definition*: sequential stages whose tasks run in parallel, ending in a stage
 * with a single decision task. Roles, actors, forms and stage "effects" are
 * opaque to the engine — the host application gives them meaning.
 */

export type Id = number | string;

// ---------------------------------------------------------------------------
// Definition (stored as an immutable, versioned document)
// ---------------------------------------------------------------------------

export interface TaskPermissions {
  /** The assignee may send the subject back to the previous stage. */
  sendBack: boolean;
  /** The assignee may ask the subject's owner for more input (documents…). */
  requestInput: boolean;
  /** The decider may bypass this task. */
  skippable: boolean;
  /** The decider may change the assignee. */
  reassignable: boolean;
}

export interface OutcomeDef {
  key: string;
  /** Completes the instance with this outcome. */
  terminal: boolean;
  /** Non-terminal: activates an on-demand stage, after which the decision comes back. */
  activatesStage?: string;
  /** Opaque data emitted with InstanceCompleted (e.g. the status the subject takes). */
  effects?: Record<string, unknown>;
  /** A named attachment the actor must provide to take this outcome. */
  requiresAttachment?: string;
  /** Remarks are mandatory for this outcome. */
  requiresRemarks?: boolean;
}

export interface TaskDef {
  key: string;
  name: string;
  /** Opaque role id; resolved to an actor by the AssigneeResolver port. */
  role: Id;
  /** Opaque form id. */
  form: string;
  actionLabel: string;
  /** The stage may complete without this task. */
  optional?: boolean;
  /** Only activated by a decision outcome (`activatesStage`). */
  onDemand?: boolean;
  /** SLA class used by the SlaPolicy port (e.g. "inspection"). */
  slaClass?: string;
  permissions: TaskPermissions;
  /** Only on the single task of the last stage. */
  decision?: { outcomes: OutcomeDef[] };
}

export interface StageDef {
  key: string;
  name: string;
  /** Opaque data emitted with StageCompleted (e.g. the status and label the subject takes). */
  effects?: Record<string, unknown>;
  tasks: TaskDef[];
}

export interface ProcessDefinition {
  code: string;
  name: string;
  version?: number;
  stages: StageDef[];
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface Actor {
  id: Id;
  name: string;
}

export type TaskState = 'waiting' | 'active' | 'done' | 'skipped' | 'sent_back' | 'not_required';
export type InstanceStatus = 'running' | 'completed' | 'archived';

export interface TaskInstance {
  /** Instance-local number; send back and re-activation append new rows. */
  no: number;
  stageKey: string;
  taskKey: string;
  name: string;
  role: Id;
  assignee: Actor | null;
  state: TaskState;
  /** ISO timestamps. */
  activatedAt?: string;
  dueAt?: string;
  completedAt?: string;
  form: string;
  data: Record<string, unknown>;
  draft: boolean;
  remarks: string;
  /** Short form-specific result, e.g. a recommendation "Y" / "N". */
  resultCode?: string;
  outcome?: string;
  sentBackTo?: string;
}

export interface Instance {
  definition: ProcessDefinition;
  /** E.g. the revision of the subject this run belongs to. */
  cycle: number;
  status: InstanceStatus;
  outcome?: string;
  /** The actor of the decision task. */
  decider: Actor | null;
  startedAt: string;
  completedAt?: string;
  tasks: TaskInstance[];
}

// ---------------------------------------------------------------------------
// Events (persisted as the instance's log, and handed to the host)
// ---------------------------------------------------------------------------

export type WorkflowEvent =
  | { type: 'InstanceStarted'; at: string }
  | { type: 'TaskActivated'; at: string; task: number }
  | { type: 'TaskDraftSaved'; at: string; task: number; actor: Id }
  | { type: 'TaskCompleted'; at: string; task: number; actor: Id; remarks: string }
  | { type: 'StageCompleted'; at: string; stage: string; effects: Record<string, unknown> }
  | { type: 'SentBack'; at: string; task: number; actor: Id; toStage: string; remarks: string; restore: Record<string, unknown> | null }
  | { type: 'TaskSkipped'; at: string; task: number; actor: Id }
  | { type: 'TaskReassigned'; at: string; task: number; actor: Id; from: Actor | null; to: Actor }
  | { type: 'AssigneesResolved'; at: string; tasks: number[] }
  | { type: 'DecisionTaken'; at: string; task: number; actor: Id; outcome: string; remarks: string }
  | { type: 'OnDemandStageActivated'; at: string; stage: string }
  | { type: 'InstanceCompleted'; at: string; outcome: string; effects: Record<string, unknown> }
  | { type: 'InstanceArchived'; at: string };

export interface Transition {
  instance: Instance;
  events: WorkflowEvent[];
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Who performs a role for a given subject. */
export interface AssigneeResolver {
  resolve(role: Id): Actor | null;
  /** May this actor hold the role (used when reassigning)? */
  canHoldRole(actor: Id, role: Id): boolean;
  /** Display name of an actor. */
  nameOf(actor: Id): string | undefined;
}

/** Due dates and the outcomes still allowed given the elapsed time. */
export interface SlaPolicy {
  dueAt(task: TaskInstance, taskDef: TaskDef | undefined, activatedAt: Date): Date | undefined;
  /** Total processing deadline of the instance. */
  totalDueAt?(instance: Instance): Date | undefined;
  /** Outcomes removed once the total deadline has passed (legacy: "return"). */
  outcomesBlockedAfterDeadline?: string[];
}

export interface Clock {
  now(): Date;
}

export interface EngineContext {
  assignees: AssigneeResolver;
  sla?: SlaPolicy;
  clock: Clock;
}

export interface DecisionInput {
  remarks: string;
  data?: Record<string, unknown>;
  /** Names of the attachments provided (checked against `requiresAttachment`). */
  attachments?: string[];
}
