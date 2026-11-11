/**
 * Administration of the configuration (phase B3): the rule sets behind fees,
 * approval levels and renewal periods; the department workflows; the SLA.
 *
 * Nothing is edited in place. A change publishes a new immutable version
 * (rules: re_rule_set_versions, workflows: wf_definition_versions); files in
 * process keep the version they started with, and every calculation records
 * the version it used. The cache triggers spread the change to every API
 * process and every open browser.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  delegationRuleProblems,
  delegationRulesToTable,
  feeConfigProblems,
  feeConfigToParameters,
  renewalRuleProblems,
  renewalRulesToTable,
  RULE_SETS,
  simulate,
  slaProblems,
  workflowSetProblems,
  definitionProblems,
  type DelegationRule,
  type DeptRole,
  type FeeConfig,
  type FormDef,
  type RenewalRule,
  type SimulatedTask,
  type SlaConfig,
  type UserAccount,
  type WorkflowDefinition,
} from '@srisaa/noc-domain';
import type { DirectoryBundle, WorkflowBundle } from '../cache/bundles.js';
import * as s from '../db/schema/index.js';
import { assert, businessRule, forbidden, notFound, validationFailed } from '../errors/app-error.js';
import type { Tx } from '../repositories/application.writer.js';
import { audit, reference, type ServiceContext } from './shared.js';

const checksum = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

function requireAdmin(c: ServiceContext): void {
  if (c.user.portal !== 'admin') throw forbidden('Only administrators can change the configuration.');
}

function problemsOrThrow(problems: string[], summary = 'The configuration cannot be saved.'): void {
  if (problems.length) throw validationFailed(`${summary} ${problems.join(' ')}`, problems.map((message) => ({ field: 'config', message })));
}

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

/** Publishes a new immutable version of a rule set and makes it current. */
async function publishRuleSet(tx: Tx, c: ServiceContext, code: string, definition: unknown, notes: string): Promise<number> {
  const [set] = await tx.select().from(s.reRuleSets).where(eq(s.reRuleSets.code, code)).for('update');
  if (!set) throw notFound(`Rule set ${code} not found.`);
  if (!set.editable) throw businessRule('This rule set is managed by the release, not through the portal.');
  const [latest] = await tx
    .select({ version: s.reRuleSetVersions.version, checksum: s.reRuleSetVersions.checksum })
    .from(s.reRuleSetVersions)
    .where(eq(s.reRuleSetVersions.ruleSetId, set.id))
    .orderBy(desc(s.reRuleSetVersions.version))
    .limit(1);
  const sum = checksum(definition);
  if (latest && latest.checksum === sum && set.currentVersionId) return set.currentVersionId; // nothing changed
  const [v] = await tx
    .insert(s.reRuleSetVersions)
    .values({
      ruleSetId: set.id,
      version: (latest?.version ?? 0) + 1,
      definition: definition as object,
      checksum: sum,
      status: 'published',
      publishedAt: new Date(),
      publishedBy: c.user.id,
      createdBy: c.user.id,
      notes,
    })
    .returning({ id: s.reRuleSetVersions.id, version: s.reRuleSetVersions.version });
  await tx.update(s.reRuleSets).set({ currentVersionId: v.id, updatedAt: new Date() }).where(eq(s.reRuleSets.id, set.id));
  await tx.insert(s.configChangeLog).values({ area: 'rules', entityId: `${code}@v${v.version}`, after: { notes }, changedBy: c.user.id });
  await audit(tx, c, 'rules.published', 'rule_set', code, `${code} v${v.version} published`);
  return v.id;
}

export async function saveFees(c: ServiceContext, config: FeeConfig): Promise<void> {
  requireAdmin(c);
  problemsOrThrow(feeConfigProblems(config));
  await c.db.transaction((tx) => publishRuleSet(tx, c, RULE_SETS.fees, feeConfigToParameters(config), 'Fees changed by the administrator.'));
}

export async function saveDelegationRules(c: ServiceContext, rules: DelegationRule[]): Promise<void> {
  requireAdmin(c);
  problemsOrThrow(delegationRuleProblems(rules));
  await c.db.transaction((tx) => publishRuleSet(tx, c, RULE_SETS.approvalLevel, delegationRulesToTable(rules), 'Approval-level rules changed by the administrator.'));
}

export async function saveRenewalRules(c: ServiceContext, rules: RenewalRule[]): Promise<void> {
  requireAdmin(c);
  problemsOrThrow(renewalRuleProblems(rules));
  await c.db.transaction((tx) => publishRuleSet(tx, c, RULE_SETS.renewalPeriod, renewalRulesToTable(rules), 'Renewal-period rules changed by the administrator.'));
}

