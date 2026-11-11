/**
 * @srisaa/rules-engine — public types.
 *
 * The engine knows nothing about any business domain. It evaluates versioned,
 * data-defined rule sets against a bag of facts and explains how it got there.
 */

export type FactValue = string | number | boolean | null | undefined;
export type Facts = Record<string, FactValue>;

export type RuleKind = 'decision_tree' | 'decision_table' | 'parameters';

/** Lifecycle of a rule-set version. Published versions are immutable. */
export type VersionStatus = 'draft' | 'published' | 'retired';

// ---------------------------------------------------------------------------
// Decision tree (the legacy `*.rule` format, kept verbatim)
// ---------------------------------------------------------------------------

export type TreeOperator = 'EQ' | 'DEF' | 'GT' | 'GE' | 'LT' | 'LE' | 'BR' | 'BL';

export interface TreeDecision {
  oper: TreeOperator;
  check: string;
  check2?: string;
  action: 'goto' | 'return';
  value: string;
}

export interface TreeNode {
  /** Fact to test, e.g. "@height" (the "@" is optional). */
  check: string;
  /** n = numeric, s = string (informational; comparison is value-driven). */
  dtype?: 'n' | 's';
  decisions: TreeDecision[];
}

/** `{ start: "<node>", "<node>": TreeNode, ... }` */
export type DecisionTreeDefinition = { start: string } & Record<string, TreeNode | string>;

// ---------------------------------------------------------------------------
// Decision table
// ---------------------------------------------------------------------------

export type TableOperator =
  | 'any'
  | 'eq'
  | 'ne'
  | 'in'
  | 'notIn'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'between'
  | 'isTrue'
  | 'isFalse';

export interface TableCondition {
  /** Fact name (without "@"). */
  fact: string;
  op: TableOperator;
  /** Comparison operand: scalar for eq/ne/gt/…, array for in/notIn/between. */
  value?: FactValue | FactValue[];
  /** `between` / `ge`-style bounds: true ⇒ inclusive (default true for lower, false for upper). */
  inclusive?: boolean;
  inclusiveUpper?: boolean;
}

export interface TableRow {
  /** Stable id, used in traces and by editors. */
  id: number | string;
  /** Evaluation order; rows are sorted by it. */
  ordinal: number;
  label?: string;
  when: TableCondition[];
  /** Output object returned when the row hits. */
  then: Record<string, unknown>;
  /** PRIORITY hit policy only: higher wins. */
  priority?: number;
  active?: boolean;
}

export type HitPolicy = 'FIRST' | 'PRIORITY' | 'COLLECT';

/** Aggregation across a collection of fact sets (e.g. the blocks of an application). */
export interface TableAggregation {
  /** Output key that is aggregated. */
  output: string;
  /** MAX_RANK needs `order`, from lowest to highest. */
  mode: 'MAX_RANK' | 'MIN' | 'MAX' | 'SUM' | 'FIRST' | 'LIST';
  order?: (string | number)[];
}

export interface DecisionTableDefinition {
  hitPolicy: HitPolicy;
  rows: TableRow[];
  /** Returned when no row matches. */
  default?: Record<string, unknown>;
  /** Used by `evaluateCollection`. */
  aggregation?: TableAggregation;
}

// ---------------------------------------------------------------------------
// Parameter set
// ---------------------------------------------------------------------------

export interface ParameterSetDefinition {
  values: Record<string, unknown>;
}

export type RuleDefinition = DecisionTreeDefinition | DecisionTableDefinition | ParameterSetDefinition;

// ---------------------------------------------------------------------------
// Rule sets and versions
// ---------------------------------------------------------------------------

export interface RuleSetVersion<D = RuleDefinition> {
  /** Storage id of this version (recorded with every calculation). */
  versionId: number;
  ruleSetCode: string;
  kind: RuleKind;
  version: number;
  status: VersionStatus;
  definition: D;
  effectiveFrom?: string | null;
  checksum?: string;
}

export interface CompiledRuleSet {
  readonly code: string;
  readonly kind: RuleKind;
  readonly versionId: number;
  readonly version: number;
  readonly definition: RuleDefinition;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface TraceStep {
  /** Tree node name, or table row id, or parameter key. */
  at: string;
  /** Fact(s) examined. */
  input?: Record<string, FactValue>;
  /** What happened: "goto x", "return y", "row 3 hit", "no row matched". */
  outcome: string;
}

export interface EvaluationResult<T = unknown> {
  value: T;
  ruleSetCode: string;
  versionId: number;
  trace?: TraceStep[];
}

export interface EvaluateOptions {
  trace?: boolean;
}

export interface Problem {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Source of rule-set versions (database, cache, in-memory map …). */
export interface RuleSetSource {
  /** The currently published version of a rule set, or the one effective at `at`. */
  getPublished(code: string, at?: Date): RuleSetVersion | undefined;
  /** A specific version, for reproducing an old calculation. */
  getVersionById?(versionId: number): RuleSetVersion | undefined;
  /** Listing, for admin screens. */
  listCodes?(): string[];
}

export interface RuleTestCase {
  name: string;
  facts: Facts | Facts[];
  expected: unknown;
}

export interface RuleTestResult {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}
