/**
 * Port of NOC-base/script/commonrules.js (plus the escape/stair helpers that lived in
 * citizen/controllers/blockController.js and confirmController.js).
 *
 * Function names map 1:1 to the legacy `Common_*` functions (noted above each) and the
 * numeric tables are kept verbatim. Deliberate deviations are marked "LEGACY BUG FIXED".
 */
import { Block, Floor } from './models/index.js';

type FloorLike = Pick<Floor, 'flr_type' | 'built_area' | 'occ_type' | 'occ_c_app'> & Partial<Pick<Floor, 'seats_num' | 'parent_built_area' | 'parent_occ_c_app'>>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const prefix = (occ: string | undefined, len: number): string => (occ ?? '').substring(0, len).toUpperCase();
const isUpperFloor = (f: Pick<Floor, 'flr_type'>) => f.flr_type === 'F' || f.flr_type === 'G';

// ---------------------------------------------------------------------------
// Occupant load — NBC Table 20 (Common_t20OccCount / Common_t20OccCount_O)
// ---------------------------------------------------------------------------

/** Area per person (sq.m) by floor occupancy code; null = computed differently / not applicable. */
const T20_AREA_PER_PERSON: [string, number][] = [
  ['RES', 12.5],
  ['EDU1', 4],
  ['EDU2', 12.5],
  ['INS1', 10],
  ['INS2', 15],
  ['ASM3', 0.65],
  ['ASM4', 1.4],
  ['ASM5', 1.8],
  ['MER1', 3],
  ['MER2', 6],
  ['MER3', 20],
  ['BIZ', 10],
  ['IND', 10],
  ['STO', 30],
  ['HAZ', 10],
];

function t20Factor(occ: string): number | null {
  for (const [code, area] of T20_AREA_PER_PERSON) {
    if (prefix(occ, code.length) === code) return area;
  }
  return null;
}

/** Common_t20OccCount — number of occupants as per NBC Table 20 for a floor. */
export function t20OccCount(floor: FloorLike): number {
  if ((floor.occ_type ?? '').length < 3) return 0;
  if (prefix(floor.occ_type, 4) === 'ASM1') return Math.floor(num(floor.seats_num) * 1.2);
  const factor = t20Factor(floor.occ_type);
  return factor ? Math.floor(num(floor.built_area) / factor) : 0; // PAR and others: 0
}

/** Common_t20OccCount_O — same on the parent (Provisional) built-up area. */
export function t20OccCountO(floor: FloorLike): number {
  if ((floor.occ_type ?? '').length < 3) return 0;
  const area = num(floor.parent_built_area);
  if (prefix(floor.occ_type, 4) === 'ASM1') return Math.floor(area / 0.65);
  if (prefix(floor.occ_type, 4) === 'ASM2') return Math.floor(area / 1.2);
  const factor = t20Factor(floor.occ_type);
  return factor ? Math.floor(area / factor) : 0;
}

/** Common_LoadPerUnitExit — occupants per unit exit width. */
export function loadPerUnitExit(floor: Pick<Floor, 'occ_type'>): number {
  const occ = floor.occ_type ?? '';
  if (occ.length < 3) return 0;
  const p3 = prefix(occ, 3);
  const p4 = prefix(occ, 4);
  if (p3 === 'RES' || p3 === 'EDU' || p4 === 'INS1' || p4 === 'INS2') return 25;
  if (p4 === 'ASM1' || p4 === 'ASM2') return 40;
  if (p4 === 'MER1' || p4 === 'MER2' || p3 === 'BIZ' || p3 === 'IND' || p3 === 'STO') return 50;
  if (p3 === 'HAZ') return 25;
  return 0;
}

// ---------------------------------------------------------------------------
// Staircases (Common_StairsbyLoad, Common_MaxStairsbyLoad, Common_TotalStairsRequiredByNBC …)
// ---------------------------------------------------------------------------

