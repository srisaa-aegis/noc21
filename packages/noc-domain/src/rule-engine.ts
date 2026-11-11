/**
 * Thin adapter over @srisaa/rules-engine for the legacy decision-tree call
 * sites in this package (FFE and the height-limit validation).
 *
 * The tree format and the evaluation semantics live in the generic engine;
 * this file only preserves the local signature so the ported NOC code stays
 * identical to the version that runs in the browser today.
 */
import { evaluateTree } from '@srisaa/rules-engine';
import type { DecisionTreeDefinition, Facts } from '@srisaa/rules-engine';
import type { RuleTree } from './models/index.js';

export type RuleVars = Facts;

export interface RuleResult {
  value: string;
  path: string[];
}

export function evaluateRule(tree: RuleTree, vars: RuleVars): RuleResult {
  const r = evaluateTree(tree as unknown as DecisionTreeDefinition, vars);
  return { value: r.value, path: r.path };
}
