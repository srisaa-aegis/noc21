import { fixture } from './fixtures.js';
import { DelegationRule, FeeConfig, RenewalRule } from '../src/models/index.js';
import { delegationRuleProblems, feeConfigProblems, renewalRuleProblems } from '../src/config-rules.js';

const fees = fixture<FeeConfig>('assets/data/config/fee-config.json');
const levels = fixture<DelegationRule[]>('assets/data/config/delegation-rules.json');
const renewals = fixture<RenewalRule[]>('assets/data/config/renewal-rules.json');

describe('admin rule configuration checks', () => {
  it('accepts the shipped configuration', () => {
    expect(feeConfigProblems(fees)).toEqual([]);
    expect(delegationRuleProblems(levels)).toEqual([]);
    expect(renewalRuleProblems(renewals)).toEqual([]);
  });

  it('rejects negative fees and rates', () => {
    const bad: FeeConfig = { ...fees, portal_charges: -1, rates_per_sqm: { ...fees.rates_per_sqm, O: -2 } };
    expect(feeConfigProblems(bad)).toEqual(['Portal charges must be zero or more.', 'Rate per sq.m for type O must be zero or more.']);
  });

  it('requires a description, a valid height range and a catch-all last approval rule', () => {
    const edited = structuredClone(levels);
    edited[0].label = '';
    edited[1].min_height = 20;
    edited[1].max_height = 18;
    expect(delegationRuleProblems(edited)).toEqual(['Rule 1: enter a description.', 'Rule 2: maximum height must be greater than the minimum height.']);
    expect(delegationRuleProblems(levels.slice(0, 3))[0]).toContain('last rule must apply to all remaining buildings');
    expect(delegationRuleProblems([])[0]).toContain('At least one');
  });

  it('requires whole-year renewal periods between 1 and 10 and a catch-all last rule', () => {
    const edited = structuredClone(renewals);
    edited[0].years = 0;
    edited[1].years = 2.5;
    expect(renewalRuleProblems(edited)).toHaveLength(2);
    expect(renewalRuleProblems(renewals.slice(0, 2))[0]).toContain('last rule');
  });
});
