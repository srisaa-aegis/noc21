/**
 * Structural validation of rule definitions. Returns problems; it never throws.
 * Errors block publication, warnings do not.
 */
import type {
  DecisionTableDefinition,
  DecisionTreeDefinition,
  ParameterSetDefinition,
  Problem,
  RuleDefinition,
  RuleKind,
  TableOperator,
  TreeNode,
  TreeOperator,
} from './types.js';

const TREE_OPERATORS: TreeOperator[] = ['EQ', 'DEF', 'GT', 'GE', 'LT', 'LE', 'BR', 'BL'];
const TABLE_OPERATORS: TableOperator[] = [
  'any',
  'eq',
  'ne',
  'in',
  'notIn',
  'gt',
  'ge',
  'lt',
  'le',
  'between',
  'isTrue',
  'isFalse',
];
const FORBIDDEN_FACTS = ['__proto__', 'constructor', 'prototype'];

export function validateDecisionTree(def: DecisionTreeDefinition): Problem[] {
  const out: Problem[] = [];
  if (!def || typeof def !== 'object') return [{ path: '', message: 'The definition must be an object.', severity: 'error' }];
  if (!def.start || typeof def.start !== 'string') {
    out.push({ path: 'start', message: 'A "start" node name is required.', severity: 'error' });
  }
  const nodeNames = Object.keys(def).filter((k) => k !== 'start');
  const nodes = new Map<string, TreeNode>();
  for (const name of nodeNames) {
    const node = def[name];
    if (!node || typeof node !== 'object' || !Array.isArray((node as TreeNode).decisions)) {
      out.push({ path: name, message: 'A node needs a "decisions" array.', severity: 'error' });
      continue;
    }
    nodes.set(name, node as TreeNode);
  }
  if (def.start && !nodes.has(def.start)) {
    out.push({ path: 'start', message: `The start node "${def.start}" does not exist.`, severity: 'error' });
  }
  for (const [name, node] of nodes) {
    if (!node.check) out.push({ path: name, message: 'A node needs a "check" (fact name).', severity: 'error' });
    if (FORBIDDEN_FACTS.includes(node.check?.replace(/^@/, ''))) {
      out.push({ path: name, message: `"${node.check}" is not an allowed fact name.`, severity: 'error' });
    }
    if (!node.decisions.length) out.push({ path: name, message: 'A node needs at least one decision.', severity: 'error' });
    node.decisions.forEach((d, i) => {
      const at = `${name}.decisions[${i}]`;
      if (!TREE_OPERATORS.includes(d.oper)) out.push({ path: at, message: `Unknown operator "${d.oper}".`, severity: 'error' });
      if ((d.oper === 'BR' || d.oper === 'BL') && (d.check2 === undefined || d.check2 === null || d.check2 === '')) {
        out.push({ path: at, message: `Operator ${d.oper} needs "check2".`, severity: 'error' });
      }
      if (d.action !== 'goto' && d.action !== 'return') {
        out.push({ path: at, message: 'Action must be "goto" or "return".', severity: 'error' });
      }
      if (d.action === 'goto' && !nodes.has(d.value)) {
        // Dangling gotos exist in the shipped legacy trees and mean "no requirement".
        out.push({ path: at, message: `"goto ${d.value}" points at a node that does not exist; it evaluates to "".`, severity: 'warning' });
      }
    });
    if (!node.decisions.some((d) => d.oper === 'DEF')) {
      out.push({ path: name, message: 'No default (DEF) decision; unmatched facts evaluate to "".', severity: 'warning' });
    }
  }
  // reachability + cycles
  if (def.start && nodes.has(def.start)) {
    const seen = new Set<string>();
    const stack = [def.start];
    while (stack.length) {
      const n = stack.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const d of nodes.get(n)?.decisions ?? []) {
        if (d.action === 'goto' && nodes.has(d.value)) stack.push(d.value);
      }
    }
    for (const name of nodes.keys()) {
      if (!seen.has(name)) out.push({ path: name, message: 'Node is unreachable from "start".', severity: 'warning' });
    }
    const cycle = findCycle(def.start, nodes);
    if (cycle) out.push({ path: cycle.join(' → '), message: 'The tree contains a cycle.', severity: 'error' });
  }
  return out;
}

function findCycle(start: string, nodes: Map<string, TreeNode>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 1) return [...path, n];
    if (state.get(n) === 2) return null;
    state.set(n, 1);
    path.push(n);
    for (const d of nodes.get(n)?.decisions ?? []) {
      if (d.action === 'goto' && nodes.has(d.value)) {
        const c = visit(d.value);
        if (c) return c;
      }
    }
    path.pop();
    state.set(n, 2);
    return null;
  };
  return visit(start);
}

