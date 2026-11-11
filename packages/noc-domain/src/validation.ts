/**
 * Submission validation (legacy validateapplication.aspx). Saving only needs the site name
 * and address (see `saveProblem` in application-rules.ts); this full validation runs when the
 * applicant clicks Submit, and its messages are also shown inline on the form at all times
 * (legacy "fields with red background") without preventing navigation between pages.
 */
import {
  Application,
  ApplicationType,
  BuildType,
  DocumentRequirements,
  Equipment,
  EscapeRules,
  FeeConfig,
  PartyRole,
  RuleTree,
} from './models/index.js';
import { computeFee } from './application-rules.js';
import {
  fireLiftsReqd,
  floorEscapeWidth,
  maxDeadEndDistance,
  maxOccuCount,
  maxTravelDistance,
  openSpaceMessage,
  reqdEscapeWidthValue,
  reqdOpenSpace,
  refugeAreaRequired,
  stairsByLoad,
  totalStairsRequiredByNBC,
  doorWidthRequired,
  stairTypeName,
  directionName,
} from './commonrules.js';
import { requiredDocuments } from './documents.js';
import { FfeTag, ffeColumns } from './ffe.js';
import { evaluateRule } from './rule-engine.js';
import { BlockStepId, WizardStepId, stepsFor } from './wizard-steps.js';

