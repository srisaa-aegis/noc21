import { Application, ApplicationTypeCode, Block, OccupancyCondition, PartyRole, ProcessStep, UserAccount } from './models/index.js';
import { formatLegacyDate } from './dates.js';
import { reqdOpenSpace } from './commonrules.js';
import { carryProvidedToProposed, carryRequiredToProposed, emptyBlockFfe } from './ffe.js';

const DIRECTIONS = ['N', 'E', 'S', 'W'];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Empty block shape (legacy newappl.txt `blocks[0]`), with the 4 sides/open spaces pre-created. */
export function newBlock(blockId: number, blockType = 'N'): Block {
  return {
    block_id: blockId,
    sl_no: blockId,
    block_name: blockId === 1 ? 'Block A' : `Block ${String.fromCharCode(64 + blockId)}`,
    block_type: blockType,
    site_type: '',
    site_stype: '',
    is_mixed: false,
    is_multiplex: false,
    is_miniplex: false,
    beds: '',
    height: 0,
    permissible_height: 0,
    road_wide: false,
    roadwidening: DIRECTIONS.map((d) => ({ rw_direc: d, rw_reqd: 0 })),
    xfer_sbak: false,
    front_dir: '',
    sides: DIRECTIONS.map((d, i) => ({ bside_id: i + 1, direc: d, ptype: '', pname: '', width: 0 })),
    floors: [{ floor_id: 1, flr_type: 'G', flr_name: 'Ground', built_area: 0, occ_type: '', occ_c_app: 0, seats_num: 0 }],
    ospaces: DIRECTIONS.map((d, i) => ({ ospace_id: i + 1, direc: d, proposed: 0, projection: 0 })),
    escapes: [{ escape_id: 1, etype: 'I', desc: 'Internal Staircase', width: 0, location: 'E' }],
    exits: [],
    doors: [],
    lifts: [],
    refuges: [],
    carparks: [],
    ta_dist: 0,
    ta_dead: 0,
    hrclear: 0,
    ffe: emptyBlockFfe(),
  };
}

const DEFAULT_MODE: Record<ApplicationTypeCode, string> = { P: '', O: 'N', R: 'M', RO: 'M', D: 'M' };

/** A blank draft (legacy newapplication.aspx / newdeclaration.aspx). */
export function newDraft(
  id: number,
  type: ApplicationTypeCode,
  owner: UserAccount,
  partyRoles: PartyRole[],
  now: Date = new Date(),
  occupancyConditions: OccupancyCondition[] = [],
): Application {
  const hasBlocks = type !== 'D';
  return {
    appl_id: id,
    appl_number: '',
    appl_type: type,
    appl_mode: DEFAULT_MODE[type],
    revision: 1,
    owner: owner.username,
    site_name: '',
    site_addr: '',
    district: 0,
    dist_name: '',
    fire_station_id: 0,
    corr_addr: owner.address ?? '',
    plot_area: 0,
    perimeter: 0,
    lic_auth: '',
    lic_addr: '',
    build_name: owner.displayName,
    build_landline: '',
    build_mobile: owner.mobile,
    build_email: owner.email,
    build_aadhar: owner.aadhar_last4 ? `XXXXXXXX${owner.aadhar_last4}` : '',
    ref_no: '',
    last_inspect_date: '',
    applied_date: '',
    final_date: '',
    last_modified: formatLegacyDate(now),
    status_id: 1,
    delegation_level: 'DFO',
    reviewer: '',
    loc_lat: 0,
    loc_lng: 0,
    host_name: null,
    parent_id: 0,
    child_id: 0,
    declaration_accepted: false,
    mcapprove_date: '',
    conditions: type === 'O' ? occupancyConditions.map((c) => ({ ...c, selected: null })) : [],
    parties:
      type === 'D'
        ? []
        : partyRoles.map((r, i) => ({
            sl_no: i + 1,
            role_name: r.role_name,
            party_name: i === 0 ? owner.displayName : '',
            phone_number: i === 0 ? owner.mobile : '',
            email: i === 0 ? owner.email : '',
            license_no: '',
          })),
    blocks: hasBlocks ? [newBlock(1)] : [],
    deptfiles: [],
    documents: [],
    processLog: [],
    payment: { mode: null, amount: 0, status: 'pending', challan_num: '', challan_date: '', challan_bnk: '', challan_brch: '', txn_ref: '', paid_on: '' },
  };
}