export function validateDecisionTable(def: DecisionTableDefinition): Problem[] {
  const out: Problem[] = [];
  if (!def || typeof def !== 'object') return [{ path: '', message: 'The definition must be an object.', severity: 'error' }];
  if (!['FIRST', 'PRIORITY', 'COLLECT'].includes(def.hitPolicy)) {
    out.push({ path: 'hitPolicy', message: 'Hit policy must be FIRST, PRIORITY or COLLECT.', severity: 'error' });
  }
  if (!Array.isArray(def.rows) || def.rows.length === 0) {
    out.push({ path: 'rows', message: 'Add at least one rule row.', severity: 'error' });
    return out;
  }
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  def.rows.forEach((row, i) => {
    const at = `rows[${i}]`;
    if (row.id === undefined || row.id === null || row.id === '') out.push({ path: at, message: 'A row needs an id.', severity: 'error' });
    else if (ids.has(String(row.id))) out.push({ path: at, message: `Duplicate row id "${row.id}".`, severity: 'error' });
    ids.add(String(row.id));
    if (typeof row.ordinal !== 'number') out.push({ path: at, message: 'A row needs a numeric ordinal.', severity: 'error' });
    else if (ordinals.has(row.ordinal)) out.push({ path: at, message: `Duplicate ordinal ${row.ordinal}.`, severity: 'warning' });
    ordinals.add(row.ordinal);
    if (!row.then || typeof row.then !== 'object' || Object.keys(row.then).length === 0) {
      out.push({ path: at, message: 'A row needs an output ("then").', severity: 'error' });
    }
    (row.when ?? []).forEach((c, j) => {
      const cat = `${at}.when[${j}]`;
      if (!c.fact) out.push({ path: cat, message: 'A condition needs a fact name.', severity: 'error' });
      if (FORBIDDEN_FACTS.includes(c.fact)) out.push({ path: cat, message: `"${c.fact}" is not an allowed fact name.`, severity: 'error' });
      if (!TABLE_OPERATORS.includes(c.op)) out.push({ path: cat, message: `Unknown operator "${c.op}".`, severity: 'error' });
      if (['in', 'notIn'].includes(c.op) && !Array.isArray(c.value)) {
        out.push({ path: cat, message: `Operator ${c.op} needs an array value.`, severity: 'error' });
      }
      if (c.op === 'between' && (!Array.isArray(c.value) || c.value.length !== 2)) {
        out.push({ path: cat, message: 'Operator between needs [min, max].', severity: 'error' });
      }
    });
  });
  const last = def.rows.slice().sort((a, b) => a.ordinal - b.ordinal).at(-1);
  if (def.hitPolicy === 'FIRST' && !def.default && last && last.when.length > 0) {
    out.push({ path: 'default', message: 'No catch-all row and no default: some facts may produce no result.', severity: 'warning' });
  }
  if (def.aggregation) {
    if (!def.aggregation.output) out.push({ path: 'aggregation.output', message: 'Name the aggregated output key.', severity: 'error' });
    if (def.aggregation.mode === 'MAX_RANK' && !(def.aggregation.order ?? []).length) {
      out.push({ path: 'aggregation.order', message: 'MAX_RANK needs an "order" list.', severity: 'error' });
    }
  }
  return out;
}

export function validateParameters(def: ParameterSetDefinition): Problem[] {
  if (!def || typeof def !== 'object' || typeof def.values !== 'object' || def.values === null) {
    return [{ path: 'values', message: 'A parameter set needs a "values" object.', severity: 'error' }];
  }
  const out: Problem[] = [];
  for (const key of Object.keys(def.values)) {
    if (FORBIDDEN_FACTS.includes(key)) out.push({ path: `values.${key}`, message: 'Reserved key name.', severity: 'error' });
  }
  return out;
}

export function validateDefinition(kind: RuleKind, definition: RuleDefinition): Problem[] {
  switch (kind) {
    case 'decision_tree':
      return validateDecisionTree(definition as DecisionTreeDefinition);
    case 'decision_table':
      return validateDecisionTable(definition as DecisionTableDefinition);
    case 'parameters':
      return validateParameters(definition as ParameterSetDefinition);
    default:
      return [{ path: '', message: `Unknown rule kind "${kind}".`, severity: 'error' }];
  }
}

export const errorsOf = (problems: Problem[]): Problem[] => problems.filter((p) => p.severity === 'error');