/**
 * Common_StairsbyLoad — aggregate staircase width required (m) for a floor from its declared
 * occupants: occupants × width-per-person (mm) / 1000. Returns null for non G/F floors.
 * LEGACY BUG FIXED: the legacy truncated occ_type to 3 chars and then tested `length >= 4` for INS,
 * so institutional floors always returned 0; here INS uses its 15 mm/person factor as intended.
 */
export function stairsByLoad(floor: FloorLike): number | null {
  if (!isUpperFloor(floor)) return null;
  const occ = prefix(floor.occ_type, 3);
  let stairwidth: number;
  if (['RES', 'EDU', 'ASM', 'MER', 'BIZ', 'IND', 'STO'].includes(occ)) stairwidth = 10;
  else if (occ === 'INS') stairwidth = 15;
  else if (occ === 'HAZ') stairwidth = 18;
  else return 0;
  return Math.floor((num(floor.occ_c_app) * stairwidth) / 1000);
}

function stiltAndFloorCount(block: Pick<Block, 'floors'>): { hasStilt: boolean; flrCount: number } {
  return {
    hasStilt: block.floors.some((f) => f.flr_type === 'S'),
    flrCount: block.floors.filter(isUpperFloor).length,
  };
}

function isMultiStorey(block: Pick<Block, 'floors'>): boolean {
  const { hasStilt, flrCount } = stiltAndFloorCount(block);
  return flrCount > 1 || (flrCount === 1 && hasStilt);
}

/** Common_MaxStairsbyLoad — max aggregate staircase width required over the upper floors. */
export function maxStairsByLoad(block: Pick<Block, 'floors'>): number {
  if (!isMultiStorey(block)) return 0;
  const { hasStilt } = stiltAndFloorCount(block);
  let max = 0;
  for (const f of block.floors) {
    if (f.flr_type === 'F' || (f.flr_type === 'G' && hasStilt)) {
      max = Math.max(max, stairsByLoad(f) ?? 0);
    }
  }
  return max;
}

/** Common_Maximum_Floor_Area — largest G/F floor (optionally including basements/stilts). */
export function maximumFloorArea(block: Pick<Block, 'floors'>, includeBasementStilt = false): number {
  return block.floors.reduce((max, f) => (isUpperFloor(f) || includeBasementStilt ? Math.max(max, num(f.built_area)) : max), 0);
}

/** Common_TotalStairsRequiredByNBC — 1 staircase up to 500 sq.m max floor area, else 2 (multi-storey only). */
export function totalStairsRequiredByNBC(block: Pick<Block, 'floors'>): number {
  if (!isMultiStorey(block)) return 0;
  return maximumFloorArea(block, false) <= 500 ? 1 : 2;
}

/** Common_Stair_Count */
export function stairCount(block: Pick<Block, 'floors'>): number {
  return isMultiStorey(block) ? 1 : 0;
}

/** MaxOccuCount (blockController / confirmController) — max declared occupants on a G/F floor. */
export function maxOccuCount(block: Pick<Block, 'floors'>): number {
  return block.floors.reduce((max, f) => (isUpperFloor(f) ? Math.max(max, num(f.occ_c_app)) : max), 0);
}

/** reqd_escape_count (confirmController) — internal/external staircases required by max floor area. */
export function reqdEscapeCount(block: Pick<Block, 'floors'>, stype: string): number {
  const maxCnt = Math.floor(maximumFloorArea(block) / 1000);
  if (stype === 'I') return maxCnt <= 1 ? 1 : 1 + Math.ceil((maxCnt - 1) / 2);
  if (stype === 'E') return maxCnt <= 1 ? 1 : 1 + Math.floor((maxCnt - 1) / 2);
  return 0;
}

/** proposed_escape_count (confirmController) */
export function proposedEscapeCount(block: Pick<Block, 'escapes'>, stype: string): number {
  return block.escapes.filter((e) => e.etype === stype).length;
}

