/**
 * Reference / master data models.
 * Source: apis/ApplTypes.txt, BuildTypes.txt, Directions.txt, Districts.txt,
 * FireStations.txt, Hazards.txt, Equipments.txt, FFE_Notes.txt, Statuses.txt,
 * RoleStatuses.txt, Users.txt — see docs/02-domain-model.md.
 */

/**
 * P = Provisional, O = Occupancy, R = Renewal of Occupancy, D = Declaration for Renewal.
 * (RO is a legacy internal variant of Renewal kept for data compatibility.)
 * The legacy "Existing Building / Pilot" (O with appl_mode 'E') has been dropped.
 */
export type ApplicationTypeCode = 'P' | 'O' | 'R' | 'RO' | 'D';

export interface ApplTypeFfeColumn {
  tag: string;
  head: string;
  type: 'text' | 'input';
}

export interface ApplTypeMode {
  code: string;
  name: string;
  ffe: ApplTypeFfeColumn[];
}

export interface ApplicationType {
  code: ApplicationTypeCode;
  name: string;
  mode: ApplTypeMode[];
  /** UI metadata, additive over the legacy shape, used by the "Apply for…"
   *  launcher cards and instruction dialogs on the citizen dashboard. */
  shortLabel?: string;
  description?: string;
  icon?: string;
  instructions?: string[];
}

export interface BuildSubType {
  code: string;
  name: string;
}

export interface BuildType {
  code: string;
  name: string;
  desc: string;
  sub: BuildSubType[];
  minh: number;
  maxh: number;
}

export interface Direction {
  code: string;
  name: string;
}

export interface District {
  id: number;
  desc: string;
  ddocode: string;
  distcode: string;
}

export interface FireStation {
  id: number;
  name: string;
}

export interface DistrictFireStations {
  /** District id (districts.id). */
  id: number;
  stations: FireStation[];
}

export interface Hazard {
  code: string;
  name: string;
  hazard_code: string;
}

export interface MappedCode {
  Activity_DTCP_Code: string;
  DTCP_Desc: string;
  Activity_NBC_Code: string;
  Use_DTCP_Code: string;
  Use_NBC_Code: string;
}

export interface Equipment {
  id: number;
  desc: string;
  short: string;
  level: 'F' | 'B';
  suffix: string;
}

export type FfeNotes = Record<string, string>;

export interface StatusCode {
  code: number;
  desc: string;
  /** draft | submitted | in_process | approved | returned | rejected (statuses 1, 2, 7, 8, 9 are fixed). */
  category?: 'draft' | 'submitted' | 'in_process' | 'approved' | 'returned' | 'rejected';
  is_system?: boolean;
  is_pre_decision?: boolean;
  sort_order?: number;
  /** Badge style of the status chip. */
  badge?: string;
  active?: boolean;
}

export type RoleScope = 'hq' | 'region' | 'district' | 'station';

export interface DeptRole {
  id: number;
  code: string;
  name: string;
  description: string;
  /** Typical jurisdiction of the role (used to suggest fire-station associations). */
  scope: RoleScope;
}

/** RFO jurisdiction: a group of districts. */
export interface Region {
  code: string;
  name: string;
  districts: number[];
}

export interface PartyRole {
  role_name: string;
  required_for: ApplicationTypeCode[];
}

export interface CodeName {
  code: string;
  name: string;
}

export interface BlockOptions {
  blockTypes: CodeName[];
  floorTypes: CodeName[];
  floorOccupancies: CodeName[];
  escapeTypes: CodeName[];
  sidePropertyTypes: CodeName[];
  liftTypes: CodeName[];
}

// ---------------------------------------------------------------------------
// Legacy decision-tree rules (uploads/rules/*.rule) — see core/domain/rule-engine.ts
// ---------------------------------------------------------------------------

export type RuleOperator = 'EQ' | 'DEF' | 'GT' | 'GE' | 'LT' | 'LE' | 'BR' | 'BL';

