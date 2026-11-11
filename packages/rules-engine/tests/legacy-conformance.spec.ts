/**
 * Conformance: the engine must evaluate the shipped legacy decision trees
 * (NOC-base/uploads/rules/*.rule, converted verbatim to JSON) exactly like the
 * evaluator the portal ran in the browser (ported verbatim into @srisaa/noc-domain rule-engine.ts).
 *
 * Both implementations are run over a deterministic fact grid covering every
 * occupancy, height band, area band and floor type, for all 16 trees.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateRule as legacyEvaluate } from '../../noc-domain/src/rule-engine';
import { evaluateTree } from '../src/tree.js';
import type { DecisionTreeDefinition, Facts } from '../src/types.js';

const RULES_DIR = join(import.meta.dirname, '..', '..', '..', 'backend', 'seed', 'data', 'rules');

function loadTrees(): { name: string; tree: DecisionTreeDefinition }[] {
  const out: { name: string; tree: DecisionTreeDefinition }[] = [];
  for (const f of readdirSync(join(RULES_DIR, 'ffe')).sort()) {
    out.push({ name: `ffe/${f}`, tree: JSON.parse(readFileSync(join(RULES_DIR, 'ffe', f), 'utf8')) });
  }
  for (const f of readdirSync(RULES_DIR).filter((x) => x.endsWith('.json')).sort()) {
    out.push({ name: f, tree: JSON.parse(readFileSync(join(RULES_DIR, f), 'utf8')) });
  }
  return out;
}

const SITE_TYPES = ['res', 'edu', 'ins', 'asm', 'biz', 'mer', 'ind', 'sto', 'haz'];
const SUB_TYPES = ['A1', 'A4', 'B1', 'C1', 'D6', 'E', 'F3', 'G2', 'H', 'J', 'mlcp', ''];
const HEIGHTS = [0, 9, 10, 10.1, 14.9, 15, 18, 23.9, 24, 30, 45, 55, 60, 61];
const AREAS = [0, 100, 200, 250, 500, 750, 1000, 2000, 5000, 10000];
const FLOOR_TYPES = ['B', 'S', 'G', 'F', 'T'];

function* factGrid(): Generator<Facts> {
  let i = 0;
  for (const site_type of SITE_TYPES) {
    for (const site_stype of SUB_TYPES) {
      for (const height of HEIGHTS) {
        const area = AREAS[i % AREAS.length];
        const flr_type = FLOOR_TYPES[i % FLOOR_TYPES.length];
        i++;
        yield {
          site_type,
          site_stype,
          height,
          floors: Math.round(height / 3),
          maxarea: area,
          cov_area: area,
          base_area: area,
          built_area: area * 3,
          plot_area: area * 2,
          floor_area: area,
          flr_type,
          beds: i % 2 === 0 ? 'Y' : 'N',
          occ_load: area,
          exit_count: (i % 4) + 1,
          is_multiplex: i % 3 === 0,
        };
      }
    }
  }
}

describe('legacy decision-tree conformance', () => {
  const trees = loadTrees();

  it('loads all 16 shipped trees', () => {
    expect(trees.map((t) => t.name)).toEqual([
      'ffe/1.json',
      'ffe/10.json',
      'ffe/11.json',
      'ffe/12.json',
      'ffe/2.json',
      'ffe/3.json',
      'ffe/4.json',
      'ffe/5.json',
      'ffe/6.json',
      'ffe/7.json',
      'ffe/8.json',
      'ffe/9.json',
      'ffe-type.json',
      'height-limits.json',
      'other-notes.json',
      'riser-width.json',
    ]);
  });

  for (const { name, tree } of trees) {
    it(`matches the browser evaluator for ${name}`, () => {
      let checked = 0;
      for (const facts of factGrid()) {
        const mine = evaluateTree(tree, facts);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const legacy = legacyEvaluate(tree as any, facts as any);
        if (mine.value !== legacy.value || mine.path.join('>') !== legacy.path.join('>')) {
          throw new Error(
            `${name} differs for ${JSON.stringify(facts)}: engine=${JSON.stringify(mine)} legacy=${JSON.stringify(legacy)}`,
          );
        }
        checked++;
      }
      expect(checked).toBe(SITE_TYPES.length * SUB_TYPES.length * HEIGHTS.length);
    });
  }
});
