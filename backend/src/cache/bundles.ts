/**
 * Builders for the five cached bundles (docs/backend/55-caching.md).
 *
 * Each bundle is built from the database in the shapes the portal consumes, so
 * a bundle can be served whole (immutable URL) or sliced per lookup.
 */
import { asc, eq } from 'drizzle-orm';
import {
  RULE_SETS,
  parametersToEscapeRules,
  parametersToFeeConfig,
  tableToDelegationRules,
  tableToRenewalRules,
} from '@srisaa/noc-domain';
import type { Database } from '../db/client.js';
import * as s from '../db/schema/index.js';

export const BUNDLE_NAMES = ['reference', 'rules', 'content', 'workflow', 'directory'] as const;
export type BundleName = (typeof BUNDLE_NAMES)[number];

export const PUBLIC_BUNDLES: BundleName[] = ['reference', 'rules', 'content'];

export interface ReferenceBundle {
  applicationTypes: unknown[];
  buildTypes: unknown[];
  directions: unknown[];
  districts: unknown[];
  fireStations: unknown[];
  regions: unknown[];
  hazards: unknown[];
  mappedCodes: unknown[];
  equipments: unknown[];
  ffeNotes: Record<string, string>;
  statuses: unknown[];
  deptRoles: unknown[];
  partyRoles: unknown[];
  blockOptions: Record<string, unknown[]>;
  documentRequirements: Record<string, unknown>;
  occupancyConditions: unknown[];
  undertakings: Record<string, unknown[]>;
}

export async function buildReference(db: Database): Promise<ReferenceBundle> {
  const [
    types,
    modes,
    buildTypes,
    subTypes,
    directions,
    districts,
    regions,
    stations,
    hazards,
    mappedCodes,
    equipments,
    ffeNotes,
    statuses,
    deptRoles,
    partyRoles,
    blockOptions,
    docReqs,
    occCond,
    undertakings,
  ] = await Promise.all([
    db.select().from(s.applicationTypes).orderBy(asc(s.applicationTypes.sortOrder)),
    db.select().from(s.applicationTypeModes).orderBy(asc(s.applicationTypeModes.sortOrder)),
    db.select().from(s.buildTypes).orderBy(asc(s.buildTypes.sortOrder)),
    db.select().from(s.buildSubTypes).orderBy(asc(s.buildSubTypes.sortOrder)),
    db.select().from(s.directions).orderBy(asc(s.directions.sortOrder)),
    db.select().from(s.districts).orderBy(asc(s.districts.id)),
    db.select().from(s.regions).orderBy(asc(s.regions.sortOrder)),
    db.select().from(s.fireStations).orderBy(asc(s.fireStations.districtId), asc(s.fireStations.sortOrder)),
    db.select().from(s.hazards).orderBy(asc(s.hazards.id)),
    db.select().from(s.mappedCodes).orderBy(asc(s.mappedCodes.id)),
    db.select().from(s.equipments).orderBy(asc(s.equipments.sortOrder)),
    db.select().from(s.ffeNotes).orderBy(asc(s.ffeNotes.id)),
    db.select().from(s.statuses).orderBy(asc(s.statuses.sortOrder)),
    db.select().from(s.deptRoles).orderBy(asc(s.deptRoles.id)),
    db.select().from(s.partyRoles).orderBy(asc(s.partyRoles.sortOrder)),
    db.select().from(s.blockOptionValues).orderBy(asc(s.blockOptionValues.groupKey), asc(s.blockOptionValues.sortOrder)),
    db.select().from(s.documentRequirements).orderBy(asc(s.documentRequirements.sortOrder)),
    db.select().from(s.occupancyConditions).orderBy(asc(s.occupancyConditions.sortOrder)),
    db.select().from(s.undertakings).orderBy(asc(s.undertakings.sortOrder)),
  ]);

  const typeCode = new Map(types.map((t) => [t.id, t.code]));
  const regionByDistrict = new Map(districts.map((d) => [d.id, d.regionId]));

  const blockOptionGroups: Record<string, unknown[]> = {};
  for (const o of blockOptions) (blockOptionGroups[o.groupKey] ??= []).push({ code: o.code, name: o.name });

  const docByType: Record<string, unknown> = {};
  for (const r of docReqs.filter((r) => r.scope === 'general')) {
    const code = r.applicationTypeId ? typeCode.get(r.applicationTypeId) : undefined;
    if (!code) continue;
    ((docByType[code] ??= []) as unknown[]).push({
      code: r.code,
      label: r.label,
      condition: r.condition,
      ...(r.optional ? { optional: true } : {}),
    });
  }
  const planBlocks = docReqs.filter((r) => r.scope === 'plan_block');
  const planFloor = docReqs.find((r) => r.scope === 'plan_floor');
  docByType['plans'] = {
    applies_to: planFloor?.appliesTo ?? [],
    block: planBlocks.map((p) => ({ code: p.code, label: p.label })),
    floor: planFloor ? { code: planFloor.code, label: planFloor.label } : { code: 'FloorPlan', label: 'Floor Plan' },
  };

  const undertakingsByType: Record<string, unknown[]> = {};
  for (const u of undertakings) {
    const code = typeCode.get(u.applicationTypeId);
    if (!code) continue;
    (undertakingsByType[code] ??= []).push({ id: u.code, text: u.text, required: u.required });
  }

  return {
    applicationTypes: types.map((t) => ({
      code: t.code,
      name: t.name,
      shortLabel: t.shortLabel,
      description: t.description,
      icon: t.icon,
      instructions: t.instructions,
      mode: modes
        .filter((m) => m.applicationTypeId === t.id)
        .map((m) => ({ code: m.code, name: m.name, ffe: m.ffeColumns })),
    })),
    buildTypes: buildTypes.map((b) => ({
      code: b.code,
      name: b.name,
      desc: b.description,
      minh: Number(b.minHeight),
      maxh: Number(b.maxHeight),
      sub: subTypes.filter((x) => x.buildTypeId === b.id).map((x) => ({ code: x.code, name: x.name })),
    })),
    directions: directions.map((d) => ({ code: d.code, name: d.name })),
    districts: districts.map((d) => ({
      id: d.id,
      desc: d.name,
      ddocode: d.ddoCode,
      distcode: d.distCode,
      region_id: d.regionId,
    })),
    fireStations: districts.map((d) => ({
      id: d.id,
      stations: stations.filter((st) => st.districtId === d.id).map((st) => ({ id: st.id, name: st.name })),
    })),
    regions: regions.map((r) => ({
      code: r.code,
      name: r.name,
      districts: districts.filter((d) => regionByDistrict.get(d.id) === r.id).map((d) => d.id),
    })),
    hazards: hazards.map((h) => ({ code: h.code, name: h.name, hazard_code: h.hazardCode })),
    mappedCodes: mappedCodes.map((m) => ({
      Activity_DTCP_Code: m.activityDtcpCode,
      DTCP_Desc: m.dtcpDesc,
      Activity_NBC_Code: m.activityNbcCode,
      Use_DTCP_Code: m.useDtcpCode,
      Use_NBC_Code: m.useNbcCode,
    })),
    equipments: equipments.map((e) => ({ id: e.id, desc: e.description, short: e.shortName, level: e.level, suffix: e.suffix })),
    ffeNotes: Object.fromEntries(ffeNotes.map((n) => [n.key, n.text])),
    statuses: statuses.map((st) => ({
      code: st.id,
      desc: st.name,
      category: st.category,
      is_system: st.isSystem,
      is_pre_decision: st.isPreDecision,
      sort_order: st.sortOrder,
      badge: st.badge,
      active: st.active,
    })),
    deptRoles: deptRoles.map((r) => ({ id: r.id, code: r.code, name: r.name, scope: r.scope, description: r.description })),
    partyRoles: partyRoles.map((p) => ({ role_name: p.name, required_for: p.requiredFor })),
    blockOptions: blockOptionGroups,
    documentRequirements: docByType,
    occupancyConditions: occCond.map((c) => ({ checklist_id: c.checklistNo, item_desc: c.itemDesc })),
    undertakings: undertakingsByType,
  };
}