/** proposed_escape_width (confirmController) — average proposed width of escapes of a type. */
export function proposedEscapeWidth(block: Pick<Block, 'escapes'>, stype: string): number {
  const list = block.escapes.filter((e) => e.etype === stype);
  return list.length ? list.reduce((s, e) => s + num(e.width), 0) / list.length : 0;
}

/** aggregate_staircase (blockController) — total width of internal + external staircases. */
export function aggregateStaircase(block: Pick<Block, 'escapes'>): number {
  return block.escapes.filter((e) => e.etype === 'I' || e.etype === 'E').reduce((s, e) => s + num(e.width), 0);
}

/**
 * Aggregate width of staircases serving a floor (legacy floor.esc_width, computed server-side):
 * internal/external staircases whose from/to floor range includes the floor (no range = all floors).
 */
export function floorEscapeWidth(block: Pick<Block, 'floors' | 'escapes'>, floorId: number): number {
  const order = block.floors.map((f) => f.floor_id);
  const idx = order.indexOf(floorId);
  return block.escapes
    .filter((e) => e.etype === 'I' || e.etype === 'E')
    .filter((e) => {
      if (!e.from_floor || !e.to_floor) return true;
      const a = order.indexOf(e.from_floor);
      const b = order.indexOf(e.to_floor);
      if (a < 0 || b < 0) return true;
      return idx >= Math.min(a, b) && idx <= Math.max(a, b);
    })
    .reduce((s, e) => s + num(e.width), 0);
}

/**
 * Common_reqd_escape_width — minimum width (m) of an escape of a type (NBC 2016 values; the legacy
 * NBC 2005 branch is not migrated). Returns a string because basement ramps are "1-Way: 3.6 / 2-Way:5.4".
 */
export function reqdEscapeWidth(stype: string, siteType: string, siteStype: string, maxOcount: number): string {
  const t = (siteType ?? '').toUpperCase();
  const st = (siteStype ?? '').toUpperCase();
  if (stype.toUpperCase() === 'I') {
    if (t === 'INS') return '2.0';
    if (t === 'RES') {
      if (st === 'A2') return '1.0';
      if (st === 'A1' || st === 'A3' || st === 'A4') return '1.25';
      return '1.5';
    }
    if (t === 'ASM') return maxOcount < 150 ? '1.5' : '2.0';
    return '1.5';
  }
  if (stype === 'E') return '1.5';
  if (stype === 'R') return '2.0';
  if (stype === 'C') return '1-Way: 3.6 / 2-Way:5.4';
  return '0';
}

/** Numeric minimum for validation (basement ramps: the 1-way minimum 3.6 m). */
export function reqdEscapeWidthValue(stype: string, siteType: string, siteStype: string, maxOcount: number): number {
  const v = reqdEscapeWidth(stype, siteType, siteStype, maxOcount);
  return stype === 'C' ? 3.6 : num(v);
}

/** Common_DoorWidthRequired */
export function doorWidthRequired(block: Pick<Block, 'site_type'>): number {
  return block.site_type === 'asm' ? 2 : 1;
}

