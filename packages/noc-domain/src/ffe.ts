/**
 * Fire Fighting Equipment (FFE) calculation — replaces the legacy server-side
 * calculateffe.aspx / floorwise_ffe.aspx, driven by the verbatim rule trees from
 * NOC-base/uploads/rules/{equipment id}.rule (served as assets/data/rules/ffe/{id}.json).
 *
 * Presentation model mirrors the legacy editpnoc_3 / editonoc_3 screens:
 *  - floor-wise items (Equipments.txt level "F") are evaluated once per floor and the block
 *    requirement is the cumulative total of the floor values;
 *  - building-level items (level "B") are evaluated once per block (the legacy "Total" row).
 *
 * Rule variables (@name) — legacy names, derived from the block/application:
 *   site_type, site_stype, height      block occupancy and height
 *   floors       number of upper floors (flr_type 'F') — "ground + N"
 *   maxarea      largest ground/upper floor built-up area (Common_Maximum_Floor_Area)
 *   cov_area     covered (ground) area: largest ground/stilt floor, else maxarea
 *   base_area    largest basement/cellar floor area (0 when none)
 *   built_area   total built-up area of the block
 *   plot_area    plot area of the application
 *   beds         'Y'/'N' — hospital with in-patient beds (block.beds)
 *   occ_load     total occupants declared (Common_Block_TotalOccLoad)
 *   exit_count   number of internal + external staircases (min 1)
 *   is_multiplex 1/0
 *   floor_area, flr_type   the floor being evaluated (floor-wise items); maxarea / '' at block level
 *
 * Return values:
 *   ''                 not required
 *   '<number>'         quantity (litres for tanks, LPM for booster pumps …)
 *   'D,<var>,<n>'      ceil(var / n)   e.g. 'D,floor_area,200' = one per 200 sq.m
 *   '<var name>'       value of that variable (4.rule returns 'exit_count')
 *   note key(s)        'Note 10', 'Note 12|Note 13', 'UT_A5', 'UG_240', 'FP_A5' → requirement stated by the note
 *   Yard hydrants (8)  a number = spacing in metres along the perimeter → ceil(perimeter / spacing), note YH_<n>
 */
import {
  ApplTypeFfeColumn,
  ApplicationType,
  Block,
  BlockFfe,
  Equipment,
  FfeCell,
  FfeItem,
  FfeNotes,
  FfeRuleSet,
} from './models/index.js';
import { blockTotalOccLoad, maximumFloorArea } from './commonrules.js';
import { RuleVars, evaluateRule } from './rule-engine.js';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Equipment whose numeric rule result is a spacing along the plot perimeter (yard hydrants). */
const SPACING_ITEMS: Record<number, string> = { 8: 'YH_' };
/** Equipment ids that the riser-width rule applies to (down comer, wet riser). */
const RISER_ITEMS = [9, 10];
/** Equipment id that the extinguisher-type rule applies to. */
const EXTINGUISHER_ITEM = 2;

export function blockRuleVars(block: Block, plotArea: number): RuleVars {
  const upper = block.floors.filter((f) => f.flr_type === 'F');
  const ground = block.floors.filter((f) => f.flr_type === 'G' || f.flr_type === 'S');
  const basements = block.floors.filter((f) => f.flr_type === 'B');
  const maxarea = maximumFloorArea(block, false);
  const staircases = block.escapes.filter((e) => e.etype === 'I' || e.etype === 'E').length;
  return {
    site_type: block.site_type,
    site_stype: block.site_stype,
    height: num(block.height),
    floors: upper.length,
    maxarea,
    cov_area: ground.length ? Math.max(...ground.map((f) => num(f.built_area))) : maxarea,
    base_area: basements.length ? Math.max(...basements.map((f) => num(f.built_area))) : 0,
    built_area: block.floors.reduce((s, f) => s + num(f.built_area), 0),
    plot_area: num(plotArea),
    beds: block.beds || 'N',
    occ_load: blockTotalOccLoad(block),
    exit_count: Math.max(1, staircases),
    is_multiplex: block.is_multiplex ? 1 : 0,
    floor_area: maxarea,
    flr_type: '',
  };
}

export interface InterpretedValue {
  reqt: number | string | null;
  notes: string[];
}

const NOTE_PATTERN = /^(note\s*\d+|ut_\w+|ug_\w+|fp_\w+|yh_\w+|riser_\w+|[ab]_[a-z]h)$/i;