function carryForward(parent: Application, id: number, type: ApplicationTypeCode, now: Date): Application {
  const child = clone(parent);
  // Keep the parent's values for the legacy "_O" comparisons (as per PNOC / as proposed).
  for (const b of child.blocks) {
    for (const f of b.floors) {
      f.parent_built_area = f.built_area;
      f.parent_occ_c_app = f.occ_c_app;
    }
    for (const o of b.ospaces) {
      o.parent_proposed = o.proposed;
    }
  }
  return {
    ...child,
    appl_id: id,
    appl_number: '',
    appl_type: type,
    appl_mode: 'O',
    revision: 1,
    applied_date: '',
    final_date: '',
    last_modified: formatLegacyDate(now),
    status_id: 1,
    reviewer: '',
    parent_id: parent.appl_id,
    child_id: 0,
    declaration_accepted: false,
    feedback: undefined,
    valid_from: '',
    valid_to: '',
    deptfiles: [],
    documents: [],
    processLog: [],
    payment: { mode: null, amount: 0, status: 'pending', challan_num: '', challan_date: '', challan_bnk: '', challan_brch: '', txn_ref: '', paid_on: '' },
  };
}

/**
 * Occupancy draft from an issued Provisional NOC (legacy CopyPNOCApplication /
 * newonocappl.aspx): site, builder, parties and blocks are copied; what the
 * Provisional NOC *required* becomes what the Occupancy application *proposed*.
 */
export function occupancyFromProvisional(
  parent: Application,
  id: number,
  now: Date = new Date(),
  occupancyConditions: OccupancyCondition[] = [],
): Application {
  const child = carryForward(parent, id, 'O', now);
  child.ref_no = parent.appl_number;
  child.blocks.forEach((b, i) => {
    b.ffe = carryRequiredToProposed(b.ffe);
    // Open space required as per the Provisional NOC (legacy os_preqd).
    const pb = parent.blocks[i];
    b.ospaces.forEach((o) => (o.os_preqd = pb ? reqdOpenSpace(pb, o.direc, parent.plot_area, 'P', parent.appl_mode) : undefined));
  });
  child.conditions = occupancyConditions.map((c) => ({ ...c, selected: null }));
  return child;
}

/**
 * Renewal draft from an issued Occupancy NOC (legacy CopyONOCApplication):
 * what was *provided* at occupancy becomes the *proposed* baseline.
 */
export function renewalFromOccupancy(parent: Application, id: number, now: Date = new Date()): Application {
  const child = carryForward(parent, id, 'R', now);
  // The Occupancy NOC reference stays the same for every periodic renewal.
  child.ref_no = parent.appl_type === 'O' ? parent.appl_number : parent.ref_no || parent.appl_number;
  child.blocks.forEach((b) => (b.ffe = carryProvidedToProposed(b.ffe)));
  child.conditions = [];
  return child;
}

export function processStep(
  app: Application,
  action: string,
  remarks: string,
  actor: { name: string; role: string; uid?: number },
  now: Date = new Date(),
): ProcessStep {
  return {
    step_id: app.processLog.reduce((m, s) => Math.max(m, s.step_id), 0) + 1,
    uid: actor.uid ?? 0,
    reviewer_name: actor.name,
    role: actor.role,
    status_id: app.status_id,
    action,
    remarks,
    at_date: formatLegacyDate(now),
  };
}
