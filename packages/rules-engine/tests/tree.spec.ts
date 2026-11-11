import { describe, expect, it } from 'vitest';
import { decisionMatches, evaluateTree, factName } from '../src/tree.js';
import type { DecisionTreeDefinition, TreeDecision } from '../src/types.js';

const d = (oper: TreeDecision['oper'], check: string, value = 'x', check2?: string): TreeDecision => ({
  oper,
  check,
  check2,
  action: 'return',
  value,
});

describe('decisionMatches', () => {
  it('DEF always matches', () => {
    expect(decisionMatches(d('DEF', ''), undefined)).toBe(true);
    expect(decisionMatches(d('DEF', ''), 'anything')).toBe(true);
  });

  it('EQ compares numerically when both sides are numeric', () => {
    expect(decisionMatches(d('EQ', '10'), 10)).toBe(true);
    expect(decisionMatches(d('EQ', '10'), '10.0')).toBe(true);
    expect(decisionMatches(d('EQ', '10'), 11)).toBe(false);
  });

  it('EQ compares strings case-insensitively and trimmed', () => {
    expect(decisionMatches(d('EQ', 'MLCP'), 'mlcp')).toBe(true);
    expect(decisionMatches(d('EQ', 'res'), ' RES ')).toBe(true);
    expect(decisionMatches(d('EQ', 'res'), 'edu')).toBe(false);
  });

  it('supports GT / GE / LT / LE', () => {
    expect(decisionMatches(d('GT', '10'), 11)).toBe(true);
    expect(decisionMatches(d('GT', '10'), 10)).toBe(false);
    expect(decisionMatches(d('GE', '10'), 10)).toBe(true);
    expect(decisionMatches(d('LT', '10'), 9.9)).toBe(true);
    expect(decisionMatches(d('LE', '10'), 10)).toBe(true);
  });

  it('BR is exclusive-lower, inclusive-upper and BL the opposite', () => {
    expect(decisionMatches(d('BR', '10', 'x', '15'), 10)).toBe(false);
    expect(decisionMatches(d('BR', '10', 'x', '15'), 15)).toBe(true);
    expect(decisionMatches(d('BL', '10', 'x', '15'), 10)).toBe(true);
    expect(decisionMatches(d('BL', '10', 'x', '15'), 15)).toBe(false);
  });

  it('treats booleans as 1/0 and blanks as non-numeric', () => {
    expect(decisionMatches(d('EQ', '1'), true)).toBe(true);
    expect(decisionMatches(d('GT', '0'), false)).toBe(false);
    expect(decisionMatches(d('GT', '0'), '')).toBe(false);
  });

  it('strips the @ prefix of fact names', () => {
    expect(factName('@height')).toBe('height');
    expect(factName('height')).toBe('height');
  });
});

describe('evaluateTree', () => {
  const tree: DecisionTreeDefinition = {
    start: 'type',
    type: {
      check: '@site_type',
      dtype: 's',
      decisions: [
        { oper: 'EQ', check: 'res', action: 'goto', value: 'height' },
        { oper: 'DEF', check: '', action: 'return', value: '' },
      ],
    },
    height: {
      check: '@height',
      dtype: 'n',
      decisions: [
        { oper: 'LE', check: '15', action: 'return', value: '' },
        { oper: 'BR', check: '15', check2: '30', action: 'return', value: '2' },
        { oper: 'DEF', check: '', action: 'goto', value: 'missing-node' },
      ],
    },
  };

  it('walks the tree and returns the matching value', () => {
    expect(evaluateTree(tree, { site_type: 'res', height: 24 }).value).toBe('2');
    expect(evaluateTree(tree, { site_type: 'res', height: 10 }).value).toBe('');
    expect(evaluateTree(tree, { site_type: 'biz', height: 24 }).value).toBe('');
  });

  it('returns "" for a goto to a node that does not exist (legacy behaviour)', () => {
    expect(evaluateTree(tree, { site_type: 'res', height: 60 }).value).toBe('');
  });

  it('records the visited path', () => {
    expect(evaluateTree(tree, { site_type: 'res', height: 24 }).path).toEqual(['type', 'height']);
  });

  it('produces a trace on request and none otherwise', () => {
    const withTrace = evaluateTree(tree, { site_type: 'res', height: 24 }, true);
    expect(withTrace.trace?.map((t) => t.at)).toEqual(['type', 'height']);
    expect(withTrace.trace?.[1].outcome).toContain('return 2');
    expect(evaluateTree(tree, { site_type: 'res', height: 24 }).trace).toBeUndefined();
  });

  it('returns "" when no decision matches', () => {
    const t: DecisionTreeDefinition = {
      start: 'n',
      n: { check: '@x', decisions: [{ oper: 'EQ', check: '1', action: 'return', value: 'one' }] },
    };
    expect(evaluateTree(t, { x: 2 }).value).toBe('');
  });

  it('throws on a cycle instead of looping forever', () => {
    const t: DecisionTreeDefinition = {
      start: 'a',
      a: { check: '@x', decisions: [{ oper: 'DEF', check: '', action: 'goto', value: 'b' }] },
      b: { check: '@x', decisions: [{ oper: 'DEF', check: '', action: 'goto', value: 'a' }] },
    };
    expect(() => evaluateTree(t, {})).toThrow(/cycle/i);
  });

  it('does not read inherited object properties as facts', () => {
    const t: DecisionTreeDefinition = {
      start: 'a',
      a: { check: '@toString', decisions: [{ oper: 'DEF', check: '', action: 'return', value: 'ok' }] },
    };
    expect(evaluateTree(t, {}).value).toBe('ok');
  });
});