/** Normalises note keys to the FFE_Notes.txt spelling ("note 12" → "Note 12"). */
export function normaliseNoteKey(key: string): string {
  const k = key.trim();
  const m = /^note\s*(\d+)$/i.exec(k);
  return m ? `Note ${m[1]}` : k;
}

/** Interprets a rule return value for one equipment item. */
export function interpretRuleValue(value: string, vars: RuleVars, equipId: number, perimeter: number): InterpretedValue {
  const v = (value ?? '').trim().replace(/,+$/, '');
  if (v === '') return { reqt: null, notes: [] };
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    const spacingPrefix = SPACING_ITEMS[equipId];
    if (spacingPrefix) {
      return { reqt: Math.max(1, Math.ceil(num(perimeter) / n)), notes: [`${spacingPrefix}${v}`] };
    }
    return { reqt: n, notes: [] };
  }
  if (v.startsWith('D,')) {
    const [, varName, divisor] = v.split(',');
    const base = num(vars[varName?.trim()]);
    const d = num(divisor);
    if (base <= 0 || d <= 0) return { reqt: null, notes: [] };
    return { reqt: Math.ceil(base / d), notes: [] };
  }
  if (v in vars) {
    const n = num(vars[v]);
    return { reqt: n > 0 ? n : null, notes: [] };
  }
  const keys = v.split('|').map(normaliseNoteKey).filter(Boolean);
  return { reqt: keys.join(', '), notes: keys };
}

const emptyCell = (): FfeCell => ({ reqt: null, prop: null, prov: null });

/** Parses other_notes.rule results: "Note 7:10,12@Note 14" → scoped + general note keys. */
export function parseOtherNotes(value: string): { general: string[]; scoped: Record<number, string[]> } {
  const general: string[] = [];
  const scoped: Record<number, string[]> = {};
  for (const part of (value ?? '').split('@')) {
    const [rawKey, ids] = part.split(':');
    const key = normaliseNoteKey(rawKey ?? '');
    if (!key || !NOTE_PATTERN.test(key)) continue; // ignore stray formula results ("D,maxarea,1000")
    if (ids) {
      for (const id of ids.split(',').map((x) => Number(x.trim())).filter((x) => x > 0)) {
        (scoped[id] ??= []).push(key);
      }
    } else {
      general.push(key);
    }
  }
  return { general, scoped };
}

/**
 * Computes the FFE grid for a block. Values the applicant already entered (prop / prov / remarks,
 * applicant-added items, the confirmation tick) are preserved for matching equipment/floor cells.
 */
export function computeBlockFfe(
  block: Block,
  plotArea: number,
  perimeter: number,
  rules: FfeRuleSet,
  equipments: Equipment[],
  existing: BlockFfe | undefined = block.ffe,
): BlockFfe {
  const vars = blockRuleVars(block, plotArea);
  const previous = new Map((existing?.items ?? []).map((i) => [i.equip_id, i]));
  const items: FfeItem[] = [];
  const other = parseOtherNotes(evaluateRule(rules.otherNotes, vars).value);

  for (const eq of equipments) {
    const tree = rules.equipment[eq.id];
    const prev = previous.get(eq.id);
    const level: 'F' | 'B' = eq.level === 'F' ? 'F' : 'B';
    const item: FfeItem = { equip_id: eq.id, level, floors: {}, block: emptyCell(), note_keys: [], added: prev?.added, remarks: prev?.remarks ?? '' };
    let required = false;
    const notes = new Set<string>();

    if (tree) {
      if (level === 'F') {
        for (const f of block.floors) {
          if (num(f.built_area) <= 0) continue;
          const fv = { ...vars, floor_area: num(f.built_area), flr_type: f.flr_type };
          const r = interpretRuleValue(evaluateRule(tree, fv).value, fv, eq.id, perimeter);
          const prevCell = prev?.floors[String(f.floor_id)];
          item.floors[String(f.floor_id)] = { reqt: r.reqt, prop: prevCell?.prop ?? null, prov: prevCell?.prov ?? null };
          if (r.reqt !== null) required = true;
          r.notes.forEach((n) => notes.add(n));
        }
      } else {
        const r = interpretRuleValue(evaluateRule(tree, vars).value, vars, eq.id, perimeter);
        item.block = { reqt: r.reqt, prop: prev?.block.prop ?? null, prov: prev?.block.prov ?? null };
        if (r.reqt !== null) required = true;
        r.notes.forEach((n) => notes.add(n));
      }
    }

    if (!required && !prev?.added) continue;
    if (!required && prev?.added) {
      // keep the applicant's own item: copy previous cells for current floors
      if (level === 'F') {
        for (const f of block.floors) {
          const prevCell = prev.floors[String(f.floor_id)];
          item.floors[String(f.floor_id)] = { reqt: null, prop: prevCell?.prop ?? null, prov: prevCell?.prov ?? null };
        }
      } else {
        item.block = { ...emptyCell(), prop: prev.block.prop, prov: prev.block.prov };
      }
    }

    if (eq.id === EXTINGUISHER_ITEM && required) {
      const t = evaluateRule(rules.ffeType, vars).value;
      if (t) notes.add(normaliseNoteKey(t));
    }
    if (RISER_ITEMS.includes(eq.id) && required) {
      const w = evaluateRule(rules.riserWidth, vars).value;
      if (w) notes.add(normaliseNoteKey(w));
    }
    (other.scoped[eq.id] ?? []).forEach((n) => notes.add(n));
    item.note_keys = [...notes];
    items.push(item);
  }

  return { items, notes: other.general, agree_reqt: existing?.agree_reqt ?? false };
}