export interface RulesBundle {
  /** Published rule-set definitions by code. */
  sets: Record<string, { versionId: number; version: number; kind: string; definition: unknown }>;
  /** Convenience projections in the shapes the portal already uses. */
  ffe: Record<string, unknown>;
  ffeType: unknown;
  otherNotes: unknown;
  riserWidth: unknown;
  heightLimits: unknown;
  feeConfig: unknown;
  delegationRules: unknown;
  renewalRules: unknown;
  escapeRules: unknown;
  versions: Record<string, number>;
}

export async function buildRules(db: Database): Promise<RulesBundle> {
  const rows = await db
    .select({
      code: s.reRuleSets.code,
      kind: s.reRuleSets.kind,
      versionId: s.reRuleSetVersions.id,
      version: s.reRuleSetVersions.version,
      definition: s.reRuleSetVersions.definition,
    })
    .from(s.reRuleSets)
    .innerJoin(s.reRuleSetVersions, eq(s.reRuleSetVersions.id, s.reRuleSets.currentVersionId))
    .orderBy(asc(s.reRuleSets.code));

  const sets: RulesBundle['sets'] = {};
  const versions: Record<string, number> = {};
  const ffe: Record<string, unknown> = {};
  for (const r of rows) {
    sets[r.code] = { versionId: r.versionId, version: r.version, kind: r.kind, definition: r.definition };
    versions[r.code] = r.versionId;
    const m = /^noc\.ffe\.equipment\.(\d+)$/.exec(r.code);
    if (m) ffe[m[1]] = r.definition;
  }
  const def = (code: string) => sets[code]?.definition;
  return {
    sets,
    ffe,
    ffeType: def(RULE_SETS.ffeType),
    otherNotes: def(RULE_SETS.ffeOtherNotes),
    riserWidth: def(RULE_SETS.ffeRiserWidth),
    heightLimits: def(RULE_SETS.heightLimits),
    feeConfig: def(RULE_SETS.fees) ? parametersToFeeConfig(def(RULE_SETS.fees) as never) : null,
    delegationRules: def(RULE_SETS.approvalLevel) ? tableToDelegationRules(def(RULE_SETS.approvalLevel) as never) : [],
    renewalRules: def(RULE_SETS.renewalPeriod) ? tableToRenewalRules(def(RULE_SETS.renewalPeriod) as never) : [],
    escapeRules: def(RULE_SETS.escapeLimits) ? parametersToEscapeRules(def(RULE_SETS.escapeLimits) as never) : null,
    versions,
  };
}

