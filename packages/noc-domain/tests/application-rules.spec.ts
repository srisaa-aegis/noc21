import { fixture } from './fixtures.js';
import { Application, Block, DelegationRule, FeeConfig, RenewalRule } from '../src/models/index.js';
import { newBlock } from '../src/application-factory.js';
import {
  blockDelegationLevel,
  blockRenewalYears,
  canApplyForOccupancy,
  canApplyForRenewal,
  canDelete,
  canRate,
  canRevise,
  certificateValidity,
  computeDelegationLevel,
  computeFee,
  nextApplicationNumber,
  renewalPeriodYears,
  saveProblem,
  toSummary,
  totalBuiltUpArea,
  yearsSince,
} from '../src/application-rules.js';

const apps = fixture<Application[]>('assets/data/applications/applications.json');
const byId = (id: number) => structuredClone(apps.find((a) => a.appl_id === id)!);
const delegation = fixture<DelegationRule[]>('assets/data/config/delegation-rules.json');
const renewal = fixture<RenewalRule[]>('assets/data/config/renewal-rules.json');
const fees = fixture<FeeConfig>('assets/data/config/fee-config.json');

function blk(site_type: string, site_stype: string, height: number, area = 1000): Block {
  const b = newBlock(1);
  b.site_type = site_type;
  b.site_stype = site_stype;
  b.height = height;
  b.floors = [{ floor_id: 1, flr_type: 'G', flr_name: 'Ground', built_area: area, occ_type: 'RES', occ_c_app: 0 }];
  return b;
}

