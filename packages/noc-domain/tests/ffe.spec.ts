import { fixture } from './fixtures.js';
import { ApplicationType, Block, Equipment, FfeRuleSet, RuleTree } from '../src/models/index.js';
import { newBlock } from '../src/application-factory.js';
import {
  blockRuleVars,
  carryProvidedToProposed,
  carryRequiredToProposed,
  computeBlockFfe,
  ffeBlockValue,
  ffeColumns,
  ffeFloorTotal,
  ffeNoteKeys,
  interpretRuleValue,
  normaliseNoteKey,
  parseOtherNotes,
} from '../src/ffe.js';

const equipments = fixture<Equipment[]>('assets/data/lookups/equipments.json');
const types = fixture<ApplicationType[]>('assets/data/lookups/application-types.json');
const rules: FfeRuleSet = {
  equipment: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, fixture<RuleTree>(`assets/data/rules/ffe/${i + 1}.json`)])),
  ffeType: fixture<RuleTree>('assets/data/rules/ffe-type.json'),
  otherNotes: fixture<RuleTree>('assets/data/rules/other-notes.json'),
  riserWidth: fixture<RuleTree>('assets/data/rules/riser-width.json'),
};

type F = [flrType: string, area: number, occupants: number];

function block(site_type: string, site_stype: string, height: number, floors: F[]): Block {
  const b = newBlock(1);
  b.site_type = site_type;
  b.site_stype = site_stype;
  b.height = height;
  b.floors = floors.map(([t, a, o], i) => ({ floor_id: i + 1, flr_type: t, flr_name: `${t}${i}`, built_area: a, occ_type: 'RES', occ_c_app: o }));
  return b;
}

const item = (b: Block, plot: number, perimeter: number, id: number) => computeBlockFfe(b, plot, perimeter, rules, equipments).items.find((i) => i.equip_id === id);

