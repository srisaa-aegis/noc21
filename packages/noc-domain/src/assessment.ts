/**
 * The one server-side entry point for "what does the portal compute about this
 * application": the FFE grid of every block, the fee, the approval level, the
 * renewal period and the submission issues — all evaluated through the rules
 * engine, so every result carries the rule-set versions that produced it.
 *
 * The browser runs exactly the same code for live feedback; the server's result
 * is the one that is stored (see docs/backend/45-engines.md §45.2).
 */
import type { RuleEngine } from '@srisaa/rules-engine';
import { computeFee, computeDelegationLevel, renewalPeriodYears, totalBuiltUpArea, maxHeight } from './application-rules.js';
import { computeBlockFfe } from './ffe.js';
import { declarationLevel } from './workflow-view.js';
import type { FeeBreakdown } from './application-rules.js';
import type {
  Application,
  ApplicationType,
  BuildType,
  DelegationLevel,
  DocumentRequirements,
  Equipment,
  EscapeRules,
  FeeConfig,
  FfeRuleSet,
  PartyRole,
  RuleTree,
} from './models/index.js';
import {
  RULE_SETS,
  parametersToEscapeRules,
  parametersToFeeConfig,
  tableToDelegationRules,
  tableToRenewalRules,
} from './rule-sets.js';
import { validateApplication, type ValidationIssue } from './validation.js';

/** Static lookups the assessment needs, on top of the rule sets. */
export interface AssessmentLookups {
  applicationTypes: ApplicationType[];
  buildTypes: BuildType[];
  partyRoles: PartyRole[];
  documentRequirements: DocumentRequirements;
  equipments: Equipment[];
}

export interface Assessment {
  fee: FeeBreakdown;
  approvalLevel: DelegationLevel;
  renewalYears: number;
  builtUpArea: number;
  maxHeight: number;
  issues: ValidationIssue[];
  errorCount: number;
  ruleVersions: Record<string, number>;
  assessedAt: string;
}

/** Pulls the NOC rule sets out of the engine in the shapes the ported code expects. */
export function loadRuleSets(engine: RuleEngine): {
  feeConfig: FeeConfig;
  escapeRules: EscapeRules;
  heightLimits: RuleTree;
  ffeRules: FfeRuleSet;
  delegationRules: ReturnType<typeof tableToDelegationRules>;
  renewalRules: ReturnType<typeof tableToRenewalRules>;
  versions: Record<string, number>;
} {
  const versions: Record<string, number> = {};
  const def = <T>(code: string): T => {
    const set = engine.get(code);
    versions[code] = set.versionId;
    return set.definition as unknown as T;
  };
  const equipment: Record<number, RuleTree> = {};
  for (let id = 1; id <= 12; id++) {
    const code = RULE_SETS.ffeEquipment(id);
    if (engine.has(code)) equipment[id] = def<RuleTree>(code);
  }
  return {
    feeConfig: parametersToFeeConfig(def(RULE_SETS.fees)),
    escapeRules: parametersToEscapeRules(def(RULE_SETS.escapeLimits)),
    heightLimits: def<RuleTree>(RULE_SETS.heightLimits),
    ffeRules: {
      equipment,
      ffeType: def<RuleTree>(RULE_SETS.ffeType),
      otherNotes: def<RuleTree>(RULE_SETS.ffeOtherNotes),
      riserWidth: def<RuleTree>(RULE_SETS.ffeRiserWidth),
    },
    delegationRules: tableToDelegationRules(def(RULE_SETS.approvalLevel)),
    renewalRules: tableToRenewalRules(def(RULE_SETS.renewalPeriod)),
    versions,
  };
}

/**
 * Recomputes every derived value of an application **in place** (the FFE grid
 * of each block and the approval level) and returns the assessment. Callers persist both.
 */
export function assess(
  app: Application,
  engine: RuleEngine,
  lookups: AssessmentLookups,
  now: Date = new Date(),
): Assessment {
  const rules = loadRuleSets(engine);

  // 1. FFE grid per block (the authoritative "required" column).
  for (const block of app.blocks) {
    block.ffe = computeBlockFfe(block, Number(app.plot_area) || 0, Number(app.perimeter) || 0, rules.ffeRules, lookups.equipments, block.ffe);
  }

  // 2. Fee, approval level, renewal period.
  const fee = computeFee(app, rules.feeConfig, now);
  // A Declaration follows the level of the Occupancy NOC it renews (refined at submission from the parent).
  const approvalLevel = app.appl_type === 'D' ? declarationLevel(app) : computeDelegationLevel(app, rules.delegationRules);
  const renewalYears = renewalPeriodYears(app, rules.renewalRules);
  // Derived in place like the FFE grid: validation depends on it (documents with
  // the condition "not_dfo" — undertaking, bank guarantee, FFE estimate).
  app.delegation_level = approvalLevel;

  // 3. Submission validation (the same messages the wizard shows).
  const issues = validateApplication(app, {
    applicationTypes: lookups.applicationTypes,
    buildTypes: lookups.buildTypes,
    partyRoles: lookups.partyRoles,
    documentRequirements: lookups.documentRequirements,
    escapeRules: rules.escapeRules,
    heightLimits: rules.heightLimits,
    feeConfig: rules.feeConfig,
    equipments: lookups.equipments,
    now,
  });

  return {
    fee,
    approvalLevel,
    renewalYears,
    builtUpArea: totalBuiltUpArea(app),
    maxHeight: maxHeight(app),
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    ruleVersions: rules.versions,
    assessedAt: now.toISOString(),
  };
}