export interface RuleDecision {
  oper: RuleOperator;
  check: string;
  check2?: string;
  action: 'goto' | 'return';
  value: string;
}

export interface RuleNode {
  /** Variable to test, e.g. "@height". */
  check: string;
  /** n = numeric, s = string */
  dtype: 'n' | 's';
  decisions: RuleDecision[];
}

/** A rule tree: `start` names the first node; all other keys are nodes. */
export type RuleTree = { start: string } & Record<string, RuleNode | string>;

/** FFE rule set: equipment rule trees keyed by equipment id, plus the auxiliary trees. */
export interface FfeRuleSet {
  equipment: Record<number, RuleTree>;
  ffeType: RuleTree;
  otherNotes: RuleTree;
  riserWidth: RuleTree;
}

// ---------------------------------------------------------------------------
// Admin-configurable business rules (assets/data/config/*.json)
// ---------------------------------------------------------------------------

export interface FeeConfig {
  portal_charges: number;
  declaration_fee: number;
  rates_per_sqm: Partial<Record<ApplicationTypeCode, number>>;
  /** Occupancy NOC applied without a Provisional NOC (mode N). */
  occupancy_without_provisional: {
    additional_per_sqm: number;
    penalty_per_sqm_per_year: number;
  };
}

/** Approval level (delegation) rule; first matching rule wins per block, the highest level across blocks applies. */
export interface DelegationRule {
  id: number;
  level: 'MSB' | 'RFO' | 'DFO';
  label: string;
  site_types: string[];
  site_stypes: string[];
  min_height: number | null;
  /** true: height >= min_height, false: height > min_height */
  min_inclusive: boolean;
  /** Exclusive upper bound (height < max_height). */
  max_height: number | null;
  /** Applies only to blocks marked "Is Multiplex" (legacy MSB.rule: asm / D6 / is_multiplex = 1). */
  multiplex_only?: boolean;
}

/** Renewal periodicity rule (legacy validations/declaration.rule); first match wins. */
export interface RenewalRule {
  id: number;
  label: string;
  site_types: string[];
  site_stypes: string[];
  /** Exclusive upper bound (height < max_height). */
  max_height: number | null;
  years: number;
}

export interface EscapeRules {
  travel_distance: { default: number; by_site_type: Record<string, number> };
  dead_end: { default: number; by_site_type: Record<string, number> };
  sprinklered_factor: number;
  exit_min_width: number;
  exit_min_abutting_road: number;
  headroom_min: number;
  projection_max: number;
  refuge_min_height: number;
  refuge_area_per_person: number;
  refuge_min_area: number;
}

export interface NocTermsSet {
  nbc?: string;
  intro?: string;
  MSB: string;
  NON_MSB: string;
}

export type NocTerms = Record<'P' | 'O' | 'R', NocTermsSet>;

/** Reference table rendered next to the FFE grid (verbatim legacy HTML). */
export interface HtmlReference {
  source: string;
  title: string;
  html: string;
}

/** One "Undertaking by Applicant" tick box of the confirmation page. */
export interface Undertaking {
  id: string;
  text: string;
  /** Must be ticked before the application can be submitted (legacy SubmitAppl). */
  required: boolean;
}

/** Undertakings on the confirmation page, keyed by application type (P, O, R, D). */
export type Undertakings = Partial<Record<string, Undertaking[]>>;

export interface OccupancyCondition {
  checklist_id: number;
  item_desc: string;
}

export type DocumentCondition = 'always' | 'challan' | 'not_dfo' | 'road_widening' | 'has_parent';

export interface DocumentRequirement {
  code: string;
  label: string;
  condition: DocumentCondition;
  optional?: boolean;
}

export interface PlanRequirements {
  applies_to: ApplicationTypeCode[];
  block: { code: string; label: string }[];
  floor: { code: string; label: string };
}

export type DocumentRequirements = Partial<Record<ApplicationTypeCode, DocumentRequirement[]>> & {
  plans: PlanRequirements;
};
