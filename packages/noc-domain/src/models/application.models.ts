/**
 * Application (NOC) aggregate models.
 * Source: apis/Application.txt, ApplList.txt, newappl.txt, newrenewal.txt,
 * Block.txt — see docs/02-domain-model.md.
 *
 * All applications live in ONE mock store (assets/data/applications/applications.json).
 * Citizen lists, department queues and the admin search are projections of it.
 */
import { ApplicationTypeCode } from './lookup.models.js';
import type { DeptDocument, SmsMessage, WorkflowRun } from './workflow.models.js';

/** Canonical lifecycle status (Statuses.txt, codes 1-9). */
export type StatusId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type DelegationLevel = 'MSB' | 'RFO' | 'DFO';

export type HostName = 'SDP' | 'MAUD' | null;

export interface Party {
  sl_no: number;
  role_name: string;
  party_name: string;
  phone_number: string;
  email: string;
  license_no: string;
}

export interface BlockSide {
  bside_id: number;
  direc: string;
  /** R = Street/Road, B = Building, S = Open Space, O = Others */
  ptype: string;
  pname: string;
  width: number;
}

export interface Floor {
  floor_id: number;
  /** B = Basement/Cellar, S = Stilt, G = Ground, F = Floor, T = Terrace */
  flr_type: string;
  flr_name: string;
  built_area: number;
  /** Legacy floor occupancy code: PAR, RES, EDU1, EDU2, INS1, INS2, ASM1..6, MER1..3, BIZ, IND, STO, MLCP, HAZ, OTH */
  occ_type: string;
  /** Number of occupants declared by the builder. */
  occ_c_app: number;
  /** Fixed seats (ASM1 assembly floors). */
  seats_num?: number;
  /** Values of the same floor in the parent Provisional NOC (Occupancy carried forward). */
  parent_built_area?: number;
  parent_occ_c_app?: number;
}

export interface OpenSpace {
  ospace_id: number;
  direc: string;
  proposed: number;
  /** Projection (chajja / weather shade) into the open space, metres. */
  projection?: number;
  /** Proposed open space in the parent Provisional NOC (Occupancy carried forward). */
  parent_proposed?: number;
  /** Open space required as per the parent Provisional NOC. */
  os_preqd?: number;
}

/** Open space required on a side after land was surrendered for road widening (legacy roadwidening[]). */
export interface RoadWidening {
  rw_direc: string;
  rw_reqd: number;
}

export interface Escape {
  escape_id: number;
  /** I = Internal staircase, E = External staircase, R = Ramp (above ground), C = Basement ramp */
  etype: string;
  desc: string;
  width: number;
  location: string;
  /** Floor ids served (inclusive range). */
  from_floor?: number;
  to_floor?: number;
}

export interface ExitGate {
  exit_id: number;
  ename: string;
  width: number;
  /** Width of the road abutting the entrance/exit. */
  awidth: number;
  direc: string;
}

export interface Door {
  door_id: number;
  desc: string;
  width: number;
  location: string;
}

export interface Lift {
  lift_id: number;
  ltype: string;
  lname: string;
  capacity: number;
}

export interface RefugeArea {
  refuge_id: number;
  floor_id: number;
  area: number;
}

export interface CarPark {
  cpark_id: number;
  floor: string;
  capacity: number;
}

/** One cell of the legacy floor-wise FFE grid: values keyed by the ApplTypes ffe tags. */
export interface FfeCell {
  /** Minimum required (rule-engine result): a number, or a note/text (e.g. "Note 10"), or null if not required. */
  reqt: number | string | null;
  /** Proposed (e.g. as per the Provisional NOC; may be a note-based requirement carried forward). */
  prop: number | string | null;
  /** Provided / installed. */
  prov: number | null;
}

export interface FfeItem {
  equip_id: number;
  /** F = floor-wise item, B = building (block) level item — Equipments.txt `level`. */
  level: 'F' | 'B';
  /** Per-floor cells for floor-wise items (keyed by floor_id). */
  floors: Record<string, FfeCell>;
  /** Block-level cell for building-level items (the legacy "Total" row). */
  block: FfeCell;
  /** FFE note keys (FFE_Notes.txt) attached to this item. */
  note_keys: string[];
  /** True when the applicant added the item (legacy "Add Fire Fighting Equipment"). */
  added?: boolean;
  remarks?: string;
}

export interface BlockFfe {
  items: FfeItem[];
  /** General note keys for the block (other_notes.rule without equipment scope). */
  notes: string[];
  /** "I confirm that the construction shall adhere to the minimum quantities…" */
  agree_reqt: boolean;
}

export interface Block {
  block_id: number;
  sl_no?: number;
  block_name: string;
  /** N = Normal, T = Tower, P = Podium (legacy block_type) */
  block_type: string;
  site_type: string;
  site_stype: string;
  is_mixed?: boolean;
  is_multiplex?: boolean;
  is_miniplex?: boolean;
  /** Hospitals (C1): in-patient beds provided — 'Y' / 'N' (FFE rule variable @beds). */
  beds?: string;
  height: number;
  /** Permissible height excluding stilt (used for open space of Provisional / Occupancy-from-Provisional). */
  permissible_height: number;
  road_wide?: boolean;
  roadwidening: RoadWidening[];
  xfer_sbak?: boolean;
  front_dir: string;
  sides: BlockSide[];
  floors: Floor[];
  ospaces: OpenSpace[];
  escapes: Escape[];
  exits: ExitGate[];
  doors: Door[];
  lifts: Lift[];
  refuges: RefugeArea[];
  carparks: CarPark[];
  /** Travel distance from the farthest point to a staircase (m). */
  ta_dist: number;
  /** Travel distance from a dead-end of a corridor to a staircase (m). */
  ta_dead: number;
  /** Head-room clearance at entrance/exit (m). */
  hrclear: number;
  ffe: BlockFfe;
}

