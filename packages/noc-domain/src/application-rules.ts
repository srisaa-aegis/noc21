import {
  Application,
  ApplicationSummary,
  Block,
  DelegationLevel,
  DelegationRule,
  FeeConfig,
  RenewalRule,
} from './models/index.js';
import { formatLegacyDate, parseLegacyDate } from './dates.js';

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

export function blockArea(block: Block): number {
  return block.floors.reduce((sum, f) => sum + (Number(f.built_area) || 0), 0);
}

export function totalBuiltUpArea(app: Pick<Application, 'blocks'>): number {
  return Math.round(app.blocks.reduce((sum, b) => sum + blockArea(b), 0) * 100) / 100;
}

export function maxHeight(app: Pick<Application, 'blocks'>): number {
  return app.blocks.reduce((max, b) => Math.max(max, Number(b.height) || 0), 0);
}

export function hasDocument(app: Pick<Application, 'documents'>, code: string): boolean {
  return app.documents.some((d) => d.code === code);
}

/** Projects a full aggregate to the flat list row used by dashboards/queues. */
export function toSummary(app: Application): ApplicationSummary {
  const primary = app.blocks[0];
  return {
    appl_id: app.appl_id,
    appl_number: app.appl_number,
    appl_type: app.appl_type,
    appl_mode: app.appl_mode,
    revision: app.revision,
    owner: app.owner,
    site_name: app.site_name,
    site_addr: app.site_addr,
    site_type: primary?.site_type ?? '',
    height: maxHeight(app),
    flr_count: app.blocks.reduce((n, b) => n + b.floors.length, 0),
    built_area: totalBuiltUpArea(app),
    build_name: app.build_name,
    build_landline: app.build_landline,
    build_mobile: app.build_mobile,
    build_email: app.build_email,
    challan_amt: app.payment?.amount ?? 0,
    applied_date: app.applied_date,
    final_date: app.final_date,
    last_modified: app.last_modified,
    status_id: app.status_id,
    delegation_level: app.delegation_level,
    dist_name: app.dist_name,
    host_name: app.host_name,
    reviewer: app.reviewer,
    parent_id: app.parent_id,
    child_id: app.child_id,
    pending_requests: app.deptfiles.filter((f) => f.status === 'R').length,
    valid_to: app.valid_to,
    rating: app.feedback?.rating,
    challan_paid: app.payment?.status === 'paid',
    bank_guarantee: hasDocument(app, 'BankGuarantee'),
    undertaking: hasDocument(app, 'Undertaking'),
    form16: hasDocument(app, 'Form16'),
    fire_draw_5: app.documents.some((d) => d.code.startsWith('SitePlan')),
  };
}

// ---------------------------------------------------------------------------
// Citizen action rules (mirrors legacy citizenlist.html ng-if conditions)
// ---------------------------------------------------------------------------

type RuleInput = Pick<ApplicationSummary, 'appl_type' | 'status_id' | 'child_id' | 'host_name' | 'revision'>;

export function canApplyForOccupancy(a: RuleInput): boolean {
  return a.appl_type === 'P' && a.status_id === 7 && a.child_id === 0 && a.host_name !== 'SDP' && a.host_name !== 'MAUD';
}

/** Renewal of an issued Occupancy NOC, or the next periodic renewal of an issued Renewal. */
export function canApplyForRenewal(a: RuleInput): boolean {
  return (a.appl_type === 'O' || a.appl_type === 'R') && a.status_id === 7 && a.child_id === 0 && a.host_name !== 'SDP' && a.host_name !== 'MAUD';
}

export function canRevise(a: Pick<ApplicationSummary, 'status_id'>): boolean {
  return a.status_id === 8 || a.status_id === 9;
}

export function canDelete(a: Pick<ApplicationSummary, 'status_id' | 'revision' | 'host_name'>): boolean {
  return a.status_id === 1 && a.revision <= 1 && a.host_name !== 'SDP';
}

export function canEdit(a: Pick<ApplicationSummary, 'status_id'>): boolean {
  return a.status_id === 1;
}

/** Completed applications (issued or rejected) can be rated by the citizen. */
export function canRate(a: Pick<ApplicationSummary, 'status_id'>): boolean {
  return a.status_id === 7 || a.status_id === 9;
}

