import { Block, Floor } from '../src/models/index.js';
import { newBlock } from '../src/application-factory.js';
import {
  aggregateStaircase,
  blockBuiltUpO,
  blockTotalNbcOccLoad,
  blockTotalNbcOccLoadO,
  blockTotalOccLoadO,
  doorWidthRequired,
  fireLiftsReqd,
  floorDesc,
  floorDisplay,
  frontAbutting,
  floorEscapeWidth,
  loadPerUnitExit,
  maxStairsByLoad,
  msbReqdOpenSpace,
  nonMsbReqdOpenSpace,
  openSpaceCheckHeight,
  openSpaceMessage,
  proposedEscapeWidth,
  proposedOpenSpace,
  proposedOpenSpaceO,
  refugeAreaRequired,
  reqdEscapeCount,
  reqdEscapeWidth,
  reqdOpenSpace,
  requiredEquip,
  stairCount,
  stairsByLoad,
  t20OccCount,
  t20OccCountO,
  totalStairsRequiredByNBC,
} from '../src/commonrules.js';

const floor = (flr_type: string, built_area: number, occ_type: string, occ_c_app = 0, extra: Partial<Floor> = {}): Floor => ({
  floor_id: 0,
  flr_type,
  flr_name: flr_type,
  built_area,
  occ_type,
  occ_c_app,
  ...extra,
});

function blk(height: number, opts: Partial<Block> = {}): Block {
  const b = newBlock(1);
  b.height = height;
  b.permissible_height = height;
  b.front_dir = 'E';
  b.sides = [
    { bside_id: 1, direc: 'N', ptype: 'B', pname: '', width: 0 },
    { bside_id: 2, direc: 'E', ptype: 'R', pname: 'Main road', width: 12 },
    { bside_id: 3, direc: 'S', ptype: 'B', pname: '', width: 0 },
    { bside_id: 4, direc: 'W', ptype: 'B', pname: '', width: 0 },
  ];
  return Object.assign(b, opts);
}

