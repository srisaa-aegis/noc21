/**
 * Master data, rule sets and workflow configuration.
 *
 * Idempotent: every row is upserted on its natural key, so `db:seed` can run
 * any number of times and is safe to run in any environment
 * (`db:seed:master`). Rows whose legacy id is an integer keep that id.
 */
import { createHash } from 'node:crypto';
import { eq, notInArray, sql } from 'drizzle-orm';
import {
  RULE_SETS,
  delegationRulesToTable,
  escapeRulesToParameters,
  feeConfigToParameters,
  renewalRulesToTable,
} from '@srisaa/noc-domain';
import type { Database } from '../client.js';
import * as s from '../schema/index.js';
import { corrections, seedInputs } from './inputs.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const STATUS_META: Record<number, { category: (typeof s.statusCategory.enumValues)[number]; system: boolean; preDecision: boolean; badge: string }> = {
  1: { category: 'draft', system: true, preDecision: false, badge: 'DRF' },
  2: { category: 'submitted', system: true, preDecision: false, badge: 'SUB' },
  3: { category: 'in_process', system: false, preDecision: false, badge: 'INS' },
  4: { category: 'in_process', system: false, preDecision: false, badge: 'REV' },
  5: { category: 'in_process', system: false, preDecision: false, badge: 'REV' },
  6: { category: 'in_process', system: false, preDecision: true, badge: 'PFA' },
  7: { category: 'approved', system: true, preDecision: false, badge: 'ISS' },
  8: { category: 'returned', system: true, preDecision: false, badge: 'RET' },
  9: { category: 'rejected', system: true, preDecision: false, badge: 'REJ' },
};

/** The official status names (decision Q-7). A used status can never be renamed or reinterpreted. */
const STATUS_NAMES: Record<number, string> = {
  1: 'Draft',
  2: 'Submitted',
  3: 'Inspected',
  4: 'Reviewed (ADFS)',
  5: 'Reviewed (DFS-CD)',
  6: 'Pending Final Approval',
  7: 'Approved / Issued',
  8: 'Returned with Comments',
  9: 'Rejected',
};

const checksum = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

async function resetIdentity(tx: Tx, table: string): Promise<void> {
  await tx.execute(
    sql.raw(
      `select setval(pg_get_serial_sequence('${table}', 'id'), greatest((select coalesce(max(id), 0) from "${table}"), 1))`,
    ),
  );
}

export interface MasterSeedResult {
  counts: Record<string, number>;
  notes: string[];
}