/** Common_Fire_Lifts_Reqd — from 15 m: one per 1200 sq.m of the largest floor (rounded). */
export function fireLiftsReqd(block: Pick<Block, 'height' | 'floors'>): number {
  if (num(block.height) >= 15) return Math.round(maximumFloorArea(block, false) / 1200);
  return 0;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Common_Block_TotalOccLoad — occupants declared by the builder. */
export function blockTotalOccLoad(block: Pick<Block, 'floors'>): number {
  return round2(block.floors.reduce((s, f) => s + num(f.occ_c_app), 0));
}

/** Common_Block_TotalNBCOccLoad — occupants as per NBC Table 20. */
export function blockTotalNbcOccLoad(block: Pick<Block, 'floors'>): number {
  return round2(block.floors.reduce((s, f) => s + Math.round(t20OccCount(f)), 0));
}

/** Common_Block_Built_Up */
export function blockBuiltUp(block: Pick<Block, 'floors'>): number {
  return round2(block.floors.reduce((s, f) => s + num(f.built_area), 0));
}

/** Common_Block_Built_Up_O */
export function blockBuiltUpO(block: Pick<Block, 'floors'>): number {
  return round2(block.floors.reduce((s, f) => s + num(f.parent_built_area), 0));
}

/** Common_Block_TotalOccLoad_O */
export function blockTotalOccLoadO(block: Pick<Block, 'floors'>): number {
  return round2(block.floors.reduce((s, f) => s + num(f.parent_occ_c_app), 0));
}

/** Common_Block_TotalNBCOccLoad_O */
export function blockTotalNbcOccLoadO(block: Pick<Block, 'floors'>): number {
  return round2(block.floors.reduce((s, f) => s + Math.round(t20OccCountO(f)), 0));
}

// ---------------------------------------------------------------------------
// Open spaces (Common_Front_Abutting, Common_NonMSB_Reqd_Open_Space, Common_reqd_open_space)
// ---------------------------------------------------------------------------

type OpenSpaceBlock = Pick<
  Block,
  'front_dir' | 'sides' | 'height' | 'permissible_height' | 'block_type' | 'is_multiplex' | 'is_miniplex' | 'road_wide' | 'roadwidening' | 'ospaces'
>;

/** Common_Front_Abutting — width of the road on the front side of the block. */
export function frontAbutting(block: Pick<Block, 'sides' | 'front_dir'>): number {
  let retVal = 0;
  for (const s of block.sides) {
    if (s.direc === block.front_dir) retVal = num(s.width);
  }
  return retVal;
}

/**
 * Height used for open-space requirements: the permissible height for a Provisional NOC and for an
 * Occupancy NOC carried from one (mode != 'N'), otherwise the actual height.
 */
export function openSpaceCheckHeight(block: Pick<Block, 'height' | 'permissible_height'>, applType: string, applMode: string): number {
  return applType === 'P' || (applType === 'O' && applMode !== 'N') ? num(block.permissible_height) : num(block.height);
}

/**
 * Common_NonMSB_Reqd_Open_Space — G.O.Ms.No.119 Table for buildings below 18 m.
 * Returns -1 when the height is not permissible for the plot area (Table 17) and
 * -2 when the front abutting road is narrower than the 12 m required for 15–18 m buildings on plots ≥ 1000 sq.m.
 */
export function nonMsbReqdOpenSpace(block: Pick<Block, 'sides' | 'front_dir'>, checkHeight: number, direc: string, area: number): number {
  let reqd = -1;
  let minabtwidth = false;
  const h = checkHeight;
  if (block.front_dir === '' || direc === block.front_dir) {
    const abutting = frontAbutting(block);
    if (h > 15 && h < 18 && area >= 1000) minabtwidth = true;
    const byAbutting = (a: number, b: number, c: number, d: number, e: number) =>
      abutting <= 12 ? a : abutting <= 18 ? b : abutting <= 24 ? c : abutting <= 30 ? d : e;
    if (area <= 200) {
      reqd = byAbutting(1.5, 1.5, 3, 3, 3);
    } else if (area > 200 && area <= 300) {
      if (h <= 7) reqd = byAbutting(2, 3, 3, 4, 5);
      else if (h > 7 && h <= 10) reqd = byAbutting(2, 3, 3, 5, 6);
    } else if (area > 300 && area <= 500) {
      if (h <= 12) reqd = byAbutting(3, 4, 5, 6, 7.5);
    } else if (area > 500 && area <= 1000) {
      if (h <= 15) reqd = byAbutting(3, 4, 5, 6, 7.5);
    } else if (area > 1000) {
      // 1000-1500, 1500-2500 and > 2500 share the same front table up to 18 m
      if (h <= 18) reqd = byAbutting(3, 4, 5, 6, 7.5);
    }
    void minabtwidth; // front side does not use the 12 m abutting check
  } else if (area > 0) {
    const abutting = frontAbutting(block);
    if (h > 15 && h < 18 && area >= 1000) minabtwidth = true;
    if (area <= 50) {
      if (h <= 7) reqd = 0;
    } else if (area <= 100) {
      if (h <= 7) reqd = 0;
      else if (h <= 10) reqd = 0.5;
    } else if (area <= 200) {
      if (h <= 10) reqd = 1;
    } else if (area <= 300) {
      if (h <= 7) reqd = 1;
      else if (h <= 10) reqd = 1.5;
    } else if (area <= 400) {
      if (h <= 7) reqd = 1.5;
      else if (h <= 12) reqd = 2;
    } else if (area <= 500) {
      if (h <= 7) reqd = 2;
      else if (h <= 12) reqd = 2.5;
    } else if (area <= 750) {
      if (h <= 7) reqd = 2.5;
      else if (h <= 12) reqd = 3;
      else if (h <= 15) reqd = 3.5;
    } else if (area <= 1000) {
      if (h <= 7) reqd = 3;
      else if (h <= 12) reqd = 3.5;
      else if (h <= 15) reqd = 4;
    } else if (area <= 1500) {
      if (minabtwidth && abutting < 12) reqd = -2;
      else if (h <= 7) reqd = 3.5;
      else if (h <= 12) reqd = 4;
      else if (h <= 15) reqd = 5;
      else if (h <= 18) reqd = 6;
    } else if (area <= 2500) {
      if (minabtwidth && abutting < 12) reqd = -2;
      else if (h <= 7) reqd = 4;
      else if (h <= 15) reqd = 5;
      else if (h <= 18) reqd = 6;
    } else {
      if (minabtwidth && abutting < 12) reqd = -2;
      else if (h <= 7) reqd = 5;
      else if (h <= 15) reqd = 6;
      else if (h <= 18) reqd = 7;
    }
  }
  return reqd;
}

/** G.O.Ms.No.119 table for buildings of 18 m and above, with the formula beyond 55 m. */
export function msbReqdOpenSpace(checkHeight: number): number {
  const h = checkHeight;
  if (h >= 18 && h <= 21) return 7;
  if (h > 21 && h <= 24) return 8;
  if (h > 24 && h <= 27) return 9;
  if (h > 27 && h <= 30) return 10;
  if (h > 30 && h <= 35) return 11;
  if (h > 35 && h <= 40) return 12;
  if (h > 40 && h <= 45) return 13;
  if (h > 45 && h <= 50) return 14;
  if (h > 50 && h <= 55) return 16;
  // Beyond 55 m: 16 m + 0.5 m for every additional 5 m (rounded up to the next 0.5 m)
  return 16 + Math.ceil((((h - 55) / 5) * 0.5) * 2) / 2;
}

/**
 * Common_reqd_open_space — required open space (m) on side `direc` of a block.
 * Negative results: -1 = height not permissible for the plot area (Table 17), -2 = front road < 12 m.
 */
export function reqdOpenSpace(block: OpenSpaceBlock, direc: string, plotArea: number, applType: string, applMode: string): number {
  let reqd = 7;
  const area = num(plotArea);
  const checkHeight = openSpaceCheckHeight(block, applType, applMode);
  const multiplex = !!block.is_multiplex;
  const miniplex = !!block.is_miniplex;

  // Legacy condition `is_multiplex == false || is_miniplex == false` (true unless both are set).
  if (!multiplex || !miniplex) {
    if (block.block_type === 'T') reqd = 3;
    else if (block.block_type === 'P') reqd = 7;
    else if (checkHeight < 18) reqd = nonMsbReqdOpenSpace(block, checkHeight, direc, area);
    else reqd = msbReqdOpenSpace(checkHeight);

    if (block.road_wide) {
      const rw = (block.roadwidening ?? []).find((r) => r.rw_direc === direc);
      if (rw) reqd = num(rw.rw_reqd);
    }
  }

  if (multiplex) {
    const h = num(block.height);
    const isFront = block.front_dir === '' || direc === block.front_dir;
    if (h <= 40) {
      if (direc === '' || isFront) return 12;
      if (h <= 15) return 6;
      if (h <= 21) return 7;
      if (h <= 24) return 8;
      if (h <= 27) return 9;
      if (h <= 30) return 10;
      if (h <= 35) return 11;
      return 12;
    }
    if (h <= 45) return 13;
    if (h <= 50) return 14;
    return isFront ? 15 : 16;
  }
  if (miniplex) return 3;
  return reqd;
}

/** Common_proposed_open_space */
export function proposedOpenSpace(block: Pick<Block, 'ospaces'>, direc: string): number {
  return num(block.ospaces.find((o) => o.direc === direc)?.proposed);
}

/** Common_proposed_open_space_O */
export function proposedOpenSpaceO(block: Pick<Block, 'ospaces'>, direc: string): number {
  return num(block.ospaces.find((o) => o.direc === direc)?.parent_proposed);
}

export function openSpaceMessage(reqd: number): string | null {
  if (reqd === -1) return 'The height of the building is not permissible for the given site/plot area as per Table 17.';
  if (reqd === -2) return 'The front abutting road must be at least 12 m wide for this plot area and height.';
  return null;
}

// ---------------------------------------------------------------------------
// Names and descriptions
// ---------------------------------------------------------------------------

/** Common_Floor_Type_Name */
export function floorTypeName(type: string): string {
  return ({ B: 'Basement / Cellar', S: 'Stilt', G: 'Ground', F: 'Floor', T: 'Terrace' } as Record<string, string>)[type] ?? type;
}

/** Common_Floor_Occu_Name */
export function floorOccuName(occu: string): string {
  const names: Record<string, string> = {
    PAR: 'Parking',
    RES: 'Residential',
    EDU1: 'Educational',
    EDU2: 'Educational - Engineering and Technology',
    INS1: 'Institutional without Dormitory',
    INS2: 'Institutional with Dormitory',
    ASM1: 'Assembly with fixed seats',
    ASM2: 'Assembly without seating facility',
    ASM3: 'Concentrated use without fixed seating',
    ASM4: 'Less concentrated use without fixed seating',
    ASM5: 'Dining areas & restaurants with seating & table',
    ASM6: 'Assembly - Mixed',
    MER1: 'Mercantile - Street floor and Sale Basement',
    MER2: 'Mercantile - Upper Sale floors',
    MER3: 'Mercantile - Storage / Warehouse',
    BIZ: 'Business',
    IND: 'Industrial',
    STO: 'Storage',
    MLCP: 'Storage - Multilevel Car parking',
    HAZ: 'Hazardous',
    OTH: 'Other Non-Occupanices',
  };
  return names[occu] ?? occu;
}

/** Common_FloorDisplay — e.g. "2 Basements + Stilt + 9 Upper Floors". */
export function floorDisplay(block: Pick<Block, 'floors'>): string {
  const count = (t: string) => block.floors.filter((f) => num(f.built_area) > 0 && f.flr_type === t).length;
  const bc = count('B');
  const sc = count('S');
  const gc = count('G');
  const fc = count('F');
  let r = '';
  if (bc === 1) r += 'Basement ';
  else if (bc > 1) r += `${bc} Basements `;
  if (r !== '' && sc > 0) r += '+ ';
  if (sc === 1) r += 'Stilt ';
  else if (sc > 1) r += `${sc} Stilts `;
  if (r !== '' && gc > 0) r += '+ ';
  if (gc === 1) r += 'Ground Floor ';
  else if (gc > 1) r += `${gc} Ground Floors `;
  if (r !== '' && fc > 0) r += '+ ';
  if (fc === 1) r += 'One Upper Floor ';
  else if (fc > 1) r += `${fc} Upper Floors `;
  return r.trim();
}

/** Common_FloorDesc — name of a floor of the block by id. */
export function floorDesc(block: Pick<Block, 'floors'>, floorId: number): string {
  return block.floors.find((f) => f.floor_id === floorId)?.flr_name ?? '';
}

/**
 * Common_Required_Equip — required quantity of an equipment type for the block ("-" when not required):
 * the building-level value, or the cumulative floor-wise total (numeric cells) / the note reference.
 */
export function requiredEquip(block: Pick<Block, 'ffe'>, equipId: number): number | string {
  const item = block.ffe?.items.find((i) => i.equip_id === equipId);
  if (!item) return '-';
  if (item.level === 'B') return item.block.reqt ?? '-';
  const cells = Object.values(item.floors).map((c) => c.reqt).filter((v) => v !== null && v !== undefined);
  if (!cells.length) return '-';
  const numeric = cells.filter((v): v is number => typeof v === 'number');
  return numeric.length ? numeric.reduce((a, b) => a + b, 0) : String(cells[0]);
}

/** Common_Direction_Name */
export function directionName(direc: string): string {
  return (
    ({ E: 'East', W: 'West', N: 'North', S: 'South', NE: 'North East', NW: 'North West', SE: 'South East', SW: 'South West', C: 'Center' } as Record<string, string>)[direc] ?? direc
  );
}

/** Common_Stair_Type_Name */
export function stairTypeName(type: string): string {
  return ({ I: 'Internal Staircase', E: 'External Staircase', R: 'Ramp (above Ground)', C: 'Basement Ramp' } as Record<string, string>)[type] ?? type;
}

// ---------------------------------------------------------------------------
// Travel distance (Common_Maximum_Travel_Distance / _DeadEnd — "not using" in legacy JS,
// the limits were rendered from the server as td_dist_reqd / td_dist_de_reqd) and refuge areas.
// ---------------------------------------------------------------------------

export interface TravelDistanceRules {
  travel_distance: { default: number; by_site_type: Record<string, number> };
  dead_end: { default: number; by_site_type: Record<string, number> };
  sprinklered_factor: number;
}

/** Maximum travel distance to a staircase; ×1.5 when the building is fully sprinklered. */
export function maxTravelDistance(block: Pick<Block, 'site_type'>, rules: TravelDistanceRules, sprinklered = false): number {
  const base = rules.travel_distance.by_site_type[block.site_type] ?? rules.travel_distance.default;
  return sprinklered ? base * rules.sprinklered_factor : base;
}

export function maxDeadEndDistance(block: Pick<Block, 'site_type'>, rules: TravelDistanceRules, sprinklered = false): number {
  const base = rules.dead_end.by_site_type[block.site_type] ?? rules.dead_end.default;
  return sprinklered ? base * rules.sprinklered_factor : base;
}

/**
 * Refuge area required on a floor (NBC 2016 Part 4, 4.4.2.6, and the conditions in noc_terms_16):
 * 0.3 sq.m per person for the occupants (Table 20) of two consecutive floors, minimum 15 sq.m.
 * (Legacy computed refuge.reqd_area server-side.)
 */
export function refugeAreaRequired(block: Pick<Block, 'floors'>, floorId: number, perPerson: number, minArea: number): number {
  const idx = block.floors.findIndex((f) => f.floor_id === floorId);
  if (idx < 0) return minArea;
  const occupants = t20OccCount(block.floors[idx]) + (block.floors[idx + 1] ? t20OccCount(block.floors[idx + 1]) : 0);
  return Math.max(minArea, Math.round(occupants * perPerson * 100) / 100);
}
