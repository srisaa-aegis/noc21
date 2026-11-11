/**
 * Decision-table evaluation: ordered rows of conditions → outputs, with a hit
 * policy, an optional default, and an optional aggregation across a collection
 * of fact sets (e.g. "the highest approval level of all blocks").
 */
import type {
  DecisionTableDefinition,
  Facts,
  FactValue,
  TableCondition,
  TableRow,
  TraceStep,
} from './types.js';

function num(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sameText(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function list(v: unknown): FactValue[] {
  return Array.isArray(v) ? (v as FactValue[]) : v === undefined || v === null ? [] : [v as FactValue];
}

export function conditionMatches(c: TableCondition, facts: Facts): boolean {
  const raw = facts[c.fact];
  switch (c.op) {
    case 'any':
      return true;
    case 'isTrue':
      return raw === true || raw === 1 || sameText(raw, 'y') || sameText(raw, 'true');
    case 'isFalse':
      return !(raw === true || raw === 1 || sameText(raw, 'y') || sameText(raw, 'true'));
    case 'eq':
    case 'ne': {
      const a = num(raw);
      const b = num(c.value as FactValue);
      const equal = a !== null && b !== null ? a === b : sameText(raw, c.value as FactValue);
      return c.op === 'eq' ? equal : !equal;
    }
    case 'in':
    case 'notIn': {
      const values = list(c.value);
      // An empty list means "no restriction" (the legacy rule tables use [] for "any").
      if (values.length === 0) return c.op === 'in';
      const hit = values.some((v) => {
        const a = num(raw);
        const b = num(v);
        return a !== null && b !== null ? a === b : sameText(raw, v);
      });
      return c.op === 'in' ? hit : !hit;
    }
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      const v = num(raw);
      const b = num(c.value as FactValue);
      if (v === null || b === null) return false;
      if (c.op === 'gt') return v > b;
      if (c.op === 'ge') return v >= b;
      if (c.op === 'lt') return v < b;
      return v <= b;
    }
    case 'between': {
      const v = num(raw);
      const bounds = list(c.value);
      const lo = num(bounds[0] ?? null);
      const hi = num(bounds[1] ?? null);
      if (v === null) return false;
      const lowerOk = lo === null ? true : c.inclusive === false ? v > lo : v >= lo;
      const upperOk = hi === null ? true : c.inclusiveUpper === true ? v <= hi : v < hi;
      return lowerOk && upperOk;
    }
    default:
      return false;
  }
}

export function rowMatches(row: TableRow, facts: Facts): boolean {
  return row.when.every((c) => conditionMatches(c, facts));
}

export interface TableEvaluation {
  value: Record<string, unknown> | Record<string, unknown>[] | undefined;
  matchedRowIds: (string | number)[];
  trace?: TraceStep[];
}

function activeRows(def: DecisionTableDefinition): TableRow[] {
  return def.rows.filter((r) => r.active !== false).slice().sort((a, b) => a.ordinal - b.ordinal);
}

export function evaluateTable(def: DecisionTableDefinition, facts: Facts, withTrace = false): TableEvaluation {
  const trace: TraceStep[] | undefined = withTrace ? [] : undefined;
  const rows = activeRows(def);
  const hits: TableRow[] = [];
  for (const row of rows) {
    const matched = rowMatches(row, facts);
    trace?.push({
      at: `row ${row.id}${row.label ? ` (${row.label})` : ''}`,
      outcome: matched ? 'matched' : 'no match',
    });
    if (matched) {
      hits.push(row);
      if (def.hitPolicy === 'FIRST') break;
    }
  }
  if (hits.length === 0) {
    trace?.push({ at: 'default', outcome: def.default ? 'default used' : 'no result' });
    return { value: def.default, matchedRowIds: [], trace };
  }
  if (def.hitPolicy === 'COLLECT') {
    return { value: hits.map((h) => h.then), matchedRowIds: hits.map((h) => h.id), trace };
  }
  const winner =
    def.hitPolicy === 'PRIORITY'
      ? hits.reduce((best, r) => ((r.priority ?? 0) > (best.priority ?? 0) ? r : best), hits[0])
      : hits[0];
  return { value: winner.then, matchedRowIds: [winner.id], trace };
}

export interface TableCollectionEvaluation {
  /** Aggregated output object. */
  value: Record<string, unknown> | undefined;
  /** Per-item results, in input order. */
  perItem: (Record<string, unknown> | undefined)[];
  matchedRowIds: (string | number)[][];
  trace?: TraceStep[];
}

/**
 * Evaluates the table for every fact set and aggregates one output key
 * (`aggregation.output`) across the items — the "highest level of all blocks",
 * "shortest renewal period of all blocks" pattern.
 */
export function evaluateTableCollection(
  def: DecisionTableDefinition,
  factsList: Facts[],
  withTrace = false,
): TableCollectionEvaluation {
  const perItem: (Record<string, unknown> | undefined)[] = [];
  const matchedRowIds: (string | number)[][] = [];
  const trace: TraceStep[] | undefined = withTrace ? [] : undefined;
  for (let i = 0; i < factsList.length; i++) {
    const r = evaluateTable(def, factsList[i], withTrace);
    perItem.push(r.value as Record<string, unknown> | undefined);
    matchedRowIds.push(r.matchedRowIds);
    if (trace && r.trace) trace.push(...r.trace.map((t) => ({ ...t, at: `item ${i} · ${t.at}` })));
  }
  const agg = def.aggregation;
  if (!agg) {
    return { value: perItem[0], perItem, matchedRowIds, trace };
  }
  const values = perItem.map((v) => (v ? v[agg.output] : undefined)).filter((v) => v !== undefined);
  if (values.length === 0) {
    const fallback = def.default ? def.default[agg.output] : undefined;
    return { value: fallback === undefined ? undefined : { [agg.output]: fallback }, perItem, matchedRowIds, trace };
  }
  let result: unknown;
  switch (agg.mode) {
    case 'MAX_RANK': {
      const order = agg.order ?? [];
      result = values.reduce((best, v) => (order.indexOf(v as string) > order.indexOf(best as string) ? v : best), values[0]);
      break;
    }
    case 'MIN':
      result = values.reduce((m, v) => (Number(v) < Number(m) ? v : m), values[0]);
      break;
    case 'MAX':
      result = values.reduce((m, v) => (Number(v) > Number(m) ? v : m), values[0]);
      break;
    case 'SUM':
      result = values.reduce((s: number, v) => s + Number(v), 0);
      break;
    case 'LIST':
      result = values;
      break;
    case 'FIRST':
    default:
      result = values[0];
  }
  trace?.push({ at: `aggregate ${agg.mode}(${agg.output})`, outcome: String(result) });
  return { value: { [agg.output]: result }, perItem, matchedRowIds, trace };
}