describe('application rules', () => {
  it('projects an aggregate to a summary row with derived totals', () => {
    const s = toSummary(byId(101));
    expect(s.built_area).toBe(15850);
    expect(s.height).toBe(24);
    expect(s.flr_count).toBe(11);
    expect(s.challan_paid).toBe(true);
    expect(s.child_id).toBe(102);
    expect(s.rating).toBe(4);
    expect(toSummary(byId(114)).valid_to).toBe('27-Jul-2025');
  });

  it('counts open department document requests', () => {
    expect(toSummary(byId(102)).pending_requests).toBe(1);
    expect(toSummary(byId(101)).pending_requests).toBe(0);
  });

  it('applies the legacy dashboard action rules', () => {
    expect(canApplyForOccupancy(toSummary(byId(101)))).toBe(false); // already has child 102
    expect(canApplyForRenewal(toSummary(byId(111)))).toBe(false); // already renewed (114)
    expect(canApplyForRenewal(toSummary(byId(114)))).toBe(true); // next periodic renewal
    expect(canRevise(toSummary(byId(103)))).toBe(true);
    expect(canRevise(toSummary(byId(101)))).toBe(false);
    expect(canDelete(toSummary(byId(104)))).toBe(true);
    expect(canDelete({ ...toSummary(byId(104)), revision: 2 })).toBe(false);
    expect(canApplyForOccupancy({ ...toSummary(byId(101)), child_id: 0, host_name: 'SDP' })).toBe(false);
  });

  it('lets the citizen rate completed (issued or rejected) applications only', () => {
    expect(canRate(toSummary(byId(101)))).toBe(true);
    expect(canRate(toSummary(byId(103)))).toBe(true);
    expect(canRate(toSummary(byId(105)))).toBe(false); // returned — still in progress
    expect(canRate(toSummary(byId(104)))).toBe(false);
  });

  it('needs only the site name and address to save', () => {
    expect(saveProblem({ site_name: '', site_addr: '' })).toMatch(/Site Name and Site Address/);
    expect(saveProblem({ site_name: 'X', site_addr: '  ' })).not.toBeNull();
    expect(saveProblem({ site_name: 'X', site_addr: 'Y' })).toBeNull();
  });

  describe('approval level (config/delegation-rules.json)', () => {
    it('sends all hazardous, storage and industrial buildings to Head Office (MSB)', () => {
      expect(blockDelegationLevel(blk('haz', 'J1', 6), delegation)).toBe('MSB');
      expect(blockDelegationLevel(blk('sto', 'I1', 4), delegation)).toBe('MSB');
      expect(blockDelegationLevel(blk('ind', 'G1', 5), delegation)).toBe('MSB');
    });
    it('sends multiplexes (Assembly D6 marked as multiplex) to Head Office — a configured rule (legacy MSB.rule)', () => {
      const mx = blk('asm', 'D6', 8);
      expect(blockDelegationLevel(mx, delegation)).toBe('DFO');
      mx.is_multiplex = true;
      expect(blockDelegationLevel(mx, delegation)).toBe('MSB');
      expect(blockDelegationLevel(mx, delegation.filter((r) => !r.multiplex_only))).toBe('DFO');
    });
    it('residential apartments (A4): MSB from 18 m, RFO above 10 m, DFO up to 10 m', () => {
      expect(blockDelegationLevel(blk('res', 'A4', 18), delegation)).toBe('MSB');
      expect(blockDelegationLevel(blk('res', 'A4', 17.9), delegation)).toBe('RFO');
      expect(blockDelegationLevel(blk('res', 'A4', 15), delegation)).toBe('RFO');
      expect(blockDelegationLevel(blk('res', 'A4', 10), delegation)).toBe('DFO');
    });
    it('other buildings: MSB from 15 m, RFO above 10 m, DFO up to 10 m', () => {
      expect(blockDelegationLevel(blk('biz', 'E2', 15), delegation)).toBe('MSB');
      expect(blockDelegationLevel(blk('res', 'A2', 15), delegation)).toBe('MSB');
      expect(blockDelegationLevel(blk('edu', 'B1', 12), delegation)).toBe('RFO');
      expect(blockDelegationLevel(blk('asm', 'D1', 10.01), delegation)).toBe('RFO');
      expect(blockDelegationLevel(blk('mer', 'F1', 10), delegation)).toBe('DFO');
    });
    it('takes the highest level required by any block', () => {
      expect(computeDelegationLevel({ blocks: [blk('res', 'A4', 9), blk('biz', 'E1', 12)] }, delegation)).toBe('RFO');
      expect(computeDelegationLevel({ blocks: [blk('res', 'A4', 9), blk('sto', 'I1', 3)] }, delegation)).toBe('MSB');
      expect(computeDelegationLevel({ blocks: [] }, delegation)).toBe('DFO');
      expect(computeDelegationLevel(byId(101), delegation)).toBe('MSB');
      expect(computeDelegationLevel(byId(108), delegation)).toBe('RFO');
    });
    it('follows edited rules (admin configuration)', () => {
      const edited = delegation.map((r) => (r.id === 4 ? { ...r, min_height: 21 } : r));
      expect(blockDelegationLevel(blk('biz', 'E2', 18), edited)).toBe('RFO');
    });
  });

  describe('renewal periods (config/renewal-rules.json, legacy declaration.rule)', () => {
    it('matches the periodicity table', () => {
      expect(blockRenewalYears(blk('res', 'A4', 59), renewal)).toBe(5);
      expect(blockRenewalYears(blk('res', 'A4', 60), renewal)).toBe(1);
      expect(blockRenewalYears(blk('edu', 'B1', 29), renewal)).toBe(5);
      expect(blockRenewalYears(blk('edu', 'B1', 30), renewal)).toBe(1);
      expect(blockRenewalYears(blk('ins', 'C1', 14), renewal)).toBe(3);
      expect(blockRenewalYears(blk('biz', 'E1', 18), renewal)).toBe(1);
    });
    it('uses the shortest period of all blocks', () => {
      expect(renewalPeriodYears({ blocks: [blk('res', 'A4', 20), blk('biz', 'E1', 20)] }, renewal)).toBe(1);
      expect(renewalPeriodYears({ blocks: [] }, renewal)).toBe(1);
    });
    it('computes the certificate validity window', () => {
      expect(certificateValidity('30-Jul-2019', 3)).toEqual({ valid_from: '30-Jul-2019', valid_to: '29-Jul-2022' });
    });
  });

  describe('fees (config/fee-config.json)', () => {
    it('charges the per-sq.m rate of the type with no minimum; portal charges are part of the total', () => {
      const f = computeFee(byId(101), fees);
      expect(f.builtUpArea).toBe(15850);
      expect(f.ratePerSqm).toBe(10);
      expect(f.total).toBe(158500);
      expect(f.portalCharges).toBe(800);
      expect(f.departmentFee).toBe(157700);
      const tiny = byId(104);
      tiny.blocks[0].floors = [{ ...tiny.blocks[0].floors[0], built_area: 10 }];
      tiny.blocks = [tiny.blocks[0]];
      expect(computeFee(tiny, fees).total).toBe(100);
      expect(computeFee(tiny, fees).portalCharges).toBe(100);
    });
    it('adds the additional fee and yearly penalty for an Occupancy without a Provisional NOC', () => {
      const app = byId(111);
      const area = totalBuiltUpArea(app);
      const f = computeFee(app, fees, new Date(2019, 5, 11));
      expect(f.penaltyYears).toBe(2);
      expect(f.additional).toBe(Math.round(area * 0.1));
      expect(f.penalty).toBe(Math.round(area * 0.24 * 2));
      expect(f.total).toBe(area * 10 + f.additional + f.penalty);
      expect(computeFee(app, fees, new Date(2021, 0, 1)).penaltyYears).toBe(4);
    });
    it('charges the renewal rate and the flat declaration fee', () => {
      expect(computeFee(byId(114), fees).total).toBe(totalBuiltUpArea(byId(114)) * 2);
      expect(computeFee(byId(107), fees).total).toBe(2000);
    });
    it('follows edited rates', () => {
      const edited: FeeConfig = { ...fees, rates_per_sqm: { ...fees.rates_per_sqm, P: 12.5 }, portal_charges: 0 };
      const f = computeFee(byId(101), edited);
      expect(f.total).toBe(198125);
      expect(f.portalCharges).toBe(0);
    });
  });

  it('counts penalty years by calendar year (legacy getFullYear difference)', () => {
    expect(yearsSince('15-Mar-2017', new Date(2019, 0, 1))).toBe(2);
    expect(yearsSince('', new Date())).toBe(0);
  });

  it('generates yyyymm + sequence application numbers', () => {
    const now = new Date(2024, 0, 20);
    expect(nextApplicationNumber(['2023120005'], now)).toBe('2024010001');
    expect(nextApplicationNumber(['2024010055', '2024010009', ''], now)).toBe('2024010056');
  });
});
