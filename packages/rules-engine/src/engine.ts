/**
 * RuleEngine — the facade host applications use.
 *
 * It resolves rule-set versions through a `RuleSetSource` port, compiles and
 * caches them by version id, evaluates them against facts, and records which
 * version produced each result.
 */
import { RuleDefinitionError, RuleSetNotFoundError } from './errors.js';
import { evaluateTable, evaluateTableCollection } from './table.js';
import { evaluateTree } from './tree.js';
import type {
  CompiledRuleSet,
  DecisionTableDefinition,
  DecisionTreeDefinition,
  EvaluateOptions,
  EvaluationResult,
  Facts,
  ParameterSetDefinition,
  RuleSetSource,
  RuleSetVersion,
  RuleTestCase,
  RuleTestResult,
} from './types.js';
import { errorsOf, validateDefinition } from './validate.js';

export interface RuleEngineOptions {
  /** Validate a definition the first time it is compiled (default: true). */
  validateOnCompile?: boolean;
}

export function compile(version: RuleSetVersion, validate = true): CompiledRuleSet {
  if (validate) {
    const problems = errorsOf(validateDefinition(version.kind, version.definition));
    if (problems.length) throw new RuleDefinitionError(version.ruleSetCode, problems);
  }
  return {
    code: version.ruleSetCode,
    kind: version.kind,
    versionId: version.versionId,
    version: version.version,
    definition: version.definition,
  };
}

export class RuleEngine {
  private readonly compiled = new Map<number, CompiledRuleSet>();

  constructor(
    private readonly source: RuleSetSource,
    private readonly options: RuleEngineOptions = {},
  ) {}

  /** Compiled, currently published version of a rule set (or the one effective at `at`). */
  get(code: string, at?: Date): CompiledRuleSet {
    const version = this.source.getPublished(code, at);
    if (!version) throw new RuleSetNotFoundError(code);
    return this.compiledOf(version);
  }

  getByVersionId(versionId: number): CompiledRuleSet {
    const cached = this.compiled.get(versionId);
    if (cached) return cached;
    const version = this.source.getVersionById?.(versionId);
    if (!version) throw new RuleSetNotFoundError(`versionId:${versionId}`);
    return this.compiledOf(version);
  }

  has(code: string): boolean {
    return !!this.source.getPublished(code);
  }

  private compiledOf(version: RuleSetVersion): CompiledRuleSet {
    const cached = this.compiled.get(version.versionId);
    if (cached) return cached;
    const c = compile(version, this.options.validateOnCompile !== false);
    this.compiled.set(version.versionId, c);
    return c;
  }

  /** Evaluate one rule set against one set of facts. */
  evaluate<T = unknown>(code: string, facts: Facts, opts: EvaluateOptions & { at?: Date } = {}): EvaluationResult<T> {
    const set = opts.at ? this.get(code, opts.at) : this.get(code);
    return this.evaluateCompiled<T>(set, facts, opts);
  }

  evaluateCompiled<T = unknown>(set: CompiledRuleSet, facts: Facts, opts: EvaluateOptions = {}): EvaluationResult<T> {
    const base = { ruleSetCode: set.code, versionId: set.versionId };
    switch (set.kind) {
      case 'decision_tree': {
        const r = evaluateTree(set.definition as DecisionTreeDefinition, facts, !!opts.trace);
        return { ...base, value: r.value as unknown as T, trace: r.trace };
      }
      case 'decision_table': {
        const r = evaluateTable(set.definition as DecisionTableDefinition, facts, !!opts.trace);
        return { ...base, value: r.value as unknown as T, trace: r.trace };
      }
      case 'parameters': {
        const values = (set.definition as ParameterSetDefinition).values;
        return { ...base, value: values as unknown as T, trace: opts.trace ? [{ at: 'parameters', outcome: 'returned' }] : undefined };
      }
      default:
        throw new RuleDefinitionError(set.code, [{ path: '', message: `Unsupported kind "${set.kind}".` }]);
    }
  }

  /** Evaluate a decision table over a collection of fact sets and aggregate. */
  evaluateCollection<T = unknown>(
    code: string,
    factsList: Facts[],
    opts: EvaluateOptions & { at?: Date } = {},
  ): EvaluationResult<T> & { perItem: (Record<string, unknown> | undefined)[] } {
    const set = opts.at ? this.get(code, opts.at) : this.get(code);
    if (set.kind !== 'decision_table') {
      throw new RuleDefinitionError(code, [{ path: '', message: 'evaluateCollection needs a decision table.' }]);
    }
    const r = evaluateTableCollection(set.definition as DecisionTableDefinition, factsList, !!opts.trace);
    return {
      ruleSetCode: set.code,
      versionId: set.versionId,
      value: r.value as unknown as T,
      perItem: r.perItem,
      trace: r.trace,
    };
  }

  /** Convenience: a single parameter value. */
  parameter<T = unknown>(code: string, key: string, fallback?: T): T {
    const values = this.evaluate<Record<string, unknown>>(code, {}).value;
    const v = values?.[key];
    return (v === undefined ? fallback : v) as T;
  }

  /** Version ids of every rule set compiled so far — recorded with calculations. */
  versionsUsed(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.compiled.values()) out[c.code] = c.versionId;
    return out;
  }

  /** Runs stored regression cases (used before publishing a new version). */
  runTestCases(code: string, cases: RuleTestCase[]): RuleTestResult[] {
    const set = this.get(code);
    return cases.map((tc) => {
      const actual = Array.isArray(tc.facts)
        ? evaluateTableCollection(set.definition as DecisionTableDefinition, tc.facts).value
        : this.evaluateCompiled(set, tc.facts).value;
      return {
        name: tc.name,
        expected: tc.expected,
        actual,
        passed: JSON.stringify(actual ?? null) === JSON.stringify(tc.expected ?? null),
      };
    });
  }
}
