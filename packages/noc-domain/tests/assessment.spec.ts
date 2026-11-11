/**
 * The engine-backed assessment must produce exactly what the legacy
 * array-driven helpers produce, for every seeded application.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RuleEngine } from '@srisaa/rules-engine';
import { InMemoryRuleSetSource } from '@srisaa/rules-engine/testing';
import { assess, loadRuleSets } from '../src/assessment.js';
import { computeDelegationLevel, computeFee, renewalPeriodYears } from '../src/application-rules.js';
import { computeBlockFfe } from '../src/ffe.js';
import { declarationLevel } from '../src/workflow-view.js';
import {
  RULE_SETS,
  delegationRulesToTable,
  escapeRulesToParameters,
  feeConfigToParameters,
  renewalRulesToTable,
  tableToDelegationRules,
  tableToRenewalRules,
} from '../src/rule-sets.js';
import { validateApplication } from '../src/validation.js';
import { fixture } from './fixtures.js';
import type {
  Application,
  ApplicationType,
  BuildType,
  DelegationRule,
  DocumentRequirements,
  Equipment,
  EscapeRules,
  FeeConfig,
  PartyRole,
  RenewalRule,
  RuleTree,
} from '../src/models/index.js';

const feeConfig = fixture<FeeConfig>('assets/data/config/fee-config.json');
const delegationRules = fixture<DelegationRule[]>('assets/data/config/delegation-rules.json');
const renewalRules = fixture<RenewalRule[]>('assets/data/config/renewal-rules.json');
const escapeRules = fixture<EscapeRules>('assets/data/lookups/escape-rules.json');
const equipments = fixture<Equipment[]>('assets/data/lookups/equipments.json');
const applications = fixture<Application[]>('assets/data/applications/applications.json');

const lookups = {
  applicationTypes: fixture<ApplicationType[]>('assets/data/lookups/application-types.json'),
  buildTypes: fixture<BuildType[]>('assets/data/lookups/build-types.json'),
  partyRoles: fixture<PartyRole[]>('assets/data/lookups/party-roles.json'),
  documentRequirements: fixture<DocumentRequirements>('assets/data/lookups/document-requirements.json'),
  equipments,
};

function buildEngine(): RuleEngine {
  const source = new InMemoryRuleSetSource();
  const rulesDir = join(import.meta.dirname, '..', '..', '..', 'backend', 'seed', 'data', 'rules');
  for (const f of readdirSync(join(rulesDir, 'ffe'))) {
    const id = Number(f.replace('.json', ''));
    source.add(RULE_SETS.ffeEquipment(id), 'decision_tree', fixture<RuleTree>(`assets/data/rules/ffe/${f}`) as never);
  }
  source.add(RULE_SETS.ffeType, 'decision_tree', fixture<RuleTree>('assets/data/rules/ffe-type.json') as never);
  source.add(RULE_SETS.ffeOtherNotes, 'decision_tree', fixture<RuleTree>('assets/data/rules/other-notes.json') as never);
  source.add(RULE_SETS.ffeRiserWidth, 'decision_tree', fixture<RuleTree>('assets/data/rules/riser-width.json') as never);
  source.add(RULE_SETS.heightLimits, 'decision_tree', fixture<RuleTree>('assets/data/rules/height-limits.json') as never);
  source.add(RULE_SETS.approvalLevel, 'decision_table', delegationRulesToTable(delegationRules));
  source.add(RULE_SETS.renewalPeriod, 'decision_table', renewalRulesToTable(renewalRules));
  source.add(RULE_SETS.fees, 'parameters', feeConfigToParameters(feeConfig));
  source.add(RULE_SETS.escapeLimits, 'parameters', escapeRulesToParameters(escapeRules));
  return new RuleEngine(source);
}

const engine = buildEngine();
const now = new Date(2016, 7, 1);

describe('rule-set converters', () => {
  it('round-trips the approval-level rules without loss', () => {
    expect(tableToDelegationRules(delegationRulesToTable(delegationRules))).toEqual(delegationRules);
  });

  it('round-trips the renewal rules without loss', () => {
    expect(tableToRenewalRules(renewalRulesToTable(renewalRules))).toEqual(renewalRules);
  });

  it('loads every NOC rule set out of the engine', () => {
    const sets = loadRuleSets(engine);
    expect(Object.keys(sets.ffeRules.equipment).length).toBe(12);
    const { _source: _ignored, ...fees } = feeConfig as FeeConfig & { _source?: string };
    expect(sets.feeConfig).toEqual(fees);
    expect(sets.delegationRules).toEqual(delegationRules);
    expect(sets.renewalRules).toEqual(renewalRules);
    expect(Object.keys(sets.versions).length).toBeGreaterThan(15);
  });
});

describe('assess', () => {
  for (const seed of applications) {
    it(`matches the legacy calculation for application ${seed.appl_id} (${seed.appl_type})`, () => {
      const app = JSON.parse(JSON.stringify(seed)) as Application;
      const result = assess(app, engine, lookups, now);

      expect(result.fee).toEqual(computeFee(seed, feeConfig, now));
      expect(result.approvalLevel).toEqual(seed.appl_type === 'D' ? declarationLevel(seed) : computeDelegationLevel(seed, delegationRules));
      expect(result.renewalYears).toEqual(renewalPeriodYears(seed, renewalRules));

      const legacyIssues = validateApplication(JSON.parse(JSON.stringify(seed)), {
        ...lookups,
        escapeRules,
        heightLimits: fixture<RuleTree>('assets/data/rules/height-limits.json'),
        feeConfig,
        now,
      });
      expect(result.issues).toEqual(legacyIssues);
      expect(result.ruleVersions[RULE_SETS.fees]).toBeGreaterThan(0);
    });
  }

  it('recomputes the FFE grid of every block in place', () => {
    const seed = applications.find((a) => a.blocks.length > 0 && a.appl_type === 'P') as Application;
    const app = JSON.parse(JSON.stringify(seed)) as Application;
    app.blocks[0].ffe = { items: [], notes: [], agree_reqt: false };
    assess(app, engine, lookups, now);
    const expected = computeBlockFfe(
      app.blocks[0],
      Number(app.plot_area) || 0,
      Number(app.perimeter) || 0,
      loadRuleSets(engine).ffeRules,
      equipments,
      { items: [], notes: [], agree_reqt: false },
    );
    expect(app.blocks[0].ffe.items.length).toBe(expected.items.length);
    expect(app.blocks[0].ffe.items.length).toBeGreaterThan(0);
  });

  it('derives the approval level before validating, so level-dependent documents are required (regression)', () => {
    // A draft saved without a stored level: the Head Office documents ("not_dfo")
    // must still be demanded — the server once accepted a submission without them.
    const seed = applications.find((a) => a.appl_type === 'P' && a.delegation_level === 'MSB') as Application;
    const app = JSON.parse(JSON.stringify(seed)) as Application;
    app.delegation_level = 'DFO';
    app.documents = app.documents.filter((d) => d.code !== 'Undertaking');
    const r = assess(app, engine, lookups, now);
    expect(app.delegation_level).toBe('MSB');
    expect(r.issues.some((i) => i.field === 'doc.Undertaking')).toBe(true);
  });

  it('leaves the seeded applications free of validation errors where they are submitted', () => {
    // 103 is the deliberately deficient seed (insufficient open spaces) that the
    // department rejected; every other submitted application must be clean.
    for (const seed of applications.filter((a) => a.status_id > 1 && a.appl_id !== 103)) {
      const app = JSON.parse(JSON.stringify(seed)) as Application;
      const r = assess(app, engine, lookups, now);
      expect({ id: seed.appl_id, errors: r.errorCount }).toEqual({ id: seed.appl_id, errors: 0 });
    }
  });

  it('reports exactly the open-space shortfalls of the rejected seed (103)', () => {
    const app = JSON.parse(JSON.stringify(applications.find((a) => a.appl_id === 103))) as Application;
    const r = assess(app, engine, lookups, now);
    expect(r.issues.filter((i) => i.severity === 'error').map((i) => i.field)).toEqual([
      'blocks.0.ospaces.0.proposed',
      'blocks.0.ospaces.1.proposed',
      'blocks.0.ospaces.2.proposed',
      'blocks.0.ospaces.3.proposed',
    ]);
  });
});
