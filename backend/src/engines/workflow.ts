/**
 * Wiring of @srisaa/workflow-engine for the NOC portal:
 *
 *   - AssigneeResolver  officers of a role associated with the file's fire
 *                       station (Head Office officers: all stations), active
 *                       only, lowest id first — read from the cached directory;
 *   - SlaPolicy         the portal's SLA configuration (cached workflow bundle);
 *   - WorkflowStore     load / insert / persist instances in the wf_* tables,
 *                       with optimistic locking and the event log.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import {
  type Actor,
  type AssigneeResolver,
  type EngineContext,
  type Id,
  type Instance,
  type TaskInstance,
  type WorkflowEvent,
} from '@srisaa/workflow-engine';
import { nocSlaPolicy, toProcessDefinition, type FormDef, type WorkflowDefinition, type WorkflowSla } from '@srisaa/noc-domain';
import type { DirectoryBundle, WorkflowBundle } from '../cache/bundles.js';
import type { ReferenceCache } from '../cache/reference-cache.js';
import * as s from '../db/schema/index.js';
import { conflict } from '../errors/app-error.js';
import type { Tx } from '../repositories/application.writer.js';

export const SUBJECT_TYPE = 'noc_application';

/** Officers of a role for one fire station. */
export class StationAssigneeResolver implements AssigneeResolver {
  constructor(
    private readonly directory: DirectoryBundle,
    private readonly stationId: number | null,
  ) {}

  private officers() {
    return this.directory.officers.filter((o) => o.active);
  }

  resolve(role: Id): Actor | null {
    const match = this.officers()
      .filter((o) => String(o.role_id) === String(role))
      .filter((o) => o.all_stations || (this.stationId !== null && o.fire_station_ids.includes(this.stationId)))
      .sort((a, b) => a.id - b.id)[0];
    return match ? { id: match.id, name: match.displayName } : null;
  }

  canHoldRole(actor: Id, role: Id): boolean {
    return this.officers().some((o) => String(o.id) === String(actor) && String(o.role_id) === String(role));
  }

  nameOf(actor: Id): string | undefined {
    return this.officers().find((o) => String(o.id) === String(actor))?.displayName;
  }
}

export function workflowContext(cache: ReferenceCache, stationId: number | null, definitionCode: string, now: Date): EngineContext {
  const wf = cache.data<WorkflowBundle>('workflow');
  const sla = (wf.sla.workflows as Record<string, WorkflowSla>)[definitionCode];
  return {
    assignees: new StationAssigneeResolver(cache.data<DirectoryBundle>('directory'), stationId),
    sla: nocSlaPolicy(sla),
    clock: { now: () => now },
  };
}