// ---------------------------------------------------------------------------
// Presentation helpers (mirror GetFFETotal / equipment_suffix of the legacy controllers)
// ---------------------------------------------------------------------------

export type FfeTag = 'reqt' | 'prop' | 'prov';

/** FFE grid columns for an application type/mode (ApplTypes.txt `mode[].ffe[]`). */
export function ffeColumns(types: ApplicationType[], applType: string, applMode: string): ApplTypeFfeColumn[] {
  const type = types.find((t) => t.code === applType);
  const mode = type?.mode.find((m) => m.code === applMode) ?? type?.mode[0];
  return mode?.ffe ?? [];
}

/** GetFFETotal — cumulative total of a floor-wise item for a tag (numeric cells only). */
export function ffeFloorTotal(item: FfeItem, tag: FfeTag): number {
  return Object.values(item.floors).reduce((s, c) => {
    const v = c[tag];
    return typeof v === 'number' ? s + v : s + (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : 0);
  }, 0);
}

/** Block-level value of an item for a tag: the block cell, or the cumulative floor total. */
export function ffeBlockValue(item: FfeItem, tag: FfeTag): number | string | null {
  if (item.level === 'B') return item.block[tag];
  const anyValue = Object.values(item.floors).some((c) => c[tag] !== null && c[tag] !== undefined && c[tag] !== '');
  return anyValue ? ffeFloorTotal(item, tag) : null;
}

/** All note keys used by a block (general + item-scoped), in first-seen order. */
export function ffeNoteKeys(ffe: BlockFfe): string[] {
  return [...new Set([...ffe.notes, ...ffe.items.flatMap((i) => i.note_keys)])];
}

export function ffeNoteText(key: string, notes: FfeNotes): string {
  return notes[key] ?? `${key} (note text not available)`;
}

/** Copies the required values into "proposed" (Occupancy carried forward from a Provisional NOC). */
export function carryRequiredToProposed(ffe: BlockFfe): BlockFfe {
  const copy = JSON.parse(JSON.stringify(ffe)) as BlockFfe;
  for (const item of copy.items) {
    item.block.prop = item.block.reqt;
    item.block.prov = null;
    for (const cell of Object.values(item.floors)) {
      cell.prop = cell.reqt;
      cell.prov = null;
    }
  }
  copy.agree_reqt = false;
  return copy;
}

/** Copies the provided values into "proposed" (Renewal carried forward from an Occupancy NOC). */
export function carryProvidedToProposed(ffe: BlockFfe): BlockFfe {
  const copy = JSON.parse(JSON.stringify(ffe)) as BlockFfe;
  for (const item of copy.items) {
    item.block.prop = item.block.prov ?? item.block.reqt;
    item.block.prov = null;
    for (const cell of Object.values(item.floors)) {
      cell.prop = cell.prov ?? cell.reqt;
      cell.prov = null;
    }
  }
  copy.agree_reqt = false;
  return copy;
}

export function emptyBlockFfe(): BlockFfe {
  return { items: [], notes: [], agree_reqt: false };
}