describe('FFE engine (verbatim uploads/rules/{equipment}.rule)', () => {
  const lowRise = () => block('res', 'A4', 12, [['G', 300, 10], ['F', 300, 10], ['F', 300, 10], ['F', 300, 10]]);
  const highRise = () => block('res', 'A4', 40, [['B', 1500, 0], ['S', 1200, 0], ...Array.from({ length: 12 }, (): F => ['F', 1200, 90])]);
  const hospital = () => {
    const b = block('ins', 'C1', 14, [['G', 800, 80], ['F', 800, 53], ['F', 800, 53], ['F', 750, 50]]);
    b.beds = 'Y';
    return b;
  };

  it('derives the legacy rule variables from the block', () => {
    const v = blockRuleVars(highRise(), 5000);
    expect(v).toMatchObject({ site_type: 'res', site_stype: 'A4', height: 40, floors: 12, maxarea: 1200, cov_area: 1200, base_area: 1500, built_area: 17100, plot_area: 5000, occ_load: 1080, beds: 'N' });
  });

  it('evaluates floor-wise items per floor: extinguishers 1 per 200 sq.m for light-hazard residential (2.rule A_LH)', () => {
    const ext = item(lowRise(), 200, 80, 2)!;
    expect(ext.level).toBe('F');
    expect(Object.values(ext.floors).map((c) => c.reqt)).toEqual([2, 2, 2, 2]); // ceil(300 / 200)
    expect(ffeFloorTotal(ext, 'reqt')).toBe(8);
    expect(ext.note_keys).toContain('A_LH'); // ffe-type.rule note on the extinguisher item
  });

  it('evaluates building-level items once per block (tanks, pumps, risers)', () => {
    const b = lowRise();
    expect(item(b, 200, 80, 11)?.block.reqt).toBe(5000); // terrace tank
    expect(item(b, 200, 80, 6)?.block.reqt).toBe(450); // booster pump
    expect(item(b, 200, 80, 10)).toBeUndefined(); // no wet riser below 35 m for A4
  });

  it('requires risers, underground tank and basement sprinklers for a 40 m apartment block', () => {
    const b = highRise();
    const riser = item(b, 5000, 300, 10)!;
    expect(riser.block.reqt).toBe(2); // D,maxarea,1000 → ceil(1200/1000)
    expect(riser.note_keys).toContain('Riser_100'); // riser-width.rule
    expect(item(b, 5000, 300, 12)?.block.reqt).toBe(75000); // 12.rule a3a4: 35 < h <= 45
    const spr = item(b, 5000, 300, 5)!;
    expect(spr.floors['1'].reqt).toBe(125); // basement only: ceil(1500 / 12)
    expect(spr.floors['3'].reqt).toBeNull();
    expect(item(b, 5000, 300, 8)).toBeUndefined(); // yard hydrants only above 45 m
  });

  it('returns note-based requirements (fire pump sets) as note keys', () => {
    const pump = item(highRise(), 5000, 300, 7)!;
    expect(pump.block.reqt).toBe('Note 10');
    expect(pump.note_keys).toEqual(['Note 10']);
  });

  it('sizes yard hydrants by the plot perimeter and the rule spacing (8.rule)', () => {
    const yh = item(hospital(), 3500, 240, 8)!;
    expect(yh.block.reqt).toBe(6); // ceil(240 / 45)
    expect(yh.note_keys).toEqual(['YH_45']);
  });

  it('uses the in-patient beds variable for hospitals', () => {
    const withBeds = hospital();
    const noBeds = hospital();
    noBeds.beds = 'N';
    expect(item(withBeds, 900, 120, 12)?.block.reqt).toBe(75000); // 12.rule c1_1000 → 2_beds → Y
    expect(item(noBeds, 900, 120, 12)).toBeUndefined();
  });

  it('collects the general notes of other_notes.rule for the block', () => {
    const ffe = computeBlockFfe(hospital(), 3500, 240, rules, equipments);
    expect(ffe.notes).toContain('Note 1');
    expect(ffeNoteKeys(ffe)).toEqual(expect.arrayContaining(['Note 1', 'A_MH', 'YH_45']));
  });

  it('keeps the applicant entries (proposed / provided / added items / confirmation) when recalculating', () => {
    const b = lowRise();
    b.ffe = computeBlockFfe(b, 200, 80, rules, equipments);
    b.ffe.agree_reqt = true;
    const ext = b.ffe.items.find((i) => i.equip_id === 2)!;
    ext.floors['1'].prov = 3;
    b.ffe.items.push({ equip_id: 13, level: 'B', floors: {}, block: { reqt: null, prop: null, prov: 1 }, note_keys: [], added: true });
    b.floors[0].built_area = 500; // change → recalculation
    const again = computeBlockFfe(b, 200, 80, rules, equipments);
    const ext2 = again.items.find((i) => i.equip_id === 2)!;
    expect(ext2.floors['1']).toEqual({ reqt: 3, prop: null, prov: 3 });
    expect(again.items.find((i) => i.equip_id === 13)?.block.prov).toBe(1);
    expect(again.agree_reqt).toBe(true);
  });

  it('drops items that are no longer required (unless the applicant added them)', () => {
    const b = highRise();
    b.ffe = computeBlockFfe(b, 5000, 300, rules, equipments);
    expect(b.ffe.items.some((i) => i.equip_id === 12)).toBe(true);
    b.height = 30;
    expect(computeBlockFfe(b, 5000, 300, rules, equipments).items.some((i) => i.equip_id === 12)).toBe(false);
  });

  it('interprets the rule return formats', () => {
    const vars = { floor_area: 450, exit_count: 2 };
    expect(interpretRuleValue('', vars, 2, 0)).toEqual({ reqt: null, notes: [] });
    expect(interpretRuleValue('D,floor_area,200', vars, 2, 0).reqt).toBe(3);
    expect(interpretRuleValue('D,floor_area,100,', vars, 2, 0).reqt).toBe(5); // trailing comma in 2.rule B_MH
    expect(interpretRuleValue('exit_count', vars, 3, 0).reqt).toBe(2);
    expect(interpretRuleValue('2000', vars, 6, 0).reqt).toBe(2000);
    expect(interpretRuleValue('30', vars, 8, 100)).toEqual({ reqt: 4, notes: ['YH_30'] });
    expect(interpretRuleValue('Note 12|note 13', vars, 7, 0)).toEqual({ reqt: 'Note 12, Note 13', notes: ['Note 12', 'Note 13'] });
    expect(normaliseNoteKey('note 12')).toBe('Note 12');
  });

  it('parses other_notes results with item scopes', () => {
    expect(parseOtherNotes('Note 7:10,12@Note 14')).toEqual({ general: ['Note 14'], scoped: { 10: ['Note 7'], 12: ['Note 7'] } });
    expect(parseOtherNotes('D,maxarea,1000')).toEqual({ general: [], scoped: {} });
  });

  it('block value = the building cell, or the cumulative floor total', () => {
    const b = highRise();
    const ffe = computeBlockFfe(b, 5000, 300, rules, equipments);
    expect(ffeBlockValue(ffe.items.find((i) => i.equip_id === 12)!, 'reqt')).toBe(75000);
    expect(ffeBlockValue(ffe.items.find((i) => i.equip_id === 4)!, 'reqt')).toBe(14);
    expect(ffeBlockValue(ffe.items.find((i) => i.equip_id === 4)!, 'prov')).toBeNull();
  });

  it('carries values forward: Occupancy (required → proposed) and Renewal (provided → proposed)', () => {
    const ffe = computeBlockFfe(lowRise(), 200, 80, rules, equipments);
    const occ = carryRequiredToProposed(ffe);
    expect(occ.items[0].floors['1']).toEqual({ reqt: 2, prop: 2, prov: null });
    occ.items[0].floors['1'].prov = 4;
    const ren = carryProvidedToProposed(occ);
    expect(ren.items[0].floors['1']).toEqual({ reqt: 2, prop: 4, prov: null });
    expect(ren.items[0].floors['2'].prop).toBe(2); // nothing provided → falls back to required
  });

  it('reads the grid columns from ApplTypes (text vs input per type/mode)', () => {
    expect(ffeColumns(types, 'P', '').map((c) => `${c.tag}:${c.type}`)).toEqual(['reqt:text']);
    expect(ffeColumns(types, 'O', 'O').map((c) => `${c.tag}:${c.type}`)).toEqual(['prop:text', 'prov:input']);
    expect(ffeColumns(types, 'O', 'N').map((c) => `${c.tag}:${c.type}`)).toEqual(['reqt:text', 'prov:input']);
    expect(ffeColumns(types, 'R', 'M').map((c) => `${c.tag}:${c.type}`)).toEqual(['prop:input', 'prov:input']);
  });
});