/** Ad-hoc document requested by the department from the citizen. */
export interface RequestedDocument {
  fileid: number;
  appid: number;
  processid: number;
  file_name: string;
  file_desc: string;
  /** R = requested, U = uploaded by citizen, C = closed/accepted */
  status: 'R' | 'U' | 'C';
  citizen_comment?: string;
  requested_by?: string;
  requested_on?: string;
}

/**
 * Uploaded document metadata. The binary itself is never persisted in this
 * stub-data build — only what a real backend would return about it.
 */
export interface UploadedDocument {
  /** Stored file (download through a one-time token); absent for legacy metadata-only rows. */
  file_id?: string;
  doc_id: number;
  /** Requirement code, e.g. "ChallanCopy", "SitePlan:1", "FloorPlan:1:3", "Requested:CompletionCertificate". */
  code: string;
  file_name: string;
  category: string;
  uploaded_on: string;
  size?: number;
}

export interface ProcessStep {
  step_id: number;
  uid: number;
  reviewer_name: string;
  role: string;
  status_id: StatusId;
  action: string;
  remarks: string;
  at_date: string;
}

export interface Payment {
  /** The fee breakdown frozen at payment, with the rule version it was computed under. */
  fee_breakdown?: unknown;
  mode: 'online' | 'challan' | null;
  amount: number;
  status: 'pending' | 'paid' | 'failed';
  challan_num?: string;
  challan_date?: string;
  challan_bnk?: string;
  challan_brch?: string;
  txn_ref?: string;
  paid_on?: string;
}

/** Full application aggregate (detail view / wizard / store record). */
export interface Application {
  appl_id: number;
  appl_number: string;
  appl_type: ApplicationTypeCode;
  appl_mode: string;
  revision: number;
  /** Username of the citizen account that owns the application. */
  owner: string;

  site_name: string;
  site_addr: string;
  district: number;
  dist_name: string;
  /** Fire station id (fire_stations.id); 0 = not chosen yet. */
  fire_station_id: number;
  corr_addr: string;

  plot_area: number;
  perimeter: number;
  lic_auth: string;
  lic_addr: string;

  build_name: string;
  build_landline: string;
  build_mobile: string;
  build_email: string;
  build_aadhar?: string;

  /** Occupancy NOC reference number (Renewal / Declaration). */
  ref_no?: string;
  /** Last inspection date (Declaration). */
  last_inspect_date?: string;

  applied_date: string;
  final_date?: string;
  last_modified: string;
  status_id: StatusId;
  delegation_level: DelegationLevel;
  /** Display text: who the application is currently pending with. */
  reviewer: string;

  loc_lat?: number;
  loc_lng?: number;
  host_name: HostName;

  parent_id: number;
  child_id: number;

  /** "I have verified all the information provided in this application…" (legacy checklist.agreed). */
  declaration_accepted: boolean;
  /** Municipal approval date — Occupancy without Provisional NOC (fee penalty years). */
  mcapprove_date?: string;
  /** Occupancy: compliance of Provisional NOC conditions (legacy confirmpconditions / SaveChecklist). */
  conditions?: ConditionCheck[];
  /** Certificate validity (set when issued). */
  valid_from?: string;
  valid_to?: string;
  /** Citizen's rating of the service on a completed application (legacy savefeedback.aspx). */
  feedback?: Feedback;

  /** Declarations: level of the Occupancy NOC being renewed (when it is not found on the portal). */
  noc_level?: DelegationLevel;
  /** Department workflow of the current revision (Phase 3). */
  workflow?: WorkflowRun;
  /** Workflow runs of earlier revisions. */
  workflow_history?: WorkflowRun[];
  /** Label of the last completed stage, e.g. "Reviewed by ADFS" (legacy role-status label, incl. 31). */
  stage_label?: string;
  /** Documents uploaded by the department. */
  dept_documents?: DeptDocument[];
  /** Messages sent to the applicant. */
  sms?: SmsMessage[];

  parties: Party[];
  blocks: Block[];
  deptfiles: RequestedDocument[];
  documents: UploadedDocument[];
  processLog: ProcessStep[];
  payment: Payment;
  /** Optimistic-concurrency version from the server (sent back as If-Match on save). */
  row_version?: number;
}

export interface ConditionCheck {
  checklist_id: number;
  item_desc: string;
  /** null = not answered, true = complied, false = not complied */
  selected: boolean | null;
}

export interface Feedback {
  rating: number;
  remarks: string;
  rated_on: string;
}

/** Flattened row used by dashboard/queue list screens (ApplList.txt shape). */
export interface ApplicationSummary {
  appl_id: number;
  appl_number: string;
  appl_type: ApplicationTypeCode;
  appl_mode: string;
  revision: number;
  owner: string;

  site_name: string;
  site_addr: string;
  site_type: string;
  height: number;
  flr_count: number;
  built_area: number;

  build_name: string;
  build_landline: string;
  build_mobile: string;
  build_email: string;

  challan_amt: number;
  applied_date: string;
  final_date?: string;
  last_modified: string;
  status_id: StatusId;

  delegation_level: DelegationLevel;
  dist_name: string;
  host_name: HostName;
  reviewer?: string;
  parent_id: number;
  child_id: number;
  /** Number of department document requests awaiting the citizen. */
  pending_requests: number;
  valid_to?: string;
  rating?: number;

  challan_paid: boolean;
  bank_guarantee: boolean;
  undertaking: boolean;
  form16: boolean;
  fire_draw_5: boolean;
}