/** Only site name and address are needed to save an application (legacy SaveApplication / newapplication.aspx). */
export function saveProblem(app: Pick<Application, 'site_name' | 'site_addr'>): string | null {
  if (!app.site_name?.trim() || !app.site_addr?.trim()) {
    return 'Please provide the Site Name and Site Address to save the application.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Approval level (delegation), fees, renewal periodicity — all admin-configurable
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<DelegationLevel, number> = { DFO: 1, RFO: 2, MSB: 3 };

function matchesType(rule: { site_types: string[]; site_stypes: string[] }, block: Block): boolean {
  if (rule.site_types.length && !rule.site_types.includes(block.site_type)) return false;
  if (rule.site_stypes.length && !rule.site_stypes.map((x) => x.toUpperCase()).includes((block.site_stype ?? '').toUpperCase())) return false;
  return true;
}

/** Approval level of one block: the first matching rule (ordered list, see config/delegation-rules.json). */
export function blockDelegationLevel(block: Block, rules: DelegationRule[]): DelegationLevel {
  const h = Number(block.height) || 0;
  for (const r of rules) {
    if (!matchesType(r, block)) continue;
    if (r.multiplex_only && !block.is_multiplex) continue;
    if (r.min_height != null && (r.min_inclusive ? h < r.min_height : h <= r.min_height)) continue;
    if (r.max_height != null && h >= r.max_height) continue;
    return r.level;
  }
  return 'DFO';
}

/**
 * Approval level of the application: the highest level required by any of its blocks
 * (HQ/MSB > Regional/RFO > District/DFO).
 */
export function computeDelegationLevel(app: Pick<Application, 'blocks'>, rules: DelegationRule[]): DelegationLevel {
  return app.blocks.reduce<DelegationLevel>((level, b) => {
    const l = blockDelegationLevel(b, rules);
    return LEVEL_RANK[l] > LEVEL_RANK[level] ? l : level;
  }, 'DFO');
}

export function delegationLevelName(level: DelegationLevel): string {
  return level === 'MSB' ? 'Head Office (DGFS / MSB)' : level === 'RFO' ? 'Regional Fire Officer' : 'District Fire Officer';
}

/** Renewal period in years for a block (first matching rule, legacy validations/declaration.rule). */
export function blockRenewalYears(block: Block, rules: RenewalRule[]): number {
  const h = Number(block.height) || 0;
  for (const r of rules) {
    if (!matchesType(r, block)) continue;
    if (r.max_height != null && h >= r.max_height) continue;
    return r.years;
  }
  return 1;
}

/** Renewal period of an application: the shortest period required by any block (1 year if no blocks). */
export function renewalPeriodYears(app: Pick<Application, 'blocks'>, rules: RenewalRule[]): number {
  return app.blocks.length ? Math.min(...app.blocks.map((b) => blockRenewalYears(b, rules))) : 1;
}

/** Validity window of an issued certificate: from the issue date for the renewal period (minus one day). */
export function certificateValidity(issuedOn: string, years: number): { valid_from: string; valid_to: string } {
  const from = parseLegacyDate(issuedOn) ?? new Date();
  const to = new Date(from.getFullYear() + years, from.getMonth(), from.getDate() - 1);
  return { valid_from: formatLegacyDate(from), valid_to: formatLegacyDate(to) };
}

export interface FeeBreakdown {
  builtUpArea: number;
  ratePerSqm: number;
  baseFee: number;
  additional: number;
  penaltyYears: number;
  penalty: number;
  total: number;
  /** Part of the total collected by the portal operator (legacy "Portal Charges"). */
  portalCharges: number;
  /** Remainder payable to the Fire Department. */
  departmentFee: number;
  description: string;
}

/** Whole years between the municipal approval date and `now` (legacy: now.getFullYear() - mcdate.getFullYear()). */
export function yearsSince(date: string | undefined, now: Date): number {
  const d = parseLegacyDate(date);
  return d ? Math.max(0, now.getFullYear() - d.getFullYear()) : 0;
}

/**
 * Fire precautionary fee (legacy challan_amt_reqd, see fee-config.json):
 *  P, O, R  built-up area × rate per sq.m of the type
 *  O (not applied for Provisional, mode N): + area × additional per sq.m + area × penalty per sq.m × years since municipal approval
 *  D        flat declaration fee
 * The portal charges are part of (not added to) the total, as in the legacy portal.
 */
export function computeFee(
  app: Pick<Application, 'appl_type' | 'appl_mode' | 'blocks' | 'mcapprove_date'>,
  config: FeeConfig,
  now: Date = new Date(),
): FeeBreakdown {
  const builtUpArea = totalBuiltUpArea(app);
  let ratePerSqm = 0;
  let baseFee: number;
  let additional = 0;
  let penaltyYears = 0;
  let penalty = 0;
  let description: string;
  if (app.appl_type === 'D') {
    baseFee = config.declaration_fee;
    description = `Declaration fee Rs. ${baseFee}`;
  } else {
    ratePerSqm = config.rates_per_sqm[app.appl_type] ?? 0;
    baseFee = Math.round(builtUpArea * ratePerSqm);
    description = `Rs. ${ratePerSqm}/sq.m x ${builtUpArea} sq.m`;
    if (app.appl_type === 'O' && app.appl_mode === 'N') {
      const o = config.occupancy_without_provisional;
      additional = Math.round(builtUpArea * o.additional_per_sqm);
      penaltyYears = yearsSince(app.mcapprove_date, now);
      penalty = Math.round(builtUpArea * o.penalty_per_sqm_per_year * penaltyYears);
    }
  }
  const total = baseFee + additional + penalty;
  const portalCharges = Math.min(config.portal_charges, total);
  return { builtUpArea, ratePerSqm, baseFee, additional, penaltyYears, penalty, total, portalCharges, departmentFee: total - portalCharges, description };
}

/** Legacy application numbers are yyyymm + 4-digit sequence, e.g. 2016080001. */
export function nextApplicationNumber(existingNumbers: string[], now: Date = new Date()): string {
  const prefix = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const maxSeq = existingNumbers
    .filter((n) => n?.startsWith(prefix) && n.length === 10)
    .reduce((max, n) => Math.max(max, Number(n.slice(6)) || 0), 0);
  return prefix + String(maxSeq + 1).padStart(4, '0');
}

export function nextId<T>(items: T[], idOf: (item: T) => number): number {
  return items.reduce((max, item) => Math.max(max, idOf(item)), 0) + 1;
}
