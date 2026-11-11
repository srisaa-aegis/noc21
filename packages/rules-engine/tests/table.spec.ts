import { describe, expect, it } from 'vitest';
import { conditionMatches, evaluateTable, evaluateTableCollection } from '../src/table.js';
import type { DecisionTableDefinition } from '../src/types.js';

describe('conditionMatches', () => {
  const facts = { site_type: 'res', site_stype: 'A4', height: 18, is_multiplex: false, beds: 'Y' };

  it('handles eq / ne / in / notIn', () => {
    expect(conditionMatches({ fact: 'site_type', op: 'eq', value: 'res' }, facts)).toBe(true);
    expect(conditionMatches({ fact: 'site_type', op: 'ne', value: 'res' }, facts)).toBe(false);
    expect(conditionMatches({ fact: 'site_type', op: 'in', value: ['res', 'edu'] }, facts)).toBe(true);
    expect(conditionMatches({ fact: 'site_type', op: 'notIn', value: ['res'] }, facts)).toBe(false);
  });

  it('treats an empty list as "no restriction" for in', () => {
    expect(conditionMatches({ fact: 'site_stype', op: 'in', value: [] }, facts)).toBe(true);
  });

  it('is case-insensitive on text', () => {
    expect(conditionMatches({ fact: 'site_stype', op: 'in', value: ['a4'] }, facts)).toBe(true);
  });

  it('handles numeric comparisons and between bounds', () => {
    expect(conditionMatches({ fact: 'height', op: 'ge', value: 18 }, facts)).toBe(true);
    expect(conditionMatches({ fact: 'height', op: 'gt', value: 18 }, facts)).toBe(false);
    expect(conditionMatches({ fact: 'height', op: 'between', value: [15, 30] }, facts)).toBe(true);
    expect(conditionMatches({ fact: 'height', op: 'between', value: [18, 30], inclusive: false }, facts)).toBe(false);
    expect(conditionMatches({ fact: 'height', op: 'between', value: [10, 18] }, facts)).toBe(false);
    expect(conditionMatches({ fact: 'height', op: 'between', value: [10, 18], inclusiveUpper: true }, facts)).toBe(true);
  });

  it('handles truthiness including "Y"', () => {
    expect(conditionMatches({ fact: 'beds', op: 'isTrue' }, facts)).toBe(true);
    expect(conditionMatches({ fact: 'is_multiplex', op: 'isTrue' }, facts)).toBe(false);
    expect(conditionMatches({ fact: 'is_multiplex', op: 'isFalse' }, facts)).toBe(true);
    expect(conditionMatches({ fact: 'anything', op: 'any' }, facts)).toBe(true);
  });
});

const levels: DecisionTableDefinition = {
  hitPolicy: 'FIRST',
  rows: [
    { id: 1, ordinal: 1, label: 'hazardous', when: [{ fact: 'site_type', op: 'in', value: ['haz', 'sto', 'ind'] }], then: { level: 'MSB' } },
    {
      id: 2,
      ordinal: 2,
      label: 'apartments >= 18',
      when: [
        { fact: 'site_type', op: 'in', value: ['res'] },
        { fact: 'site_stype', op: 'in', value: ['A4'] },
        { fact: 'height', op: 'ge', value: 18 },
      ],
      then: { level: 'MSB' },
    },
    { id: 3, ordinal: 3, label: 'any > 10', when: [{ fact: 'height', op: 'gt', value: 10 }], then: { level: 'RFO' } },
  ],
  default: { level: 'DFO' },
  aggregation: { output: 'level', mode: 'MAX_RANK', order: ['DFO', 'RFO', 'MSB'] },
};

describe('evaluateTable', () => {
  it('returns the first matching row', () => {
    expect(evaluateTable(levels, { site_type: 'res', site_stype: 'A4', height: 18 }).value).toEqual({ level: 'MSB' });
    expect(evaluateTable(levels, { site_type: 'res', site_stype: 'A4', height: 12 }).value).toEqual({ level: 'RFO' });
  });

  it('falls back to the default', () => {
    expect(evaluateTable(levels, { site_type: 'biz', height: 8 }).value).toEqual({ level: 'DFO' });
  });

  it('reports the matched row ids and a trace', () => {
    const r = evaluateTable(levels, { site_type: 'sto', height: 5 }, true);
    expect(r.matchedRowIds).toEqual([1]);
    expect(r.trace?.[0]).toEqual({ at: 'row 1 (hazardous)', outcome: 'matched' });
  });

  it('honours ordinal order, not array order', () => {
    const t: DecisionTableDefinition = {
      hitPolicy: 'FIRST',
      rows: [
        { id: 'b', ordinal: 2, when: [{ fact: 'x', op: 'any' }], then: { v: 'second' } },
        { id: 'a', ordinal: 1, when: [{ fact: 'x', op: 'any' }], then: { v: 'first' } },
      ],
    };
    expect(evaluateTable(t, {}).value).toEqual({ v: 'first' });
  });

  it('supports PRIORITY and COLLECT', () => {
    const rows = [
      { id: 1, ordinal: 1, when: [{ fact: 'x', op: 'any' as const }], then: { v: 'low' }, priority: 1 },
      { id: 2, ordinal: 2, when: [{ fact: 'x', op: 'any' as const }], then: { v: 'high' }, priority: 9 },
    ];
    expect(evaluateTable({ hitPolicy: 'PRIORITY', rows }, {}).value).toEqual({ v: 'high' });
    expect(evaluateTable({ hitPolicy: 'COLLECT', rows }, {}).value).toEqual([{ v: 'low' }, { v: 'high' }]);
  });

  it('skips inactive rows', () => {
    const t: DecisionTableDefinition = {
      hitPolicy: 'FIRST',
      rows: [{ id: 1, ordinal: 1, active: false, when: [{ fact: 'x', op: 'any' }], then: { v: 'off' } }],
      default: { v: 'default' },
    };
    expect(evaluateTable(t, {}).value).toEqual({ v: 'default' });
  });
});

describe('evaluateTableCollection', () => {
  it('aggregates with MAX_RANK across items (highest approval level of all blocks)', () => {
    const r = evaluateTableCollection(levels, [
      { site_type: 'res', site_stype: 'A4', height: 12 },
      { site_type: 'biz', height: 6 },
      { site_type: 'res', site_stype: 'A4', height: 21 },
    ]);
    expect(r.value).toEqual({ level: 'MSB' });
    expect(r.perItem).toEqual([{ level: 'RFO' }, { level: 'DFO' }, { level: 'MSB' }]);
  });

  it('aggregates with MIN (shortest renewal period of all blocks)', () => {
    const years: DecisionTableDefinition = {
      hitPolicy: 'FIRST',
      rows: [
        { id: 1, ordinal: 1, when: [{ fact: 'site_type', op: 'in', value: ['res'] }, { fact: 'height', op: 'lt', value: 60 }], then: { years: 5 } },
        { id: 2, ordinal: 2, when: [{ fact: 'height', op: 'lt', value: 18 }], then: { years: 3 } },
      ],
      default: { years: 1 },
      aggregation: { output: 'years', mode: 'MIN' },
    };
    expect(evaluateTableCollection(years, [{ site_type: 'res', height: 30 }, { site_type: 'biz', height: 12 }]).value).toEqual({ years: 3 });
  });

  it('returns the default when the collection is empty', () => {
    expect(evaluateTableCollection(levels, []).value).toEqual({ level: 'DFO' });
  });
});
