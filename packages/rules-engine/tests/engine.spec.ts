import { describe, expect, it } from 'vitest';
import { RuleEngine } from '../src/engine.js';
import { RuleDefinitionError, RuleSetNotFoundError } from '../src/errors.js';
import { InMemoryRuleSetSource } from '../src/testing/index.js';
import { validateDecisionTable, validateDecisionTree, validateParameters } from '../src/validate.js';
import type { DecisionTableDefinition, DecisionTreeDefinition } from '../src/types.js';

function source() {
  const s = new InMemoryRuleSetSource();
  s.add('demo.tree', 'decision_tree', {
    start: 'a',
    a: { check: '@height', decisions: [{ oper: 'GE', check: '15', action: 'return', value: 'tall' }, { oper: 'DEF', check: '', action: 'return', value: 'short' }] },
  } as DecisionTreeDefinition);
  s.add('demo.table', 'decision_table', {
    hitPolicy: 'FIRST',
    rows: [{ id: 1, ordinal: 1, when: [{ fact: 'x', op: 'gt', value: 5 }], then: { y: 'big' } }],
    default: { y: 'small' },
    aggregation: { output: 'y', mode: 'LIST' },
  } as DecisionTableDefinition);
  s.add('demo.params', 'parameters', { values: { rate: 10, label: 'fee' } });
  return s;
}

describe('RuleEngine', () => {
  it('evaluates each kind and reports the version used', () => {
    const e = new RuleEngine(source());
    const tree = e.evaluate<string>('demo.tree', { height: 20 });
    expect(tree.value).toBe('tall');
    expect(tree.versionId).toBe(1);
    expect(e.evaluate('demo.table', { x: 9 }).value).toEqual({ y: 'big' });
    expect(e.evaluate('demo.params', {}).value).toEqual({ rate: 10, label: 'fee' });
    expect(e.parameter('demo.params', 'rate')).toBe(10);
    expect(e.parameter('demo.params', 'missing', 42)).toBe(42);
  });

  it('aggregates a collection', () => {
    const e = new RuleEngine(source());
    expect(e.evaluateCollection('demo.table', [{ x: 9 }, { x: 1 }]).value).toEqual({ y: ['big', 'small'] });
  });

  it('throws a typed error for an unknown rule set', () => {
    const e = new RuleEngine(source());
    expect(() => e.evaluate('nope', {})).toThrow(RuleSetNotFoundError);
    expect(e.has('demo.tree')).toBe(true);
    expect(e.has('nope')).toBe(false);
  });

  it('refuses to compile an invalid definition', () => {
    const s = new InMemoryRuleSetSource();
    s.add('bad', 'decision_tree', { start: 'missing' } as DecisionTreeDefinition);
    expect(() => new RuleEngine(s).evaluate('bad', {})).toThrow(RuleDefinitionError);
  });

  it('caches compiled versions and exposes versionsUsed()', () => {
    const e = new RuleEngine(source());
    e.evaluate('demo.tree', { height: 1 });
    e.evaluate('demo.params', {});
    expect(e.versionsUsed()).toEqual({ 'demo.tree': 1, 'demo.params': 3 });
  });

  it('can fetch a specific version by id', () => {
    const s = source();
    const e = new RuleEngine(s);
    expect(e.getByVersionId(1).code).toBe('demo.tree');
  });

  it('runs stored regression cases', () => {
    const e = new RuleEngine(source());
    const results = e.runTestCases('demo.tree', [
      { name: 'tall', facts: { height: 16 }, expected: 'tall' },
      { name: 'wrong', facts: { height: 1 }, expected: 'tall' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });
});

describe('validation', () => {
  it('reports tree problems', () => {
    const p = validateDecisionTree({ start: 'a', a: { check: '', decisions: [] } } as unknown as DecisionTreeDefinition);
    expect(p.some((x) => x.message.includes('fact name'))).toBe(true);
    expect(p.some((x) => x.message.includes('at least one decision'))).toBe(true);
  });

  it('warns about dangling gotos rather than failing (legacy trees rely on it)', () => {
    const p = validateDecisionTree({
      start: 'a',
      a: { check: '@x', decisions: [{ oper: 'DEF', check: '', action: 'goto', value: 'nowhere' }] },
    } as DecisionTreeDefinition);
    expect(p.filter((x) => x.severity === 'error')).toHaveLength(0);
    expect(p.some((x) => x.severity === 'warning' && x.message.includes('does not exist'))).toBe(true);
  });

  it('detects cycles and unreachable nodes', () => {
    const p = validateDecisionTree({
      start: 'a',
      a: { check: '@x', decisions: [{ oper: 'DEF', check: '', action: 'goto', value: 'b' }] },
      b: { check: '@x', decisions: [{ oper: 'DEF', check: '', action: 'goto', value: 'a' }] },
      orphan: { check: '@x', decisions: [{ oper: 'DEF', check: '', action: 'return', value: '' }] },
    } as DecisionTreeDefinition);
    expect(p.some((x) => x.severity === 'error' && x.message.includes('cycle'))).toBe(true);
    expect(p.some((x) => x.message.includes('unreachable'))).toBe(true);
  });

  it('reports table problems', () => {
    const p = validateDecisionTable({
      hitPolicy: 'NOPE' as never,
      rows: [{ id: 1, ordinal: 1, when: [{ fact: 'x', op: 'in', value: 'notanarray' as never }], then: {} }],
    });
    expect(p.some((x) => x.path === 'hitPolicy')).toBe(true);
    expect(p.some((x) => x.message.includes('array value'))).toBe(true);
    expect(p.some((x) => x.message.includes('output'))).toBe(true);
  });

  it('rejects reserved fact names', () => {
    const p = validateDecisionTable({
      hitPolicy: 'FIRST',
      rows: [{ id: 1, ordinal: 1, when: [{ fact: '__proto__', op: 'any' }], then: { a: 1 } }],
    });
    expect(p.some((x) => x.message.includes('not an allowed fact name'))).toBe(true);
  });

  it('validates parameter sets', () => {
    expect(validateParameters({ values: { a: 1 } })).toHaveLength(0);
    expect(validateParameters({} as never)).toHaveLength(1);
  });
});