/** The published versions of a rule set, newest first. */
export async function ruleSetVersions(c: ServiceContext, code: string) {
  const rows = await c.db
    .select({
      version: s.reRuleSetVersions.version,
      status: s.reRuleSetVersions.status,
      publishedAt: s.reRuleSetVersions.publishedAt,
      notes: s.reRuleSetVersions.notes,
      publishedBy: s.users.displayName,
      current: sql<boolean>`${s.reRuleSetVersions.id} = ${s.reRuleSets.currentVersionId}`,
    })
    .from(s.reRuleSetVersions)
    .innerJoin(s.reRuleSets, eq(s.reRuleSets.id, s.reRuleSetVersions.ruleSetId))
    .leftJoin(s.users, eq(s.users.id, s.reRuleSetVersions.publishedBy))
    .where(eq(s.reRuleSets.code, code))
    .orderBy(desc(s.reRuleSetVersions.version));
  if (!rows.length) throw notFound(`Rule set ${code} not found.`);
  return rows;
}

/** Evaluates the published version of a rule set for some facts (the admin "try it" panel), with its trace. */
export function evaluateRuleSet(c: ServiceContext, code: string, facts: Record<string, unknown> | Record<string, unknown>[]) {
  const engine = c.rules.get();
  if (!engine.has(code)) throw notFound(`Rule set ${code} not found.`);
  const result = Array.isArray(facts) ? engine.evaluateCollection(code, facts as never, { trace: true }) : engine.evaluate(code, facts as never, { trace: true });
  return result;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function context(c: ServiceContext): { roles: DeptRole[]; forms: FormDef[]; statuses: { code: number; category?: string; active?: boolean; is_pre_decision?: boolean }[] } {
  return {
    roles: reference(c).deptRoles as unknown as DeptRole[],
    forms: c.cache.data<WorkflowBundle>('workflow').forms as FormDef[],
    statuses: reference(c).statuses as never,
  };
}

const workflows = (c: ServiceContext) => c.cache.data<WorkflowBundle>('workflow').workflows as unknown as WorkflowDefinition[];

/** Problems of one definition and of the set it would produce (nothing is saved). */
export function validateWorkflow(c: ServiceContext, def: WorkflowDefinition): string[] {
  const { roles, forms, statuses } = context(c);
  const own = definitionProblems(def, roles, forms, statuses);
  if (own.length) return own;
  const set = workflows(c).map((w) => (w.code === def.code ? def : w));
  return workflowSetProblems(set, roles, forms, statuses);
}

/**
 * Saves a workflow as a new version. Applications already in process keep the
 * version they started with; new submissions use the new one.
 */
export async function saveWorkflow(c: ServiceContext, code: string, input: Pick<WorkflowDefinition, 'name' | 'stages'> & Partial<WorkflowDefinition>): Promise<WorkflowDefinition> {
  requireAdmin(c);
  const current = workflows(c).find((w) => w.code === code);
  if (!current) throw notFound('Workflow not found.');
  if ((input.appl_type && input.appl_type !== current.appl_type) || (input.level && input.level !== current.level)) {
    throw businessRule('The application type and level of a workflow cannot be changed.');
  }
  const def: WorkflowDefinition = { ...current, name: input.name, stages: input.stages.map((st) => ({ ...st, tasks: st.tasks.map((t) => ({ ...t, role_id: Number(t.role_id) })) })) };
  problemsOrThrow(validateWorkflow(c, def), 'The workflow cannot be saved.');
  await c.db.transaction(async (tx) => {
    await publishWorkflowVersion(tx, c, code, def.name, def.stages, 'Changed by the administrator.');
  });
  const saved = await definitionByCode(c, code);
  return saved;
}

async function publishWorkflowVersion(tx: Tx, c: ServiceContext, code: string, name: string, stages: WorkflowDefinition['stages'], notes: string): Promise<number> {
  const [d] = await tx.select().from(s.wfDefinitions).where(eq(s.wfDefinitions.code, code)).for('update');
  if (!d) throw notFound('Workflow not found.');
  const [latest] = await tx
    .select({ version: s.wfDefinitionVersions.version })
    .from(s.wfDefinitionVersions)
    .where(eq(s.wfDefinitionVersions.definitionId, d.id))
    .orderBy(desc(s.wfDefinitionVersions.version))
    .limit(1);
  const body = { code, name, subjectType: 'noc_application', stages };
  const [v] = await tx
    .insert(s.wfDefinitionVersions)
    .values({ definitionId: d.id, version: (latest?.version ?? 0) + 1, definition: body, checksum: checksum(body), notes, createdBy: c.user.id })
    .returning({ id: s.wfDefinitionVersions.id, version: s.wfDefinitionVersions.version });
  for (const roleId of new Set(stages.flatMap((st) => st.tasks.map((t) => Number(t.role_id))))) {
    await tx.insert(s.wfVersionRoles).values({ versionId: v.id, roleId }).onConflictDoNothing();
  }
  const formIds = new Map((await tx.select({ id: s.wfForms.id, code: s.wfForms.code }).from(s.wfForms)).map((f) => [f.code, f.id]));
  for (const form of new Set(stages.flatMap((st) => st.tasks.map((t) => t.form)))) {
    const formId = formIds.get(form);
    if (formId) await tx.insert(s.wfVersionForms).values({ versionId: v.id, formId }).onConflictDoNothing();
  }
  await tx.update(s.wfDefinitions).set({ name, currentVersionId: v.id, updatedAt: new Date(), updatedBy: c.user.id }).where(eq(s.wfDefinitions.id, d.id));
  await audit(tx, c, 'workflow.published', 'workflow', code, `${code} v${v.version}: ${notes}`);
  return v.version;
}

async function definitionByCode(c: ServiceContext, code: string): Promise<WorkflowDefinition> {
  const [row] = await c.db
    .select({ id: s.wfDefinitions.id, name: s.wfDefinitions.name, version: s.wfDefinitionVersions.version, body: s.wfDefinitionVersions.definition, updatedAt: s.wfDefinitions.updatedAt, by: s.users.displayName })
    .from(s.wfDefinitions)
    .innerJoin(s.wfDefinitionVersions, eq(s.wfDefinitionVersions.id, s.wfDefinitions.currentVersionId))
    .leftJoin(s.users, eq(s.users.id, s.wfDefinitions.updatedBy))
    .where(eq(s.wfDefinitions.code, code));
  if (!row) throw notFound('Workflow not found.');
  const [appl_type, level] = code.split('-');
  return {
    id: row.id,
    code,
    appl_type: appl_type as WorkflowDefinition['appl_type'],
    level: level as WorkflowDefinition['level'],
    name: row.name,
    version: row.version,
    updated_on: row.updatedAt.toISOString(),
    updated_by: row.by ?? '',
    stages: (row.body as { stages: WorkflowDefinition['stages'] }).stages,
  };
}

/** Every version of a workflow, newest first, with how many files run on it. */
export async function workflowVersions(c: ServiceContext, code: string) {
  const rows = await c.db.execute<{ version: number; created_at: Date; notes: string; created_by: string | null; current: boolean; total: string; in_process: string }>(sql`
    select v.version, v.created_at, v.notes, u.display_name as created_by, (v.id = d.current_version_id) as current,
           (select count(*) from wf_instances i where i.definition_version_id = v.id and i.status <> 'archived')::text as total,
           (select count(*) from wf_instances i where i.definition_version_id = v.id and i.status = 'running')::text as in_process
      from wf_definition_versions v
      join wf_definitions d on d.id = v.definition_id
      left join users u on u.id = v.created_by
     where d.code = ${code}
     order by v.version desc`);
  if (!rows.rows.length) throw notFound('Workflow not found.');
  return rows.rows.map((r) => ({ ...r, total: Number(r.total), in_process: Number(r.in_process) }));
}

/** Files per workflow and version (current runs only): { code: { version: { total, inProcess } } }. */
export async function workflowUsage(c: ServiceContext): Promise<Record<string, Record<number, { total: number; inProcess: number }>>> {
  const rows = await c.db.execute<{ code: string; version: number; total: string; in_process: string }>(sql`
    with u as (
      select i.definition_version_id as vid, count(*) as total, count(*) filter (where i.status = 'running') as in_process
        from applications a join wf_instances i on i.id = a.current_wf_instance_id
       where a.deleted_at is null
       group by 1)
    select d.code, v.version, u.total::text as total, u.in_process::text as in_process
      from u join wf_definition_versions v on v.id = u.vid join wf_definitions d on d.id = v.definition_id`);
  const out: Record<string, Record<number, { total: number; inProcess: number }>> = {};
  for (const r of rows.rows) (out[r.code] ??= {})[r.version] = { total: Number(r.total), inProcess: Number(r.in_process) };
  return out;
}

/** The shipped definitions (version 1 of each) — the admin's "reset to default". */
export async function workflowDefaults(c: ServiceContext): Promise<WorkflowDefinition[]> {
  const rows = await c.db
    .select({ id: s.wfDefinitions.id, code: s.wfDefinitions.code, body: s.wfDefinitionVersions.definition, createdAt: s.wfDefinitionVersions.createdAt })
    .from(s.wfDefinitionVersions)
    .innerJoin(s.wfDefinitions, eq(s.wfDefinitions.id, s.wfDefinitionVersions.definitionId))
    .where(eq(s.wfDefinitionVersions.version, 1))
    .orderBy(asc(s.wfDefinitions.code));
  return rows.map((r) => {
    const body = r.body as { name: string; stages: WorkflowDefinition['stages'] };
    const [appl_type, level] = r.code.split('-');
    return {
      id: r.id,
      code: r.code,
      appl_type: appl_type as WorkflowDefinition['appl_type'],
      level: level as WorkflowDefinition['level'],
      name: body.name,
      version: 1,
      updated_on: r.createdAt.toISOString(),
      updated_by: 'seed',
      stages: body.stages,
    };
  });
}

/** Republishes an earlier version as the new current one. */
export async function restoreWorkflowVersion(c: ServiceContext, code: string, version: number): Promise<WorkflowDefinition> {
  requireAdmin(c);
  const [row] = await c.db
    .select({ body: s.wfDefinitionVersions.definition })
    .from(s.wfDefinitionVersions)
    .innerJoin(s.wfDefinitions, eq(s.wfDefinitions.id, s.wfDefinitionVersions.definitionId))
    .where(and(eq(s.wfDefinitions.code, code), eq(s.wfDefinitionVersions.version, version)));
  if (!row) throw notFound('Workflow version not found.');
  const body = row.body as { name: string; stages: WorkflowDefinition['stages'] };
  const current = workflows(c).find((w) => w.code === code)!;
  problemsOrThrow(validateWorkflow(c, { ...current, name: body.name, stages: body.stages }), 'This version cannot be restored.');
  await c.db.transaction((tx) => publishWorkflowVersion(tx, c, code, body.name, body.stages, `Restored from version ${version}.`));
  return definitionByCode(c, code);
}

/** "Who would do what" for a fire station. */
export function simulateWorkflow(c: ServiceContext, def: WorkflowDefinition, fireStationId: number): SimulatedTask[] {
  const officers = c.cache.data<DirectoryBundle>('directory').officers;
  const users = officers.map((o) => ({ ...o, portal: 'dept', email: '', mobile: '', created_on: '' })) as unknown as UserAccount[];
  return simulate(def, fireStationId, users, reference(c).deptRoles as unknown as DeptRole[]);
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export async function saveSla(c: ServiceContext, sla: SlaConfig): Promise<void> {
  requireAdmin(c);
  assert(sla && sla.workflows && sla.escalation, 'Send the SLA of every workflow and the escalation settings.');
  problemsOrThrow(slaProblems(sla, workflows(c)), 'The SLA cannot be saved.');
  await c.db.transaction(async (tx) => {
    for (const w of workflows(c)) {
      const p = sla.workflows[w.code];
      const [d] = await tx.select({ id: s.wfDefinitions.id }).from(s.wfDefinitions).where(eq(s.wfDefinitions.code, w.code));
      await tx
        .insert(s.wfSlaPolicies)
        .values({ definitionId: d.id, totalDays: p.processing_days, classDays: { inspection: p.inspection_days }, taskDays: p.step_days ?? {}, updatedBy: c.user.id })
        .onConflictDoUpdate({
          target: s.wfSlaPolicies.definitionId,
          set: {
            totalDays: p.processing_days,
            classDays: { inspection: p.inspection_days },
            taskDays: p.step_days ?? {},
            version: sql`${s.wfSlaPolicies.version} + 1`,
            updatedAt: new Date(),
            updatedBy: c.user.id,
          },
        });
    }
    const e = sla.escalation;
    await tx
      .insert(s.wfEscalationSettings)
      .values({ id: 1, notifyAssignee: e.notify_officer, notifyDecider: e.notify_approver, remindEveryDays: e.remind_every_days, updatedBy: c.user.id })
      .onConflictDoUpdate({
        target: s.wfEscalationSettings.id,
        set: { notifyAssignee: e.notify_officer, notifyDecider: e.notify_approver, remindEveryDays: e.remind_every_days, updatedAt: new Date(), updatedBy: c.user.id },
      });
    await audit(tx, c, 'sla.saved', 'sla', 'all', 'SLA and escalation settings saved');
  });
}
