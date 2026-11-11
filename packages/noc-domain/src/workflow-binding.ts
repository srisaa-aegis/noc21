/**
 * The NOC binding of @srisaa/workflow-engine.
 *
 * The portal stores workflow definitions in its own shape (WorkflowDefinition,
 * with citizen_status / stage_label / role_id / decision outcomes …). This
 * module converts them to the engine's generic ProcessDefinition, and defines
 * what the generic events mean for an application (status, label).
 */
import type { OutcomeDef, ProcessDefinition, SlaPolicy, TaskDef, TaskInstance, Instance } from '@srisaa/workflow-engine';
import type { FormDef, WorkflowDefinition, WorkflowOutcome, WorkflowSla } from './models/index.js';

/** The attachment the issuing authority must upload before a final decision. */
export const SIGNED_DECISION = 'signed_decision';

/** Status and label an application takes for each terminal decision. */
export const OUTCOME_EFFECTS: Record<Exclude<WorkflowOutcome, 'inspect'>, { status_id: number; stage_label: string }> = {
  approve: { status_id: 7, stage_label: 'Approved' },
  return: { status_id: 8, stage_label: 'Returned with Comments' },
  reject: { status_id: 9, stage_label: 'Rejected' },
};

export const SUBMITTED_EFFECTS = { status_id: 2, stage_label: 'Submitted' };

/** Portal workflow definition → engine definition. */
export function toProcessDefinition(def: WorkflowDefinition, forms: Pick<FormDef, 'id' | 'inspection'>[] = []): ProcessDefinition {
  const inspectionForms = new Set(forms.filter((f) => f.inspection).map((f) => f.id));
  return {
    code: def.code,
    name: def.name,
    version: def.version,
    stages: def.stages.map((s) => ({
      key: s.key,
      name: s.name,
      effects: { status_id: s.citizen_status, stage_label: s.stage_label },
      tasks: s.tasks.map(
        (t): TaskDef => ({
          key: t.key,
          name: t.name,
          role: Number(t.role_id),
          form: t.form,
          actionLabel: t.action_label,
          optional: t.optional,
          onDemand: t.on_demand,
          slaClass: inspectionForms.has(t.form) ? 'inspection' : undefined,
          permissions: {
            sendBack: t.permissions.send_back,
            requestInput: t.permissions.request_documents,
            skippable: t.permissions.skippable,
            reassignable: t.permissions.reassignable,
          },
          ...(t.decision
            ? {
                decision: {
                  outcomes: t.decision.outcomes.map(
                    (o): OutcomeDef =>
                      o === 'inspect'
                        ? { key: 'inspect', terminal: false, activatesStage: t.decision?.inspect_stage }
                        : {
                            key: o,
                            terminal: true,
                            effects: OUTCOME_EFFECTS[o],
                            requiresAttachment: SIGNED_DECISION,
                            requiresRemarks: true,
                          },
                  ),
                },
              }
            : {}),
        }),
      ),
    })),
  };
}

const DAY = 86_400_000;

/** The portal's SLA rules: inspection forms use the inspection SLA, others their step SLA (7 days by default). */
export function nocSlaPolicy(sla: WorkflowSla | undefined): SlaPolicy {
  return {
    dueAt(task: TaskInstance, def: TaskDef | undefined, activatedAt: Date) {
      if (!sla) return new Date(activatedAt.getTime() + 7 * DAY);
      const days = def?.slaClass === 'inspection' ? sla.inspection_days : (sla.step_days[task.taskKey] ?? 7);
      return new Date(activatedAt.getTime() + days * DAY);
    },
    totalDueAt(instance: Instance) {
      return sla ? new Date(new Date(instance.startedAt).getTime() + sla.processing_days * DAY) : undefined;
    },
    // Legacy `rtimeout`: once the processing SLA is crossed the file can only be approved or rejected.
    outcomesBlockedAfterDeadline: ['return'],
  };
}

/** What a stage-completion / send-back / completion effect means for the application. */
export interface ApplicationEffect {
  status_id: number;
  stage_label: string;
}

export function effectOf(effects: Record<string, unknown> | null | undefined): ApplicationEffect {
  if (!effects || effects['status_id'] === undefined) return { ...SUBMITTED_EFFECTS };
  return { status_id: Number(effects['status_id']), stage_label: String(effects['stage_label'] ?? '') };
}
