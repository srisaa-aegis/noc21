/**
 * Decision-tree evaluation — behaviourally identical to the legacy ASP.NET
 * interpreter of `uploads/rules/*.rule` (and to the AngularJS/Angular port it
 * replaces), so the shipped trees can be used verbatim.
 *
 * Operator semantics (as the rule files combine them):
 *   DEF  always matches (default branch)
 *   EQ   numeric equality when both sides are numeric, else case-insensitive string equality
 *   GT / GE / LT / LE   numeric comparisons
 *   BR   check <  v <= check2
 *   BL   check <= v <  check2
 * A `goto` to a node that does not exist yields "" (= no requirement), which is
 * what the legacy engine did (e.g. the dangling "c2c3" target in 1.rule).
 */
import type { DecisionTreeDefinition, Facts, FactValue, TraceStep, TreeDecision, TreeNode } from './types.js';

const MAX_STEPS = 500;

function toNumber(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function decisionMatches(d: TreeDecision, raw: unknown): boolean {
  if (d.oper === 'DEF') return true;
  if (d.oper === 'EQ') {
    const a = toNumber(raw);
    const b = toNumber(d.check);
    if (a !== null && b !== null) return a === b;
    return String(raw ?? '').trim().toLowerCase() === String(d.check ?? '').trim().toLowerCase();
  }
  const v = toNumber(raw);
  const c = toNumber(d.check);
  if (v === null || c === null) return false;
  switch (d.oper) {
    case 'GT':
      return v > c;
    case 'GE':
      return v >= c;
    case 'LT':
      return v < c;
    case 'LE':
      return v <= c;
    case 'BR': {
      const c2 = toNumber(d.check2);
      return c2 !== null && v > c && v <= c2;
    }
    case 'BL': {
      const c2 = toNumber(d.check2);
      return c2 !== null && v >= c && v < c2;
    }
    default:
      return false;
  }
}

export function factName(check: string): string {
  return check.startsWith('@') ? check.slice(1) : check;
}

export interface TreeEvaluation {
  value: string;
  /** Node names visited, in order. */
  path: string[];
  trace?: TraceStep[];
}

export function evaluateTree(tree: DecisionTreeDefinition, facts: Facts, withTrace = false): TreeEvaluation {
  const path: string[] = [];
  const trace: TraceStep[] | undefined = withTrace ? [] : undefined;
  let nodeName = tree.start;
  for (let step = 0; step < MAX_STEPS; step++) {
    const node = tree[nodeName] as TreeNode | string | undefined;
    if (!node || typeof node === 'string') {
      trace?.push({ at: nodeName, outcome: 'missing node → ""' });
      return { value: '', path, trace };
    }
    path.push(nodeName);
    const name = factName(node.check);
    const raw = facts[name] as FactValue;
    const decision = node.decisions.find((d) => decisionMatches(d, raw));
    if (!decision) {
      trace?.push({ at: nodeName, input: { [name]: raw }, outcome: 'no decision matched → ""' });
      return { value: '', path, trace };
    }
    trace?.push({
      at: nodeName,
      input: { [name]: raw },
      outcome: `${decision.oper} ${decision.check}${decision.check2 ? `..${decision.check2}` : ''} → ${decision.action} ${decision.value}`,
    });
    if (decision.action === 'return') {
      return { value: decision.value ?? '', path, trace };
    }
    nodeName = decision.value;
  }
  throw new Error(`Rule evaluation exceeded ${MAX_STEPS} steps (cycle at "${nodeName}")`);
}
