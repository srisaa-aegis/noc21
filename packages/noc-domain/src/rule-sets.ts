/**
 * The NOC rule-set catalogue: the codes under which the portal's business rules
 * are stored in the rules engine, and lossless converters between the engine's
 * generic shapes and the NOC-facing shapes the admin UI uses
 * (DelegationRule[], RenewalRule[], FeeConfig, EscapeRules).
 *
 * Used by the seeder (JSON fixtures → rule sets), by the admin API façades
 * (`GET/PUT /config/...`) and by the parity tests.
 */
import type { DecisionTableDefinition, ParameterSetDefinition, TableRow } from '@srisaa/rules-engine';
import type { DelegationRule, EscapeRules, FeeConfig, RenewalRule } from './models/index.js';

export const RULE_SETS = {
  approvalLevel: 'noc.approval_level',
  renewalPeriod: 'noc.renewal_period',
  fees: 'noc.fees',
  escapeLimits: 'noc.escape_limits',
  heightLimits: 'noc.height_limits',
  ffeType: 'noc.ffe.type',
  ffeOtherNotes: 'noc.ffe.other_notes',
  ffeRiserWidth: 'noc.ffe.riser_width',
  /** Per equipment id (1..12). */
  ffeEquipment: (id: number | string) => `noc.ffe.equipment.${id}`,
} as const;

export const LEVEL_RANK_ORDER = ['DFO', 'RFO', 'MSB'];

// ---------------------------------------------------------------------------
// Approval level (delegation)
// ---------------------------------------------------------------------------

export function delegationRulesToTable(rules: DelegationRule[]): DecisionTableDefinition {
  const rows: TableRow[] = rules.map((r, i) => {
    const when: TableRow['when'] = [];
    if (r.site_types.length) when.push({ fact: 'site_type', op: 'in', value: r.site_types });
    if (r.site_stypes.length) when.push({ fact: 'site_stype', op: 'in', value: r.site_stypes });
    if (r.multiplex_only) when.push({ fact: 'is_multiplex', op: 'isTrue' });
    if (r.min_height != null) when.push({ fact: 'height', op: r.min_inclusive ? 'ge' : 'gt', value: r.min_height });
    if (r.max_height != null) when.push({ fact: 'height', op: 'lt', value: r.max_height });
    if (!when.length) when.push({ fact: 'height', op: 'any' });
    return { id: r.id, ordinal: i + 1, label: r.label, when, then: { level: r.level } };
  });
  return {
    hitPolicy: 'FIRST',
    rows,
    default: { level: 'DFO' },
    aggregation: { output: 'level', mode: 'MAX_RANK', order: LEVEL_RANK_ORDER },
  };
}

export function tableToDelegationRules(table: DecisionTableDefinition): DelegationRule[] {
  return table.rows
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => {
      const cond = (fact: string, ops: string[]) => row.when.find((c) => c.fact === fact && ops.includes(c.op));
      const min = cond('height', ['ge', 'gt']);
      const max = cond('height', ['lt']);
      const types = cond('site_type', ['in']);
      const stypes = cond('site_stype', ['in']);
      return {
        id: Number(row.id),
        level: (row.then as { level: DelegationRule['level'] }).level,
        label: row.label ?? '',
        site_types: (types?.value as string[]) ?? [],
        site_stypes: (stypes?.value as string[]) ?? [],
        min_height: min ? Number(min.value) : null,
        min_inclusive: min ? min.op === 'ge' : true,
        max_height: max ? Number(max.value) : null,
        ...(row.when.some((c) => c.fact === 'is_multiplex') ? { multiplex_only: true } : {}),
      } as DelegationRule;
    });
}

// ---------------------------------------------------------------------------
// Renewal periodicity
// ---------------------------------------------------------------------------

export function renewalRulesToTable(rules: RenewalRule[]): DecisionTableDefinition {
  const rows: TableRow[] = rules.map((r, i) => {
    const when: TableRow['when'] = [];
    if (r.site_types.length) when.push({ fact: 'site_type', op: 'in', value: r.site_types });
    if (r.site_stypes.length) when.push({ fact: 'site_stype', op: 'in', value: r.site_stypes });
    if (r.max_height != null) when.push({ fact: 'height', op: 'lt', value: r.max_height });
    if (!when.length) when.push({ fact: 'height', op: 'any' });
    return { id: r.id, ordinal: i + 1, label: r.label, when, then: { years: r.years } };
  });
  return {
    hitPolicy: 'FIRST',
    rows,
    default: { years: 1 },
    aggregation: { output: 'years', mode: 'MIN' },
  };
}

export function tableToRenewalRules(table: DecisionTableDefinition): RenewalRule[] {
  return table.rows
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => {
      const max = row.when.find((c) => c.fact === 'height' && c.op === 'lt');
      const types = row.when.find((c) => c.fact === 'site_type' && c.op === 'in');
      const stypes = row.when.find((c) => c.fact === 'site_stype' && c.op === 'in');
      return {
        id: Number(row.id),
        label: row.label ?? '',
        site_types: (types?.value as string[]) ?? [],
        site_stypes: (stypes?.value as string[]) ?? [],
        max_height: max ? Number(max.value) : null,
        years: Number((row.then as { years: number }).years),
      };
    });
}

// ---------------------------------------------------------------------------
// Parameter sets
// ---------------------------------------------------------------------------

export function feeConfigToParameters(config: FeeConfig): ParameterSetDefinition {
  return {
    values: {
      portal_charges: config.portal_charges,
      declaration_fee: config.declaration_fee,
      rates_per_sqm: config.rates_per_sqm,
      occupancy_without_provisional: config.occupancy_without_provisional,
    },
  };
}

export function parametersToFeeConfig(params: ParameterSetDefinition): FeeConfig {
  const v = params.values as unknown as FeeConfig;
  return {
    portal_charges: Number(v.portal_charges),
    declaration_fee: Number(v.declaration_fee),
    rates_per_sqm: v.rates_per_sqm ?? {},
    occupancy_without_provisional: {
      additional_per_sqm: Number(v.occupancy_without_provisional?.additional_per_sqm ?? 0),
      penalty_per_sqm_per_year: Number(v.occupancy_without_provisional?.penalty_per_sqm_per_year ?? 0),
    },
  };
}

export function escapeRulesToParameters(rules: EscapeRules): ParameterSetDefinition {
  const { ...values } = rules as unknown as Record<string, unknown>;
  delete values['_source'];
  return { values };
}

export function parametersToEscapeRules(params: ParameterSetDefinition): EscapeRules {
  return params.values as unknown as EscapeRules;
}

/** Facts of one block, as the approval-level and renewal tables expect them. */
export function blockFacts(block: { site_type: string; site_stype: string; height: number; is_multiplex?: boolean }) {
  return {
    site_type: block.site_type,
    site_stype: block.site_stype,
    height: Number(block.height) || 0,
    is_multiplex: !!block.is_multiplex,
  };
}