export async function seedMaster(tx: Tx): Promise<MasterSeedResult> {
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  const count = (k: string, n: number) => (counts[k] = n);

  // ── Regions, districts, fire stations ─────────────────────────────────────
  const regions = seedInputs.regions();
  for (const [i, r] of regions.entries()) {
    await tx
      .insert(s.regions)
      .values({ code: r.code, name: r.name, sortOrder: i })
      .onConflictDoUpdate({ target: s.regions.code, set: { name: r.name, sortOrder: i } });
  }
  count('regions', regions.length);
  const regionIdByCode = new Map(
    (await tx.select({ id: s.regions.id, code: s.regions.code }).from(s.regions)).map((r) => [r.code, r.id]),
  );
  const regionOfDistrict = new Map<number, number>();
  for (const r of regions) for (const d of r.districts) regionOfDistrict.set(d, regionIdByCode.get(r.code) as number);

  const districts = seedInputs.districts();
  for (const [i, d] of districts.entries()) {
    await tx
      .insert(s.districts)
      .values({
        id: d.id,
        name: d.desc,
        ddoCode: d.ddocode ?? '',
        distCode: d.distcode ?? '',
        regionId: regionOfDistrict.get(d.id) ?? null,
        sortOrder: i,
      })
      .onConflictDoUpdate({
        target: s.districts.id,
        set: { name: d.desc, ddoCode: d.ddocode ?? '', distCode: d.distcode ?? '', regionId: regionOfDistrict.get(d.id) ?? null },
      });
  }
  await resetIdentity(tx, 'districts');
  count('districts', districts.length);

  const stationRows: { id: number; name: string; districtId: number; sortOrder: number }[] = [];
  for (const group of seedInputs.fireStations()) {
    const districtId = Number(group.id);
    for (const [i, st] of group.stations.entries()) {
      stationRows.push({ id: Number(st.id), name: st.name, districtId, sortOrder: i });
    }
  }
  await tx
    .insert(s.fireStations)
    .values(stationRows)
    .onConflictDoUpdate({
      target: s.fireStations.id,
      set: { name: sql`excluded.name`, districtId: sql`excluded.district_id`, sortOrder: sql`excluded.sort_order` },
    });
  const stationCount = stationRows.length;
  await resetIdentity(tx, 'fire_stations');
  count('fire_stations', stationCount);

  // ── Application types and modes ───────────────────────────────────────────
  const applicationTypes = seedInputs.applicationTypes();
  let modeCount = 0;
  for (const [i, t] of applicationTypes.entries()) {
    const [row] = await tx
      .insert(s.applicationTypes)
      .values({
        code: t.code,
        name: t.name,
        shortLabel: t.shortLabel ?? '',
        description: t.description ?? '',
        icon: t.icon ?? '',
        instructions: t.instructions ?? [],
        sortOrder: i,
      })
      .onConflictDoUpdate({
        target: s.applicationTypes.code,
        set: {
          name: t.name,
          shortLabel: t.shortLabel ?? '',
          description: t.description ?? '',
          icon: t.icon ?? '',
          instructions: t.instructions ?? [],
          sortOrder: i,
        },
      })
      .returning({ id: s.applicationTypes.id });
    for (const [j, m] of t.mode.entries()) {
      await tx
        .insert(s.applicationTypeModes)
        .values({ applicationTypeId: row.id, code: m.code, name: m.name, ffeColumns: m.ffe, sortOrder: j })
        .onConflictDoUpdate({
          target: [s.applicationTypeModes.applicationTypeId, s.applicationTypeModes.code],
          set: { name: m.name, ffeColumns: m.ffe, sortOrder: j },
        });
      modeCount++;
    }
  }
  count('application_types', applicationTypes.length);
  count('application_type_modes', modeCount);

  // ── Building types ────────────────────────────────────────────────────────
  const buildTypes = seedInputs.buildTypes();
  let subCount = 0;
  for (const [i, b] of buildTypes.entries()) {
    const [row] = await tx
      .insert(s.buildTypes)
      .values({
        code: b.code,
        name: b.name,
        description: b.desc ?? '',
        minHeight: String(b.minh ?? 0),
        maxHeight: String(b.maxh ?? 0),
        sortOrder: i,
      })
      .onConflictDoUpdate({
        target: s.buildTypes.code,
        set: { name: b.name, description: b.desc ?? '', minHeight: String(b.minh ?? 0), maxHeight: String(b.maxh ?? 0), sortOrder: i },
      })
      .returning({ id: s.buildTypes.id });
    for (const [j, sub] of (b.sub ?? []).entries()) {
      await tx
        .insert(s.buildSubTypes)
        .values({ buildTypeId: row.id, code: sub.code, name: sub.name, sortOrder: j })
        .onConflictDoUpdate({ target: [s.buildSubTypes.buildTypeId, s.buildSubTypes.code], set: { name: sub.name, sortOrder: j } });
      subCount++;
    }
  }
  count('build_types', buildTypes.length);
  count('build_sub_types', subCount);

  // ── Simple lookups ────────────────────────────────────────────────────────
  const directions = seedInputs.directions();
  for (const [i, d] of directions.entries()) {
    await tx
      .insert(s.directions)
      .values({ code: d.code, name: d.name, sortOrder: i })
      .onConflictDoUpdate({ target: s.directions.code, set: { name: d.name, sortOrder: i } });
  }
  count('directions', directions.length);

  const hazards = seedInputs.hazards();
  await tx
    .insert(s.hazards)
    .values(hazards.map((h) => ({ code: h.code, name: h.name, hazardCode: h.hazard_code ?? '' })))
    .onConflictDoUpdate({ target: s.hazards.code, set: { name: sql`excluded.name`, hazardCode: sql`excluded.hazard_code` } });
  count('hazards', hazards.length);

  const mappedCodes = seedInputs.mappedCodes();
  await tx.delete(s.mappedCodes);
  await tx.insert(s.mappedCodes).values(
    mappedCodes.map((m) => ({
      activityDtcpCode: m.Activity_DTCP_Code ?? '',
      dtcpDesc: m.DTCP_Desc ?? '',
      activityNbcCode: m.Activity_NBC_Code ?? '',
      useDtcpCode: m.Use_DTCP_Code ?? '',
      useNbcCode: m.Use_NBC_Code ?? '',
    })),
  );
  count('mapped_codes', mappedCodes.length);

  const equipments = seedInputs.equipments();
  for (const [i, e] of equipments.entries()) {
    await tx
      .insert(s.equipments)
      .values({ id: e.id, description: e.desc, shortName: e.short ?? '', level: e.level, suffix: e.suffix ?? '', sortOrder: i })
      .onConflictDoUpdate({
        target: s.equipments.id,
        set: { description: e.desc, shortName: e.short ?? '', level: e.level, suffix: e.suffix ?? '', sortOrder: i },
      });
  }
  await resetIdentity(tx, 'equipments');
  count('equipments', equipments.length);

  const ffeNotes = Object.entries(seedInputs.ffeNotes());
  await tx
    .insert(s.ffeNotes)
    .values(ffeNotes.map(([key, text]) => ({ key, text })))
    .onConflictDoUpdate({ target: s.ffeNotes.key, set: { text: sql`excluded.text` } });
  count('ffe_notes', ffeNotes.length);

  const statuses = seedInputs.statuses();
  for (const st of statuses) {
    const meta = STATUS_META[st.code];
    await tx
      .insert(s.statuses)
      .values({
        id: st.code,
        name: STATUS_NAMES[st.code] ?? st.desc,
        category: meta.category,
        isSystem: meta.system,
        isPreDecision: meta.preDecision,
        badge: meta.badge,
        sortOrder: st.code,
      })
      .onConflictDoUpdate({
        target: s.statuses.id,
        set: { name: STATUS_NAMES[st.code] ?? st.desc, badge: meta.badge, sortOrder: st.code },
      });
  }
  await resetIdentity(tx, 'statuses');
  count('statuses', statuses.length);

  const deptRoles = seedInputs.deptRoles();
  for (const r of deptRoles) {
    await tx
      .insert(s.deptRoles)
      .values({ id: Number(r.id), code: r.code, name: r.name, scope: r.scope, description: r.description ?? '' })
      .onConflictDoUpdate({ target: s.deptRoles.id, set: { code: r.code, name: r.name, scope: r.scope, description: r.description ?? '' } });
  }
  await resetIdentity(tx, 'dept_roles');
  count('dept_roles', deptRoles.length);

  const partyRoles = seedInputs.partyRoles();
  for (const [i, p] of partyRoles.entries()) {
    await tx
      .insert(s.partyRoles)
      .values({ name: p.role_name, requiredFor: p.required_for ?? [], sortOrder: i })
      .onConflictDoUpdate({ target: s.partyRoles.name, set: { requiredFor: p.required_for ?? [], sortOrder: i } });
  }
  count('party_roles', partyRoles.length);

  const blockOptions = seedInputs.blockOptions() as unknown as Record<string, { code: string; name: string }[]>;
  const optionRows = Object.entries(blockOptions)
    .filter(([, values]) => Array.isArray(values))
    .flatMap(([groupKey, values]) => values.map((v, i) => ({ groupKey, code: v.code, name: v.name, sortOrder: i })));
  await tx
    .insert(s.blockOptionValues)
    .values(optionRows)
    .onConflictDoUpdate({
      target: [s.blockOptionValues.groupKey, s.blockOptionValues.code],
      set: { name: sql`excluded.name`, sortOrder: sql`excluded.sort_order` },
    });
  const optionCount = optionRows.length;
  count('block_option_values', optionCount);

  // Document requirements (general + plan rules)
  const typeIdByCode = new Map(
    (await tx.select({ id: s.applicationTypes.id, code: s.applicationTypes.code }).from(s.applicationTypes)).map((r) => [r.code, r.id]),
  );
  const docReqs = seedInputs.documentRequirements() as unknown as Record<string, unknown>;
  await tx.delete(s.documentRequirements);
  const docRows: (typeof s.documentRequirements.$inferInsert)[] = [];
  for (const [key, value] of Object.entries(docReqs)) {
    if (key === 'plans' || !Array.isArray(value)) continue;
    (value as { code: string; label: string; condition: string; optional?: boolean }[]).forEach((r, i) =>
      docRows.push({
        applicationTypeId: typeIdByCode.get(key) ?? null,
        scope: 'general',
        code: r.code,
        label: r.label,
        condition: r.condition,
        optional: !!r.optional,
        sortOrder: i,
      }),
    );
  }
  const plans = docReqs['plans'] as {
    applies_to: string[];
    block: { code: string; label: string }[];
    floor: { code: string; label: string };
  };
  plans.block.forEach((p, i) =>
    docRows.push({ applicationTypeId: null, scope: 'plan_block', code: p.code, label: p.label, condition: 'always', appliesTo: plans.applies_to, sortOrder: i }),
  );
  docRows.push({
    applicationTypeId: null,
    scope: 'plan_floor',
    code: plans.floor.code,
    label: plans.floor.label,
    condition: 'always',
    appliesTo: plans.applies_to,
    sortOrder: 0,
  });
  await tx.insert(s.documentRequirements).values(docRows);
  count('document_requirements', docRows.length);

  const occupancyConditions = seedInputs.occupancyConditions();
  for (const [i, c] of occupancyConditions.entries()) {
    await tx
      .insert(s.occupancyConditions)
      .values({ checklistNo: c.checklist_id, itemDesc: c.item_desc, sortOrder: i })
      .onConflictDoUpdate({ target: s.occupancyConditions.checklistNo, set: { itemDesc: c.item_desc, sortOrder: i } });
  }
  count('occupancy_conditions', occupancyConditions.length);

  const undertakings = seedInputs.undertakings();
  let undertakingCount = 0;
  for (const [typeCode, items] of Object.entries(undertakings)) {
    const typeId = typeIdByCode.get(typeCode);
    if (!typeId || !Array.isArray(items)) continue;
    for (const [i, u] of items.entries()) {
      await tx
        .insert(s.undertakings)
        .values({ applicationTypeId: typeId, code: u.id, text: u.text, required: !!u.required, sortOrder: i })
        .onConflictDoUpdate({
          target: [s.undertakings.applicationTypeId, s.undertakings.code],
          set: { text: u.text, required: !!u.required, sortOrder: i },
        });
      undertakingCount++;
    }
  }
  count('undertakings', undertakingCount);

  // ── Reference documents (verbatim legal content) ──────────────────────────
  const referenceDocs = [
    { key: 'noc_terms', title: 'NOC conditions', contentKind: 'html', payload: seedInputs.nocTerms(), source: 'modules/dept/partials/noc_terms*.html' },
    { key: 'nbc_table7', title: 'NBC Part 4 Table 7', contentKind: 'html', payload: seedInputs.nbcTable7(), source: 'modules/common/partials/table23.html' },
  ];
  for (const d of referenceDocs) {
    await tx
      .insert(s.referenceDocuments)
      .values(d as typeof s.referenceDocuments.$inferInsert)
      .onConflictDoUpdate({ target: s.referenceDocuments.key, set: { payload: d.payload as object, title: d.title, source: d.source } });
  }
  count('reference_documents', referenceDocs.length);

  // ── Notification templates (recovered from NOC-base/uploads/templates) ────
  const templates = [
    { key: 'submitted', channel: 'sms', body: 'Your application : <<appl_number>> is successfully submitted online. You can find the status of your application by logging into the Portal from time to time.', placeholders: ['appl_number'] },
    { key: 'assigned_to', channel: 'sms', body: 'Application : <<appl_number>> for <<site_name>> has been submitted.\n Please review, inspect and submit remarks.', placeholders: ['appl_number', 'site_name'] },
    { key: 'forwarded_to', channel: 'sms', body: 'Application: <<appl_number>> for <<site_name>> from <<build_name>> has been forwarded to you for review.\n Please take necessary action.', placeholders: ['appl_number', 'site_name', 'build_name'] },
    { key: 'final_status', channel: 'sms', body: 'Application: <<appl_number>> for <<site_name>> from <<build_name>> has been <<status_text>>.', placeholders: ['appl_number', 'site_name', 'build_name', 'status_text'] },
    { key: 'final_status_mail', channel: 'email', subject: 'NOC PORTAL - FIRE No Objection Certificate', body: 'Your File Number: <<appl_number>> for issuance of <<appl_type>> has been <<status_text>> on date: <<final_date>>. The copy of NOC is here with attached for download.', placeholders: ['appl_number', 'appl_type', 'status_text', 'final_date'] },
    { key: 'registered', channel: 'email', subject: 'NOC PORTAL - Set your password', body: 'Dear <<name>>, your NOC Portal account <<username>> has been created. Open this link within <<hours>> hours to choose your password: <<set_password_link>> . If you did not register, ignore this message.', placeholders: ['name', 'username', 'set_password_link', 'hours'] },
    { key: 'password_reset', channel: 'email', subject: 'NOC PORTAL - Reset your password', body: 'Dear <<name>>, a password reset was requested for your NOC Portal account. Open this link within one hour to choose a new password: <<reset_link>> . If you did not ask for this, ignore this message.', placeholders: ['name', 'reset_link'] },
    { key: 'document_requested', channel: 'sms', body: 'Application: <<appl_number>> — the Fire Department requests: <<file_desc>>. Please upload it from the portal.', placeholders: ['appl_number', 'file_desc'] },
    { key: 'dept_message', channel: 'sms', body: '<<message>>', placeholders: ['message'] },
    { key: 'escalation', channel: 'email', subject: 'NOC PORTAL - Overdue files', body: 'Dear <<name>>, the following files are past their service level:\n<<items>>', placeholders: ['name', 'items'] },
  ];
  for (const t of templates) {
    await tx
      .insert(s.notificationTemplates)
      .values(t as typeof s.notificationTemplates.$inferInsert)
      .onConflictDoUpdate({ target: s.notificationTemplates.key, set: { body: t.body, subject: t.subject ?? '', channel: t.channel } });
  }
  await tx.delete(s.notificationTemplates).where(notInArray(s.notificationTemplates.key, templates.map((t) => t.key)));
  count('notification_templates', templates.length);

  // ── Rule sets (rules engine) ──────────────────────────────────────────────
  const ruleSets: { code: string; kind: 'decision_tree' | 'decision_table' | 'parameters'; name: string; editable: boolean; definition: unknown }[] = [];
  for (const { id, tree } of seedInputs.ffeTrees()) {
    const equipment = equipments.find((e) => e.id === id);
    ruleSets.push({
      code: RULE_SETS.ffeEquipment(id),
      kind: 'decision_tree',
      name: `FFE — ${equipment?.desc ?? `equipment ${id}`}`,
      editable: false,
      definition: tree,
    });
  }
  ruleSets.push(
    { code: RULE_SETS.ffeType, kind: 'decision_tree', name: 'Fire extinguisher type', editable: false, definition: seedInputs.ffeType() },
    { code: RULE_SETS.ffeOtherNotes, kind: 'decision_tree', name: 'Block-level FFE notes', editable: false, definition: seedInputs.otherNotes() },
    { code: RULE_SETS.ffeRiserWidth, kind: 'decision_tree', name: 'Wet riser / down comer size', editable: false, definition: seedInputs.riserWidth() },
    { code: RULE_SETS.heightLimits, kind: 'decision_tree', name: 'Maximum permissible height', editable: false, definition: seedInputs.heightLimits() },
    { code: RULE_SETS.approvalLevel, kind: 'decision_table', name: 'Approval level (MSB / RFO / DFO)', editable: true, definition: delegationRulesToTable(seedInputs.delegationRules()) },
    { code: RULE_SETS.renewalPeriod, kind: 'decision_table', name: 'Renewal periodicity', editable: true, definition: renewalRulesToTable(seedInputs.renewalRules()) },
    { code: RULE_SETS.fees, kind: 'parameters', name: 'Fees and portal charges', editable: true, definition: feeConfigToParameters(seedInputs.feeConfig()) },
    { code: RULE_SETS.escapeLimits, kind: 'parameters', name: 'Means of escape limits', editable: true, definition: escapeRulesToParameters(seedInputs.escapeRules()) },
  );

  for (const rs of ruleSets) {
    const [set] = await tx
      .insert(s.reRuleSets)
      .values({ code: rs.code, kind: rs.kind, name: rs.name, editable: rs.editable })
      .onConflictDoUpdate({ target: s.reRuleSets.code, set: { name: rs.name, kind: rs.kind, editable: rs.editable } })
      .returning({ id: s.reRuleSets.id });

    const existing = await tx
      .select({ id: s.reRuleSetVersions.id, checksum: s.reRuleSetVersions.checksum, version: s.reRuleSetVersions.version })
      .from(s.reRuleSetVersions)
      .where(eq(s.reRuleSetVersions.ruleSetId, set.id))
      .orderBy(sql`version desc`)
      .limit(1);
    const sum = checksum(rs.definition);
    let versionId = existing[0]?.id;
    if (!existing.length) {
      const [v] = await tx
        .insert(s.reRuleSetVersions)
        .values({
          ruleSetId: set.id,
          version: 1,
          definition: rs.definition as object,
          checksum: sum,
          status: 'published',
          publishedAt: new Date(),
          notes: 'Seeded from the portal fixtures.',
        })
        .returning({ id: s.reRuleSetVersions.id });
      versionId = v.id;
    } else if (existing[0].checksum !== sum) {
      // The seed input changed: publish a new immutable version.
      const [v] = await tx
        .insert(s.reRuleSetVersions)
        .values({
          ruleSetId: set.id,
          version: existing[0].version + 1,
          definition: rs.definition as object,
          checksum: sum,
          status: 'published',
          publishedAt: new Date(),
          notes: 'Re-seeded: the seed input changed.',
        })
        .returning({ id: s.reRuleSetVersions.id });
      versionId = v.id;
    }
    await tx.update(s.reRuleSets).set({ currentVersionId: versionId }).where(eq(s.reRuleSets.id, set.id));
  }
  count('re_rule_sets', ruleSets.length);

  // ── Workflow configuration ────────────────────────────────────────────────
  const forms = seedInputs.forms();
  for (const f of forms) {
    await tx
      .insert(s.wfForms)
      .values({
        code: f.id,
        kind: f.kind,
        name: f.name,
        definition: (f.questions ? { questions: f.questions } : {}) as object,
        slaClass: f.inspection ? 'inspection' : null,
        isDecision: !!f.decision,
        legacy: f.legacy ?? '',
        summary: f.summary ?? '',
      })
      .onConflictDoUpdate({
        target: s.wfForms.code,
        set: {
          kind: f.kind,
          name: f.name,
          definition: (f.questions ? { questions: f.questions } : {}) as object,
          slaClass: f.inspection ? 'inspection' : null,
          isDecision: !!f.decision,
          legacy: f.legacy ?? '',
          summary: f.summary ?? '',
        },
      });
  }
  count('wf_forms', forms.length);

  const formIdByCode = new Map((await tx.select({ id: s.wfForms.id, code: s.wfForms.code }).from(s.wfForms)).map((r) => [r.code, r.id]));
  const sla = seedInputs.sla();
  const workflows = seedInputs.workflows();
  for (const w of workflows) {
    const [def] = await tx
      .insert(s.wfDefinitions)
      .values({ code: w.code, name: w.name, subjectType: 'noc_application' })
      .onConflictDoUpdate({ target: s.wfDefinitions.code, set: { name: w.name } })
      .returning({ id: s.wfDefinitions.id });

    const definition = { code: w.code, name: w.name, subjectType: 'noc_application', stages: w.stages };
    const sum = checksum(definition);
    const existing = await tx
      .select({ id: s.wfDefinitionVersions.id, checksum: s.wfDefinitionVersions.checksum, version: s.wfDefinitionVersions.version })
      .from(s.wfDefinitionVersions)
      .where(eq(s.wfDefinitionVersions.definitionId, def.id))
      .orderBy(sql`version desc`)
      .limit(1);
    let versionId = existing[0]?.id;
    if (!existing.length || existing[0].checksum !== sum) {
      const [v] = await tx
        .insert(s.wfDefinitionVersions)
        .values({
          definitionId: def.id,
          version: existing.length ? existing[0].version + 1 : w.version ?? 1,
          definition,
          checksum: sum,
          notes: 'Seeded from the portal fixtures.',
        })
        .returning({ id: s.wfDefinitionVersions.id });
      versionId = v.id;
      for (const roleId of new Set(w.stages.flatMap((st) => st.tasks.map((t) => Number(t.role_id))))) {
        await tx.insert(s.wfVersionRoles).values({ versionId, roleId }).onConflictDoNothing();
      }
      for (const formCode of new Set(w.stages.flatMap((st) => st.tasks.map((t) => t.form)))) {
        const formId = formIdByCode.get(formCode);
        if (formId) await tx.insert(s.wfVersionForms).values({ versionId, formId }).onConflictDoNothing();
      }
    }
    await tx.update(s.wfDefinitions).set({ currentVersionId: versionId }).where(eq(s.wfDefinitions.id, def.id));

    const policy = sla.workflows[w.code];
    if (policy) {
      await tx
        .insert(s.wfSlaPolicies)
        .values({
          definitionId: def.id,
          totalDays: policy.processing_days,
          classDays: { inspection: policy.inspection_days },
          taskDays: policy.step_days ?? {},
        })
        .onConflictDoUpdate({
          target: s.wfSlaPolicies.definitionId,
          set: { totalDays: policy.processing_days, classDays: { inspection: policy.inspection_days }, taskDays: policy.step_days ?? {} },
        });
    }

    const typeId = typeIdByCode.get(w.appl_type);
    if (typeId) {
      await tx
        .insert(s.nocWorkflowBindings)
        .values({ applicationTypeId: typeId, level: w.level, definitionId: def.id })
        .onConflictDoUpdate({ target: [s.nocWorkflowBindings.applicationTypeId, s.nocWorkflowBindings.level], set: { definitionId: def.id } });
    }
  }
  count('wf_definitions', workflows.length);

  await tx
    .insert(s.wfEscalationSettings)
    .values({
      id: 1,
      notifyAssignee: sla.escalation.notify_officer,
      notifyDecider: sla.escalation.notify_approver,
      remindEveryDays: sla.escalation.remind_every_days,
    })
    .onConflictDoUpdate({
      target: s.wfEscalationSettings.id,
      set: {
        notifyAssignee: sla.escalation.notify_officer,
        notifyDecider: sla.escalation.notify_approver,
        remindEveryDays: sla.escalation.remind_every_days,
      },
    });

  for (const c of corrections.fireStations.drop) {
    notes.push(`fire station "${c.legacyId}" (${c.name}) dropped — ${c.reason}${c.applied ? ` [${c.applied}]` : ''}`);
  }
  return { counts, notes };
}