export interface ValidationIssue {
  step: WizardStepId;
  /** Index of the block (issues of the per-block flow). */
  block?: number;
  /** Page of the per-block flow the issue belongs to. */
  blockStep?: BlockStepId;
  /** Dotted path of the offending field, e.g. "blocks.0.floors.1.built_area". */
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationContext {
  applicationTypes: ApplicationType[];
  buildTypes: BuildType[];
  partyRoles: PartyRole[];
  documentRequirements: DocumentRequirements;
  escapeRules: EscapeRules;
  /** validations/height.rule — maximum permissible height per occupancy. */
  heightLimits: RuleTree;
  feeConfig: FeeConfig;
  /** Equipment catalog (names in FFE messages). */
  equipments?: Equipment[];
  /** Date the fee is computed for (penalty years); defaults to today. */
  now?: Date;
}

const MOBILE = /^[6-9]\d{9}$/;
const PHONE = /^[0-9+\-\s]{6,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FIRE_LIFT_MIN_KG = 545;

const blank = (v: unknown) => v == null || String(v).trim() === '';
const positive = (v: unknown) => Number(v) > 0;
const num = (v: unknown) => Number(v) || 0;

type Add = (field: string, message: string, severity?: 'error' | 'warning') => void;

function adder(out: ValidationIssue[], step: WizardStepId): Add {
  return (field, message, severity = 'error') => out.push({ step, field, message, severity });
}

/** Issues of the per-block flow: the block index is taken from the field path ("blocks.2.…"). */
function blockAdder(out: ValidationIssue[], blockStep: BlockStepId | ((field: string) => BlockStepId)): Add {
  return (field, message, severity = 'error') => {
    const m = /^blocks\.(\d+)/.exec(field);
    const page = typeof blockStep === 'function' ? blockStep(field) : blockStep;
    out.push({ step: 'blocks', block: m ? Number(m[1]) : undefined, blockStep: m ? page : undefined, field, message, severity });
  };
}

const blockPageOf = (field: string): BlockStepId => (/^blocks\.\d+\.floors(\.|$)/.test(field) ? 'floors' : 'details');

function validateBasic(app: Application, ctx: ValidationContext, out: ValidationIssue[]): void {
  const err = adder(out, 'basic');
  if (blank(app.site_name) || app.site_name.trim().length < 3) err('site_name', 'Site / building name is required (min. 3 characters).');
  if (blank(app.site_addr)) err('site_addr', 'Site address (with survey number) is required.');
  if (!positive(app.district)) err('district', 'Select the district.');
  if (!positive(app.fire_station_id)) err('fire_station_id', 'Select the nearest fire station.');
  if (blank(app.corr_addr)) err('corr_addr', 'Address for correspondence is required.');

  if (app.appl_type === 'P' || app.appl_type === 'O') {
    if (blank(app.lic_auth)) err('lic_auth', 'Licensing authority is required.');
    if (blank(app.lic_addr)) err('lic_addr', 'Licensing authority address is required.');
    if (!positive(app.plot_area)) err('plot_area', 'Plot area must be greater than zero.');
    if (!positive(app.perimeter)) err('perimeter', 'Plot perimeter must be greater than zero.');
  }
  if (app.appl_type === 'O' && app.appl_mode === 'N' && blank(app.mcapprove_date)) {
    err('mcapprove_date', 'Date of municipal approval is required (used to compute the fee).');
  }
  if ((app.appl_type === 'R' || app.appl_type === 'D') && app.appl_mode === 'M' && blank(app.ref_no)) {
    err('ref_no', 'Occupancy NOC reference number is required.');
  }
  if (app.appl_type === 'O' && app.appl_mode === 'M' && blank(app.ref_no)) {
    err('ref_no', 'Provisional NOC reference (Rc. No.) is required.');
  }
  if (app.appl_type === 'D' && !(app.parent_id > 0) && !app.noc_level) {
    err('noc_level', 'Select the level at which the Occupancy NOC was issued.');
  }
  if (app.appl_type === 'D' && blank(app.last_inspect_date)) {
    err('last_inspect_date', 'Date of the last fire safety inspection is required.');
  }

  if (blank(app.build_name)) err('build_name', 'Builder / owner / developer name is required.');
  if (!MOBILE.test(String(app.build_mobile ?? ''))) err('build_mobile', 'Enter a valid 10-digit mobile number.');
  if (!EMAIL.test(String(app.build_email ?? ''))) err('build_email', 'Enter a valid e-mail address.');
  if (!blank(app.build_landline) && !PHONE.test(app.build_landline)) err('build_landline', 'Enter a valid landline number.');

  if (app.appl_type !== 'D') {
    app.parties.forEach((party, i) => {
      const role = ctx.partyRoles.find((r) => r.role_name === party.role_name);
      const required = !!role?.required_for.includes(app.appl_type);
      const started = !blank(party.party_name) || !blank(party.phone_number) || !blank(party.license_no);
      if (!required && !started) return;
      if (blank(party.party_name)) err(`parties.${i}.party_name`, `${party.role_name}: name is required.`);
      if (!PHONE.test(String(party.phone_number ?? ''))) err(`parties.${i}.phone_number`, `${party.role_name}: valid phone number is required.`);
      if (blank(party.license_no)) err(`parties.${i}.license_no`, `${party.role_name}: license number is required.`);
      if (!blank(party.email) && !EMAIL.test(party.email)) err(`parties.${i}.email`, `${party.role_name}: e-mail is invalid.`);
    });
  }

  // Conditions of the Provisional NOC apply only when there is one (legacy: appl_mode != 'N').
  (app.appl_type === 'O' && app.appl_mode !== 'N' ? (app.conditions ?? []) : []).forEach((c, i) => {
    if (c.selected === null || c.selected === undefined) err(`conditions.${i}`, `State whether condition ${i + 1} of the Provisional NOC is complied.`);
  });
}

function usesPermissibleHeight(app: Application): boolean {
  return app.appl_type === 'P' || (app.appl_type === 'O' && app.appl_mode !== 'N');
}

function validateBlocks(app: Application, ctx: ValidationContext, out: ValidationIssue[]): void {
  const err = blockAdder(out, blockPageOf);
  if (app.blocks.length === 0) {
    err('blocks', 'Add at least one block (building).');
    return;
  }
  app.blocks.forEach((block, b) => {
    const p = `blocks.${b}`;
    const name = block.block_name || `Block ${b + 1}`;
    if (blank(block.block_name)) err(`${p}.block_name`, `Block ${b + 1}: name is required.`);
    const type = ctx.buildTypes.find((t) => t.code === block.site_type);
    if (!type) err(`${p}.site_type`, `${name}: select the occupancy type.`);
    else if (!type.sub.some((s) => s.code === block.site_stype)) err(`${p}.site_stype`, `${name}: select the occupancy sub-type.`);
    const height = num(block.height);
    if (height <= 0) err(`${p}.height`, `${name}: height must be greater than zero.`);
    else if (type && ['edu', 'ins', 'asm', 'mer', 'ind', 'sto', 'haz'].includes(block.site_type)) {
      if (evaluateRule(ctx.heightLimits, { site_type: block.site_type, height }).value !== 'valid') {
        err(`${p}.height`, `${name}: a height of ${height} m is not permissible for ${type.name} occupancy.`);
      }
    }
    if (usesPermissibleHeight(app) && !positive(block.permissible_height)) {
      err(`${p}.permissible_height`, `${name}: permissible height (excluding stilt) is required.`);
    }
    if (block.site_type === 'ins' && block.site_stype === 'C1' && blank(block.beds)) {
      err(`${p}.beds`, `${name}: state whether in-patient beds are provided.`);
    }
    if (blank(block.front_dir)) err(`${p}.front_dir`, `${name}: select the front (abutting road) side.`);

    if (block.floors.length === 0) err(`${p}.floors`, `${name}: add at least one floor.`);
    block.floors.forEach((f, i) => {
      if (blank(f.flr_name)) err(`${p}.floors.${i}.flr_name`, `${name}: floor ${i + 1} name is required.`);
      if (!positive(f.built_area)) err(`${p}.floors.${i}.built_area`, `${name}: floor ${i + 1} built-up area must be greater than zero.`);
      if (blank(f.occ_type)) err(`${p}.floors.${i}.occ_type`, `${name}: floor ${i + 1} occupancy is required.`);
      if (f.occ_type === 'ASM1' && !positive(f.seats_num)) err(`${p}.floors.${i}.seats_num`, `${name}: floor ${i + 1} number of fixed seats is required.`);
    });

    block.sides.forEach((s, i) => {
      if (blank(s.ptype)) err(`${p}.sides.${i}.ptype`, `${name}: select the type of property on the ${directionName(s.direc)} side.`);
      if (blank(s.pname)) err(`${p}.sides.${i}.pname`, `${name}: describe the ${directionName(s.direc)} side.`);
      if (s.ptype === 'R' && !positive(s.width)) err(`${p}.sides.${i}.width`, `${name}: road width on the ${directionName(s.direc)} side is required.`);
    });

    block.ospaces.forEach((o, i) => {
      const reqd = reqdOpenSpace(block, o.direc, app.plot_area, app.appl_type, app.appl_mode);
      const msg = openSpaceMessage(reqd);
      if (o.proposed == null || String(o.proposed) === '' || num(o.proposed) < 0) {
        err(`${p}.ospaces.${i}.proposed`, `${name}: open space on the ${directionName(o.direc)} side is required.`);
      } else if (msg) {
        err(`${p}.ospaces.${i}.proposed`, `${name} (${directionName(o.direc)}): ${msg}`);
      } else if (num(o.proposed) < reqd) {
        err(`${p}.ospaces.${i}.proposed`, `${name}: the proposed open space on the ${directionName(o.direc)} side (${num(o.proposed)} m) should not be less than the required ${reqd} m.`);
      }
      if (num(o.projection) > ctx.escapeRules.projection_max) {
        err(`${p}.ospaces.${i}.projection`, `${name}: projections into the ${directionName(o.direc)} open space cannot exceed ${ctx.escapeRules.projection_max} m.`);
      }
    });
    if (block.road_wide) {
      (block.roadwidening ?? []).forEach((rw, i) => {
        if (!positive(rw.rw_reqd)) err(`${p}.roadwidening.${i}.rw_reqd`, `${name}: enter the open space required after road widening on the ${directionName(rw.rw_direc)} side.`);
      });
    }
  });
}

function validateEscapes(app: Application, ctx: ValidationContext, out: ValidationIssue[]): void {
  const err = blockAdder(out, 'escapes');
  const r = ctx.escapeRules;
  app.blocks.forEach((block, b) => {
    const p = `blocks.${b}`;
    const name = block.block_name || `Block ${b + 1}`;
    const multiStorey = totalStairsRequiredByNBC(block) > 0;
    const stairs = block.escapes.filter((e) => e.etype === 'I' || e.etype === 'E');
    const internal = block.escapes.filter((e) => e.etype === 'I').length;
    const external = block.escapes.filter((e) => e.etype === 'E').length;

    if (multiStorey) {
      const needed = totalStairsRequiredByNBC(block);
      if (stairs.length < needed) err(`${p}.escapes`, `${name}: ${needed} staircase(s) are required as per NBC; ${stairs.length} proposed.`);
      if (internal < 1) err(`${p}.escapes`, `${name}: at least one internal staircase is required.`);
      if (app.delegation_level === 'MSB' && external < 1) err(`${p}.escapes`, `${name}: at least one external staircase is mandatory for multi-storeyed buildings.`);
    }
    if (block.site_type === 'ins' && !block.escapes.some((e) => e.etype === 'R')) {
      err(`${p}.escapes`, `${name}: a ramp above the ground is mandatory for institutional buildings.`);
    }
    const maxOcc = maxOccuCount(block);
    block.escapes.forEach((e, i) => {
      const min = reqdEscapeWidthValue(e.etype, block.site_type, block.site_stype, maxOcc);
      if (!positive(e.width)) err(`${p}.escapes.${i}.width`, `${name}: width of ${stairTypeName(e.etype)} ${i + 1} is required.`);
      else if (min > 0 && num(e.width) < min) err(`${p}.escapes.${i}.width`, `${name}: ${stairTypeName(e.etype)} ${i + 1} must be at least ${min} m wide.`);
    });
    block.floors.forEach((f, i) => {
      const reqd = stairsByLoad(f);
      if (reqd && reqd > 0 && floorEscapeWidth(block, f.floor_id) < reqd) {
        err(`${p}.floors.${i}.esc_width`, `${name}: aggregate staircase width serving ${f.flr_name || 'floor ' + (i + 1)} is below the ${reqd} m required for its occupants.`);
      }
    });

    if (multiStorey) {
      const sprinklered = block.ffe?.items.some((it) => it.equip_id === 5) ?? false;
      const maxTd = maxTravelDistance(block, r, sprinklered);
      const maxDe = maxDeadEndDistance(block, r, sprinklered);
      if (!positive(block.ta_dist)) err(`${p}.ta_dist`, `${name}: enter the travel distance from the farthest point to a staircase.`);
      else if (num(block.ta_dist) > maxTd) err(`${p}.ta_dist`, `${name}: travel distance ${block.ta_dist} m exceeds the maximum of ${maxTd} m.`);
      if (num(block.ta_dead) > maxDe) err(`${p}.ta_dead`, `${name}: dead-end travel distance ${block.ta_dead} m exceeds the maximum of ${maxDe} m.`);
    }

    const minDoor = doorWidthRequired(block);
    block.doors.forEach((d, i) => {
      if (num(d.width) < minDoor) err(`${p}.doors.${i}.width`, `${name}: doorway ${i + 1} must be at least ${minDoor} m wide.`);
    });

    if (app.delegation_level !== 'DFO') {
      if (block.exits.length === 0) err(`${p}.exits`, `${name}: add the entrance / exit to the premises.`);
      block.exits.forEach((x, i) => {
        if (num(x.width) < r.exit_min_width) err(`${p}.exits.${i}.width`, `${name}: entrance/exit ${i + 1} must be at least ${r.exit_min_width} m wide.`);
        if (num(x.awidth) < r.exit_min_abutting_road) err(`${p}.exits.${i}.awidth`, `${name}: road abutting entrance/exit ${i + 1} must be at least ${r.exit_min_abutting_road} m wide.`);
      });
      if (block.exits.length > 0 && num(block.hrclear) < r.headroom_min) {
        err(`${p}.hrclear`, `${name}: head-room clearance must be at least ${r.headroom_min} m.`);
      }
    }

    if (num(block.height) > r.refuge_min_height) {
      if (block.refuges.length === 0) err(`${p}.refuges`, `${name}: refuge area is mandatory for buildings higher than ${r.refuge_min_height} m.`);
      block.refuges.forEach((rf, i) => {
        const reqd = refugeAreaRequired(block, rf.floor_id, r.refuge_area_per_person, r.refuge_min_area);
        if (num(rf.area) < reqd) err(`${p}.refuges.${i}.area`, `${name}: refuge area ${i + 1} must be at least ${reqd} sq.m.`);
      });
    }

    const liftsReqd = fireLiftsReqd(block);
    if (block.lifts.length < liftsReqd) err(`${p}.lifts`, `${name}: ${liftsReqd} fire lift(s) are required; ${block.lifts.length} proposed.`);
    block.lifts.forEach((l, i) => {
      if (num(l.capacity) < FIRE_LIFT_MIN_KG) err(`${p}.lifts.${i}.capacity`, `${name}: fire lift ${i + 1} capacity must be at least ${FIRE_LIFT_MIN_KG} kg (8 persons).`);
    });
  });
}

function validateFfe(app: Application, ctx: ValidationContext, out: ValidationIssue[]): void {
  const add = blockAdder(out, 'ffe');
  const columns = ffeColumns(ctx.applicationTypes, app.appl_type, app.appl_mode);
  const inputTags = columns.filter((c) => c.type === 'input').map((c) => c.tag as FfeTag);
  const confirmNeeded = app.appl_type === 'P' || (app.appl_type === 'O' && app.appl_mode === 'N');
  app.blocks.forEach((block, b) => {
    const p = `blocks.${b}`;
    const name = block.block_name || `Block ${b + 1}`;
    if (!block.ffe || block.ffe.items.length === 0) {
      add(`${p}.ffe`, `${name}: fire fighting equipment requirements have not been calculated (add floors first).`);
      return;
    }
    if (confirmNeeded && !block.ffe.agree_reqt) {
      add(`${p}.ffe.agree_reqt`, `${name}: confirm that the construction shall adhere to the minimum quantities of fire equipment.`);
    }
    block.ffe.items.forEach((item, i) => {
      const eqName = ctx.equipments?.find((e) => e.id === item.equip_id)?.desc ?? `Equipment #${item.equip_id}`;
      const cells = item.level === 'F' ? Object.values(item.floors) : [item.block];
      const missing = new Set<FfeTag>();
      let short = false;
      for (const cell of cells) {
        if (!ffeCellNeedsInput(item, cell)) continue;
        for (const tag of inputTags) {
          const v = cell[tag];
          if (v === null || v === undefined || String(v) === '') missing.add(tag);
        }
        if (inputTags.includes('prov') && typeof cell.prov === 'number') {
          const target = typeof cell.prop === 'number' ? cell.prop : typeof cell.reqt === 'number' ? cell.reqt : null;
          if (target !== null && cell.prov < target) short = true;
        }
      }
      for (const tag of missing) {
        add(
          `${p}.ffe.items.${i}.${tag}`,
          `${name}: enter the ${tag === 'prov' ? 'provided' : 'proposed'} quantity of ${eqName}${item.level === 'F' ? ' for every floor' : ''}.`,
        );
      }
      if (short) {
        add(`${p}.ffe.items.${i}.short`, `${name}: ${eqName} — provided quantity is below the required/proposed quantity.`, 'warning');
      }
    });
  });
}

/** Whether a grid cell expects the applicant to enter a value (required/proposed there, or an item the applicant added). */
export function ffeCellNeedsInput(item: { added?: boolean }, cell: { reqt: unknown; prop: unknown }): boolean {
  return !!item.added || cell.reqt !== null || cell.prop !== null;
}

function validateDocuments(app: Application, ctx: ValidationContext, out: ValidationIssue[]): void {
  for (const doc of requiredDocuments(app, ctx.documentRequirements)) {
    if (!doc.optional && !app.documents.some((d) => d.code === doc.code)) {
      const message = `Upload: ${doc.label}${doc.blockName ? ' (' + doc.blockName + ')' : ''}.`;
      if (doc.blockId !== undefined) {
        // Plans are part of the block's own flow.
        const block = app.blocks.findIndex((b) => b.block_id === doc.blockId);
        out.push({ step: 'blocks', block, blockStep: 'plans', field: `doc.${doc.code}`, message, severity: 'error' });
      } else {
        out.push({ step: 'documents', field: `doc.${doc.code}`, message, severity: 'error' });
      }
    }
  }
}

function validateSubmit(app: Application, ctx: ValidationContext, out: ValidationIssue[]): void {
  const err = adder(out, 'submit');
  const fee = computeFee(app, ctx.feeConfig, ctx.now ?? new Date());
  if (app.payment.status !== 'paid') {
    err('payment', 'Pay the fee online or record the bank challan details.');
  } else if (num(app.payment.amount) < fee.total) {
    err('payment', `Insufficient fee paid: Rs. ${app.payment.amount} paid, Rs. ${fee.total} required.`);
  }
  if (!app.declaration_accepted) {
    err('declaration_accepted', 'Confirm that you have verified all the information provided in this application.');
  }
}

/** Full (submission) validation of an application against the pages that apply to its type. */
export function validateApplication(app: Application, ctx: ValidationContext): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const steps = stepsFor(app.appl_type).map((s) => s.id);
  validateBasic(app, ctx, out);
  if (steps.includes('blocks')) {
    validateBlocks(app, ctx, out);
    validateEscapes(app, ctx, out);
    validateFfe(app, ctx, out);
  }
  validateDocuments(app, ctx, out);
  validateSubmit(app, ctx, out);
  return out;
}

export function errorsFor(issues: ValidationIssue[], step: WizardStepId): ValidationIssue[] {
  return issues.filter((i) => i.step === step && i.severity === 'error');
}

/** Errors of one block, optionally of one page of its flow. */
export function blockErrors(issues: ValidationIssue[], block: number, blockStep?: BlockStepId): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error' && i.block === block && (!blockStep || i.blockStep === blockStep));
}