describe('commonrules port (script/commonrules.js)', () => {
  describe('occupant load — NBC Table 20', () => {
    it('uses the area per person of the floor occupancy', () => {
      expect(t20OccCount(floor('F', 1000, 'RES'))).toBe(80); // 12.5 sq.m / person
      expect(t20OccCount(floor('F', 1000, 'BIZ'))).toBe(100); // 10
      expect(t20OccCount(floor('F', 650, 'ASM3'))).toBe(1000); // 0.65
      expect(t20OccCount(floor('F', 300, 'MER1'))).toBe(100); // 3
      expect(t20OccCount(floor('F', 600, 'STO'))).toBe(20); // 30
      expect(t20OccCount(floor('B', 2000, 'PAR'))).toBe(0); // parking
    });
    it('counts fixed seats + 20% for ASM1', () => {
      expect(t20OccCount(floor('G', 900, 'ASM1', 0, { seats_num: 500 }))).toBe(600);
    });
    it('sums the NBC load of a block', () => {
      expect(blockTotalNbcOccLoad({ floors: [floor('G', 1000, 'RES'), floor('F', 1000, 'BIZ')] })).toBe(180);
    });
    it('returns the occupants per unit exit width', () => {
      expect(loadPerUnitExit({ occ_type: 'RES' })).toBe(25);
      expect(loadPerUnitExit({ occ_type: 'ASM1' })).toBe(40);
      expect(loadPerUnitExit({ occ_type: 'MER2' })).toBe(50);
    });
  });

  describe('staircases', () => {
    it('needs 1 staircase up to 500 sq.m of floor area and 2 above (multi-storey only)', () => {
      expect(totalStairsRequiredByNBC({ floors: [floor('G', 400, 'RES')] })).toBe(0);
      expect(totalStairsRequiredByNBC({ floors: [floor('G', 400, 'RES'), floor('F', 400, 'RES')] })).toBe(1);
      expect(totalStairsRequiredByNBC({ floors: [floor('S', 600, 'PAR'), floor('F', 600, 'RES')] })).toBe(2);
    });
    it('derives internal/external counts from the largest floor area (per 1000 sq.m)', () => {
      const big = { floors: [floor('G', 4500, 'BIZ'), floor('F', 4500, 'BIZ')] };
      expect(reqdEscapeCount(big, 'I')).toBe(3); // 1 + ceil((4-1)/2)
      expect(reqdEscapeCount(big, 'E')).toBe(2); // 1 + floor((4-1)/2)
      expect(reqdEscapeCount({ floors: [floor('G', 1900, 'BIZ')] }, 'I')).toBe(1);
    });
    it('aggregate width by load: occupants × mm per person / 1000', () => {
      expect(stairsByLoad(floor('F', 0, 'RES', 250))).toBe(2); // 250 × 10 mm
      expect(stairsByLoad(floor('F', 0, 'HAZ', 200))).toBe(3); // 200 × 18 mm
      expect(stairsByLoad(floor('F', 0, 'INS2', 200))).toBe(3); // LEGACY BUG FIXED: 15 mm for INS
      expect(stairsByLoad(floor('B', 0, 'PAR', 50))).toBeNull();
      expect(maxStairsByLoad({ floors: [floor('S', 500, 'PAR'), floor('F', 500, 'RES', 120), floor('F', 500, 'RES', 310)] })).toBe(3);
    });
    it('minimum widths per NBC 2016', () => {
      expect(reqdEscapeWidth('I', 'res', 'A4', 0)).toBe('1.25');
      expect(reqdEscapeWidth('I', 'res', 'A2', 0)).toBe('1.0');
      expect(reqdEscapeWidth('I', 'ins', 'C1', 0)).toBe('2.0');
      expect(reqdEscapeWidth('I', 'asm', 'D1', 149)).toBe('1.5');
      expect(reqdEscapeWidth('I', 'asm', 'D1', 150)).toBe('2.0');
      expect(reqdEscapeWidth('C', 'res', 'A4', 0)).toBe('1-Way: 3.6 / 2-Way:5.4');
      expect(reqdEscapeWidth('E', 'res', 'A4', 0)).toBe('1.5');
    });
    it('sums proposed widths and the width serving each floor (from/to floor ranges)', () => {
      const b = blk(12);
      b.floors = [floor('G', 100, 'RES'), floor('F', 100, 'RES'), floor('F', 100, 'RES')].map((f, i) => ({ ...f, floor_id: i + 1 }));
      b.escapes = [
        { escape_id: 1, etype: 'I', desc: '', width: 1.5, location: 'E' },
        { escape_id: 2, etype: 'E', desc: '', width: 1.25, location: 'W', from_floor: 1, to_floor: 2 },
        { escape_id: 3, etype: 'I', desc: '', width: 2, location: 'N' },
      ];
      expect(aggregateStaircase(b)).toBe(4.75);
      expect(proposedEscapeWidth(b, 'I')).toBe(1.75);
      expect(floorEscapeWidth(b, 1)).toBe(4.75);
      expect(floorEscapeWidth(b, 3)).toBe(3.5);
    });
    it('door width, fire lifts and refuge area', () => {
      expect(doorWidthRequired({ site_type: 'asm' })).toBe(2);
      expect(doorWidthRequired({ site_type: 'res' })).toBe(1);
      expect(fireLiftsReqd({ height: 14, floors: [floor('F', 3000, 'RES')] })).toBe(0);
      expect(fireLiftsReqd({ height: 15, floors: [floor('F', 3000, 'RES')] })).toBe(3); // round(3000/1200)
      const b = { floors: [floor('F', 1000, 'RES'), floor('F', 1000, 'RES')].map((f, i) => ({ ...f, floor_id: i + 1 })) };
      expect(refugeAreaRequired(b, 1, 0.3, 15)).toBe(48); // (80 + 80) × 0.3
      expect(refugeAreaRequired(b, 2, 0.3, 15)).toBe(24);
      expect(refugeAreaRequired({ floors: [floor('F', 100, 'RES')].map((f) => ({ ...f, floor_id: 1 })) }, 1, 0.3, 15)).toBe(15);
    });
  });

  describe('open spaces — G.O.Ms.No.119', () => {
    it('uses the permissible height for Provisional / Occupancy-from-PNOC, else the actual height', () => {
      const b = blk(20, { permissible_height: 17 });
      expect(openSpaceCheckHeight(b, 'P', '')).toBe(17);
      expect(openSpaceCheckHeight(b, 'O', 'O')).toBe(17);
      expect(openSpaceCheckHeight(b, 'O', 'N')).toBe(20);
      expect(openSpaceCheckHeight(b, 'R', 'M')).toBe(20);
    });

    it('front side: depends on plot area, height and the abutting road width', () => {
      const b = blk(10);
      expect(nonMsbReqdOpenSpace(b, 6, 'E', 150)).toBe(1.5); // ≤ 200 sq.m, road ≤ 12 m
      expect(nonMsbReqdOpenSpace(b, 10, 'E', 400)).toBe(3);
      b.sides[1].width = 20;
      expect(nonMsbReqdOpenSpace(b, 10, 'E', 400)).toBe(5); // road 18–24 m
      b.sides[1].width = 40;
      expect(nonMsbReqdOpenSpace(b, 17, 'E', 3000)).toBe(7.5); // road > 30 m
      expect(nonMsbReqdOpenSpace(b, 13, 'E', 400)).toBe(-1); // > 12 m not permissible on 300–500 sq.m
    });

    it('other sides: depends on plot area and height', () => {
      const b = blk(10);
      expect(nonMsbReqdOpenSpace(b, 7, 'N', 50)).toBe(0);
      expect(nonMsbReqdOpenSpace(b, 10, 'N', 100)).toBe(0.5);
      expect(nonMsbReqdOpenSpace(b, 12, 'N', 700)).toBe(3);
      expect(nonMsbReqdOpenSpace(b, 15, 'N', 900)).toBe(4);
      expect(nonMsbReqdOpenSpace(b, 16, 'N', 2000)).toBe(6);
      expect(nonMsbReqdOpenSpace(b, 17, 'N', 5000)).toBe(7);
      expect(nonMsbReqdOpenSpace(b, 8, 'N', 150)).toBe(1);
      expect(nonMsbReqdOpenSpace(b, 11, 'N', 150)).toBe(-1);
    });

    it('15–18 m buildings on plots of 1000 sq.m or more need a 12 m front road (-2)', () => {
      const b = blk(16);
      b.sides[1].width = 9;
      expect(nonMsbReqdOpenSpace(b, 16, 'N', 1200)).toBe(-2);
      b.sides[1].width = 12;
      expect(nonMsbReqdOpenSpace(b, 16, 'N', 1200)).toBe(6);
      expect(openSpaceMessage(-2)).toMatch(/12 m/);
      expect(openSpaceMessage(-1)).toMatch(/not permissible/);
      expect(openSpaceMessage(3)).toBeNull();
    });

    it('18 m and above: the MSB table, then +0.5 m per additional 5 m beyond 55 m', () => {
      expect(msbReqdOpenSpace(18)).toBe(7);
      expect(msbReqdOpenSpace(21.5)).toBe(8);
      expect(msbReqdOpenSpace(27)).toBe(9);
      expect(msbReqdOpenSpace(35)).toBe(11);
      expect(msbReqdOpenSpace(50)).toBe(14);
      expect(msbReqdOpenSpace(55)).toBe(16);
      expect(msbReqdOpenSpace(60)).toBe(16.5);
      expect(msbReqdOpenSpace(62)).toBe(17); // 0.7 → rounded up to 1.0
      expect(msbReqdOpenSpace(70)).toBe(17.5);
      expect(msbReqdOpenSpace(100)).toBe(20.5);
    });

    it('combines the rules for a block side (tower / podium / road widening / multiplex / miniplex)', () => {
      expect(reqdOpenSpace(blk(24), 'N', 5000, 'P', '')).toBe(8);
      expect(reqdOpenSpace(blk(12), 'N', 600, 'P', '')).toBe(3);
      expect(reqdOpenSpace(blk(40, { block_type: 'T' }), 'N', 5000, 'P', '')).toBe(3);
      expect(reqdOpenSpace(blk(40, { block_type: 'P' }), 'N', 5000, 'P', '')).toBe(7);
      const rw = blk(24, { road_wide: true, roadwidening: [{ rw_direc: 'N', rw_reqd: 5.5 }] });
      expect(reqdOpenSpace(rw, 'N', 5000, 'P', '')).toBe(5.5);
      expect(reqdOpenSpace(rw, 'S', 5000, 'P', '')).toBe(8);
      const mx = blk(20, { is_multiplex: true });
      expect(reqdOpenSpace(mx, 'E', 5000, 'P', '')).toBe(12); // front
      expect(reqdOpenSpace(mx, 'N', 5000, 'P', '')).toBe(7);
      expect(reqdOpenSpace(blk(45, { is_multiplex: true }), 'N', 5000, 'P', '')).toBe(13);
      expect(reqdOpenSpace(blk(60, { is_multiplex: true }), 'E', 5000, 'P', '')).toBe(15);
      expect(reqdOpenSpace(blk(60, { is_multiplex: true }), 'N', 5000, 'P', '')).toBe(16);
      expect(reqdOpenSpace(blk(9, { is_miniplex: true }), 'N', 5000, 'P', '')).toBe(3);
    });
  });

  it('describes the floors of a block (Common_FloorDisplay)', () => {
    expect(floorDisplay({ floors: [floor('B', 1, 'PAR'), floor('B', 1, 'PAR'), floor('S', 1, 'PAR'), floor('F', 1, 'RES'), floor('F', 1, 'RES')] })).toBe(
      '2 Basements + Stilt + 2 Upper Floors',
    );
    expect(floorDisplay({ floors: [floor('G', 1, 'RES'), floor('F', 1, 'RES')] })).toBe('Ground Floor + One Upper Floor');
  });

  it('compares with the parent Provisional NOC values (the _O functions)', () => {
    const floors = [
      floor('F', 1000, 'RES', 70, { parent_built_area: 1250, parent_occ_c_app: 90 }),
      floor('F', 800, 'ASM1', 0, { parent_built_area: 650, parent_occ_c_app: 10 }),
    ];
    expect(t20OccCountO(floors[0])).toBe(100); // 1250 / 12.5
    expect(t20OccCountO(floors[1])).toBe(1000); // ASM1 on the parent area: 650 / 0.65
    expect(blockBuiltUpO({ floors })).toBe(1900);
    expect(blockTotalOccLoadO({ floors })).toBe(100);
    expect(blockTotalNbcOccLoadO({ floors })).toBe(1100);
    const b = blk(10);
    b.ospaces = [{ ospace_id: 1, direc: 'N', proposed: 3, parent_proposed: 3.5 }];
    expect(proposedOpenSpace(b, 'N')).toBe(3);
    expect(proposedOpenSpaceO(b, 'N')).toBe(3.5);
  });

  it('ports the remaining helpers (front road, stair count, floor name, required equipment)', () => {
    expect(frontAbutting(blk(10))).toBe(12);
    expect(stairCount({ floors: [floor('G', 100, 'RES')] })).toBe(0);
    expect(stairCount({ floors: [floor('S', 100, 'PAR'), floor('G', 100, 'RES')] })).toBe(1);
    const b = blk(10);
    b.floors = [{ ...floor('G', 100, 'RES'), floor_id: 7, flr_name: 'Ground' }];
    expect(floorDesc(b, 7)).toBe('Ground');
    b.ffe = {
      notes: [],
      agree_reqt: false,
      items: [
        { equip_id: 2, level: 'F', floors: { '7': { reqt: 3, prop: null, prov: null }, '8': { reqt: 2, prop: null, prov: null } }, block: { reqt: null, prop: null, prov: null }, note_keys: [] },
        { equip_id: 7, level: 'B', floors: {}, block: { reqt: 'Note 10', prop: null, prov: null }, note_keys: ['Note 10'] },
      ],
    };
    expect(requiredEquip(b, 2)).toBe(5);
    expect(requiredEquip(b, 7)).toBe('Note 10');
    expect(requiredEquip(b, 12)).toBe('-');
  });
});