export function formsOf(cache: ReferenceCache): FormDef[] {
  return cache.data<WorkflowBundle>('workflow').forms as FormDef[];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoredInstance {
  id: number;
  lockVersion: number;
  definitionId: number;
  definitionVersionId: number;
  definitionCode: string;
  instance: Instance;
}

/** The binding (application type × level) → the current definition version. */
export async function definitionFor(
  tx: Tx,
  applicationTypeCode: string,
  level: string,
): Promise<{ definitionId: number; versionId: number; code: string; definition: WorkflowDefinition } | null> {
  const [row] = await tx
    .select({
      definitionId: s.wfDefinitions.id,
      versionId: s.wfDefinitionVersions.id,
      code: s.wfDefinitions.code,
      version: s.wfDefinitionVersions.version,
      body: s.wfDefinitionVersions.definition,
      name: s.wfDefinitions.name,
    })
    .from(s.nocWorkflowBindings)
    .innerJoin(s.applicationTypes, eq(s.applicationTypes.id, s.nocWorkflowBindings.applicationTypeId))
    .innerJoin(s.wfDefinitions, eq(s.wfDefinitions.id, s.nocWorkflowBindings.definitionId))
    .innerJoin(s.wfDefinitionVersions, eq(s.wfDefinitionVersions.id, s.wfDefinitions.currentVersionId))
    .where(and(eq(s.applicationTypes.code, applicationTypeCode), eq(s.nocWorkflowBindings.level, level as 'MSB' | 'RFO' | 'DFO')))
    .limit(1);
  if (!row) return null;
  const body = row.body as { stages: WorkflowDefinition['stages'] };
  const [applType, lvl] = row.code.split('-');
  return {
    definitionId: row.definitionId,
    versionId: row.versionId,
    code: row.code,
    definition: {
      id: row.definitionId,
      code: row.code,
      appl_type: applType as WorkflowDefinition['appl_type'],
      level: lvl as WorkflowDefinition['level'],
      name: row.name,
      version: row.version,
      updated_on: '',
      updated_by: '',
      stages: body.stages,
    },
  };
}

/** The live (not archived) instance of an application, as an engine Instance. */
export async function loadLiveInstance(tx: Tx, applicationId: number, forms: FormDef[], forUpdate = false): Promise<StoredInstance | null> {
  const query = tx
    .select({
      instance: s.wfInstances,
      code: s.wfDefinitions.code,
      name: s.wfDefinitions.name,
      version: s.wfDefinitionVersions.version,
      body: s.wfDefinitionVersions.definition,
      deciderName: s.users.displayName,
    })
    .from(s.wfInstances)
    .innerJoin(s.wfDefinitions, eq(s.wfDefinitions.id, s.wfInstances.definitionId))
    .innerJoin(s.wfDefinitionVersions, eq(s.wfDefinitionVersions.id, s.wfInstances.definitionVersionId))
    .leftJoin(s.users, eq(s.users.id, s.wfInstances.deciderUserId))
    .where(and(eq(s.wfInstances.subjectType, SUBJECT_TYPE), eq(s.wfInstances.subjectId, applicationId), ne(s.wfInstances.status, 'archived')))
    .limit(1);
  const [row] = forUpdate ? await query.for('update', { of: s.wfInstances }) : await query;
  if (!row) return null;
  const tasks = await tx
    .select({ task: s.wfTasks, formCode: s.wfForms.code })
    .from(s.wfTasks)
    .leftJoin(s.wfForms, eq(s.wfForms.id, s.wfTasks.formId))
    .where(eq(s.wfTasks.instanceId, row.instance.id))
    .orderBy(asc(s.wfTasks.taskNo));
  const [applType, level] = row.code.split('-');
  const def: WorkflowDefinition = {
    id: row.instance.definitionId,
    code: row.code,
    appl_type: applType as WorkflowDefinition['appl_type'],
    level: level as WorkflowDefinition['level'],
    name: row.name,
    version: row.version,
    updated_on: '',
    updated_by: '',
    stages: (row.body as { stages: WorkflowDefinition['stages'] }).stages,
  };
  return {
    id: row.instance.id,
    lockVersion: row.instance.lockVersion,
    definitionId: row.instance.definitionId,
    definitionVersionId: row.instance.definitionVersionId,
    definitionCode: row.code,
    instance: {
      definition: toProcessDefinition(def, forms),
      cycle: row.instance.cycle,
      status: row.instance.status,
      outcome: row.instance.outcome ?? undefined,
      decider: row.instance.deciderUserId ? { id: row.instance.deciderUserId, name: row.deciderName ?? '' } : null,
      startedAt: row.instance.startedAt.toISOString(),
      completedAt: row.instance.completedAt?.toISOString(),
      tasks: tasks.map(({ task: t, formCode }) => ({
        no: t.taskNo,
        stageKey: t.stageKey,
        taskKey: t.taskKey,
        name: t.name,
        role: t.roleId ?? 0,
        assignee: t.assigneeUserId ? { id: t.assigneeUserId, name: t.assigneeName } : null,
        state: t.state,
        activatedAt: t.activatedAt?.toISOString(),
        dueAt: t.dueAt?.toISOString(),
        completedAt: t.completedAt?.toISOString(),
        form: formCode ?? '',
        data: (t.data ?? {}) as Record<string, unknown>,
        draft: t.draft,
        remarks: t.remarks,
        resultCode: t.resultCode ?? undefined,
        outcome: t.outcome ?? undefined,
        sentBackTo: t.sentBackToStage ?? undefined,
      })),
    },
  };
}

function taskRow(instanceId: number, t: TaskInstance, formIdByCode: Map<string, number>) {
  return {
    instanceId,
    taskNo: t.no,
    stageKey: t.stageKey,
    taskKey: t.taskKey,
    name: t.name,
    roleId: Number(t.role) || null,
    assigneeUserId: t.assignee ? Number(t.assignee.id) : null,
    assigneeName: t.assignee?.name ?? '',
    state: t.state,
    activatedAt: t.activatedAt ? new Date(t.activatedAt) : null,
    dueAt: t.dueAt ? new Date(t.dueAt) : null,
    completedAt: t.completedAt ? new Date(t.completedAt) : null,
    formId: formIdByCode.get(t.form) ?? null,
    data: t.data ?? {},
    draft: t.draft,
    remarks: t.remarks ?? '',
    resultCode: t.resultCode ?? null,
    outcome: t.outcome ?? null,
    sentBackToStage: t.sentBackTo ?? null,
    updatedAt: new Date(),
  };
}

async function formIds(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx.select({ id: s.wfForms.id, code: s.wfForms.code }).from(s.wfForms);
  return new Map(rows.map((r) => [r.code, r.id]));
}

async function insertEvents(tx: Tx, instanceId: number, events: WorkflowEvent[], actorUserId: number | null): Promise<void> {
  if (!events.length) return;
  await tx.insert(s.wfEvents).values(
    events.map((e) => ({
      instanceId,
      taskId: null,
      type: e.type,
      actorUserId,
      at: new Date(e.at),
      payload: e as unknown as Record<string, unknown>,
    })),
  );
}

/** Persists a freshly started instance. */
export async function insertInstance(
  tx: Tx,
  applicationId: number,
  binding: { definitionId: number; versionId: number },
  instance: Instance,
  events: WorkflowEvent[],
  actorUserId: number | null,
): Promise<number> {
  const [row] = await tx
    .insert(s.wfInstances)
    .values({
      definitionId: binding.definitionId,
      definitionVersionId: binding.versionId,
      subjectType: SUBJECT_TYPE,
      subjectId: applicationId,
      cycle: instance.cycle,
      status: instance.status,
      deciderUserId: instance.decider ? Number(instance.decider.id) : null,
      startedAt: new Date(instance.startedAt),
    })
    .returning({ id: s.wfInstances.id });
  const ids = await formIds(tx);
  await tx.insert(s.wfTasks).values(instance.tasks.map((t) => taskRow(row.id, t, ids)));
  await insertEvents(tx, row.id, events, actorUserId);
  return row.id;
}

/** Persists the result of a command (optimistic lock on the instance row). */
export async function persistInstance(
  tx: Tx,
  stored: StoredInstance,
  instance: Instance,
  events: WorkflowEvent[],
  actorUserId: number | null,
): Promise<void> {
  const updated = await tx
    .update(s.wfInstances)
    .set({
      status: instance.status,
      outcome: instance.outcome ?? null,
      deciderUserId: instance.decider ? Number(instance.decider.id) : null,
      completedAt: instance.completedAt ? new Date(instance.completedAt) : null,
      lockVersion: sql`${s.wfInstances.lockVersion} + 1`,
    })
    .where(and(eq(s.wfInstances.id, stored.id), eq(s.wfInstances.lockVersion, stored.lockVersion)))
    .returning({ id: s.wfInstances.id });
  if (!updated.length) throw conflict('This file was changed by someone else a moment ago. Please reload it and try again.');
  const ids = await formIds(tx);
  const rows = instance.tasks.map((t) => taskRow(stored.id, t, ids));
  if (rows.length) {
    await tx
      .insert(s.wfTasks)
      .values(rows)
      .onConflictDoUpdate({
        target: [s.wfTasks.instanceId, s.wfTasks.taskNo],
        set: {
          assigneeUserId: sql`excluded.assignee_user_id`,
          assigneeName: sql`excluded.assignee_name`,
          state: sql`excluded.state`,
          activatedAt: sql`excluded.activated_at`,
          dueAt: sql`excluded.due_at`,
          completedAt: sql`excluded.completed_at`,
          data: sql`excluded.data`,
          draft: sql`excluded.draft`,
          remarks: sql`excluded.remarks`,
          resultCode: sql`excluded.result_code`,
          outcome: sql`excluded.outcome`,
          sentBackToStage: sql`excluded.sent_back_to_stage`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  await insertEvents(tx, stored.id, events, actorUserId);
}
