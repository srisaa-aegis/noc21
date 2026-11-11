/**
 * Validation of the admin-configurable rules (fees, approval levels, renewal periods) before they
 * are saved — the admin UI (features/admin/rules-config) and the mock API share these checks.
 */
import { DelegationRule, FeeConfig, RenewalRule } from './models/index.js';

const nonNegative = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const LEVELS = ['MSB', 'RFO', 'DFO'];

export function feeConfigProblems(c: FeeConfig): string[] {
  const out: string[] = [];
  if (!nonNegative(c.portal_charges)) out.push('Portal charges must be zero or more.');
  if (!nonNegative(c.declaration_fee)) out.push('Declaration fee must be zero or more.');
  for (const [type, rate] of Object.entries(c.rates_per_sqm ?? {})) {
    if (!nonNegative(rate)) out.push(`Rate per sq.m for type ${type} must be zero or more.`);
  }
  if (!nonNegative(c.occupancy_without_provisional?.additional_per_sqm)) out.push('Additional fee per sq.m must be zero or more.');
  if (!nonNegative(c.occupancy_without_provisional?.penalty_per_sqm_per_year)) out.push('Penalty per sq.m per year must be zero or more.');
  return out;
}

export function delegationRuleProblems(rules: DelegationRule[]): string[] {
  const out: string[] = [];
  if (!rules.length) out.push('At least one approval level rule is required.');
  rules.forEach((r, i) => {
    const n = `Rule ${i + 1}`;
    if (!r.label?.trim()) out.push(`${n}: enter a description.`);
    if (!LEVELS.includes(r.level)) out.push(`${n}: select the approval level.`);
    if (r.min_height != null && !nonNegative(r.min_height)) out.push(`${n}: minimum height must be zero or more.`);
    if (r.max_height != null && !nonNegative(r.max_height)) out.push(`${n}: maximum height must be zero or more.`);
    if (r.min_height != null && r.max_height != null && r.max_height <= r.min_height) out.push(`${n}: maximum height must be greater than the minimum height.`);
  });
  const last = rules[rules.length - 1];
  if (last && (last.site_types.length || last.site_stypes.length || last.min_height != null || last.max_height != null || last.multiplex_only)) {
    out.push('The last rule must apply to all remaining buildings (no occupancy or height conditions).');
  }
  return out;
}

export function renewalRuleProblems(rules: RenewalRule[]): string[] {
  const out: string[] = [];
  if (!rules.length) out.push('At least one renewal period rule is required.');
  rules.forEach((r, i) => {
    const n = `Rule ${i + 1}`;
    if (!r.label?.trim()) out.push(`${n}: enter a description.`);
    if (!(Number.isInteger(r.years) && r.years >= 1 && r.years <= 10)) out.push(`${n}: period must be a whole number of years between 1 and 10.`);
    if (r.max_height != null && !(r.max_height > 0)) out.push(`${n}: height limit must be greater than zero.`);
  });
  const last = rules[rules.length - 1];
  if (last && (last.site_types.length || last.site_stypes.length || last.max_height != null)) {
    out.push('The last rule must apply to all remaining buildings (no occupancy or height conditions).');
  }
  return out;
}