export interface ContentBundle {
  nocTerms: unknown;
  nbcTable7: unknown;
}

export async function buildContent(db: Database): Promise<ContentBundle> {
  const docs = await db.select().from(s.referenceDocuments);
  const byKey = new Map(docs.map((d) => [d.key, d.payload]));
  return { nocTerms: byKey.get('noc_terms') ?? null, nbcTable7: byKey.get('nbc_table7') ?? null };
}

export interface WorkflowBundle {
  workflows: unknown[];
  forms: unknown[];
  sla: { workflows: Record<string, unknown>; escalation: Record<string, unknown> };
}

export async function buildWorkflow(db: Database): Promise<WorkflowBundle> {
  const [defs, forms, policies, settings] = await Promise.all([
    db
      .select({
        id: s.wfDefinitions.id,
        code: s.wfDefinitions.code,
        name: s.wfDefinitions.name,
        version: s.wfDefinitionVersions.version,
        definition: s.wfDefinitionVersions.definition,
        updatedAt: s.wfDefinitions.updatedAt,
      })
      .from(s.wfDefinitions)
      .innerJoin(s.wfDefinitionVersions, eq(s.wfDefinitionVersions.id, s.wfDefinitions.currentVersionId))
      .orderBy(asc(s.wfDefinitions.code)),
    db.select().from(s.wfForms).orderBy(asc(s.wfForms.id)),
    db
      .select({ code: s.wfDefinitions.code, policy: s.wfSlaPolicies })
      .from(s.wfSlaPolicies)
      .innerJoin(s.wfDefinitions, eq(s.wfDefinitions.id, s.wfSlaPolicies.definitionId)),
    db.select().from(s.wfEscalationSettings).limit(1),
  ]);

  const slaWorkflows: Record<string, unknown> = {};
  for (const row of policies) {
    slaWorkflows[row.code] = {
      processing_days: row.policy.totalDays,
      inspection_days: (row.policy.classDays as Record<string, number>)?.inspection ?? row.policy.totalDays,
      step_days: row.policy.taskDays ?? {},
    };
  }

  return {
    workflows: defs.map((d) => {
      const body = d.definition as { stages: unknown[]; appl_type?: string; level?: string };
      const [applType, level] = d.code.split('-');
      return {
        id: d.id,
        code: d.code,
        appl_type: applType,
        level,
        name: d.name,
        version: d.version,
        updated_on: d.updatedAt,
        updated_by: '',
        stages: body.stages,
      };
    }),
    forms: forms.map((f) => ({
      id: f.code,
      kind: f.kind,
      name: f.name,
      legacy: f.legacy,
      summary: f.summary,
      ...(f.slaClass === 'inspection' ? { inspection: true } : {}),
      ...(f.isDecision ? { decision: true } : {}),
      ...((f.definition as { questions?: unknown[] })?.questions ? { questions: (f.definition as { questions: unknown[] }).questions } : {}),
    })),
    sla: {
      workflows: slaWorkflows,
      escalation: {
        notify_officer: settings[0]?.notifyAssignee ?? true,
        notify_approver: settings[0]?.notifyDecider ?? true,
        remind_every_days: settings[0]?.remindEveryDays ?? 7,
      },
    },
  };
}

export interface DirectoryBundle {
  officers: {
    id: number;
    username: string;
    displayName: string;
    role_id: number;
    district_id: number | null;
    all_stations: boolean;
    fire_station_ids: number[];
    active: boolean;
  }[];
}

export async function buildDirectory(db: Database): Promise<DirectoryBundle> {
  const rows = await db
    .select({
      id: s.users.id,
      username: s.users.username,
      displayName: s.users.displayName,
      active: s.users.active,
      roleId: s.deptProfiles.roleId,
      districtId: s.deptProfiles.districtId,
      allStations: s.deptProfiles.allStations,
    })
    .from(s.users)
    .innerJoin(s.deptProfiles, eq(s.deptProfiles.userId, s.users.id))
    .orderBy(asc(s.users.id));
  const stations = await db.select().from(s.deptUserStations);
  return {
    officers: rows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role_id: u.roleId,
      district_id: u.districtId,
      all_stations: u.allStations,
      fire_station_ids: stations.filter((x) => x.userId === u.id).map((x) => x.fireStationId),
      active: u.active,
    })),
  };
}

export const BUNDLE_BUILDERS: Record<BundleName, (db: Database) => Promise<unknown>> = {
  reference: buildReference,
  rules: buildRules,
  content: buildContent,
  workflow: buildWorkflow,
  directory: buildDirectory,
};
