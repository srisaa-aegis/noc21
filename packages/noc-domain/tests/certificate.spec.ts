import { fixture } from './fixtures.js';
import { Application, NocTerms } from '../src/models/index.js';
import {
  buildingClass,
  copyToLines,
  decisionStep,
  fromLines,
  inspectionDate,
  isRevisedProvisional,
  letterDate,
  renewalPeriodLabel,
  signatoryLines,
  termsHtmlForHeight,
} from '../src/certificate.js';

const apps = fixture<Application[]>('assets/data/applications/applications.json');
const byId = (id: number) => structuredClone(apps.find((a) => a.appl_id === id)!);
const terms = fixture<NocTerms>('assets/data/lookups/noc-terms.json');

describe('legal document facts (final_noc_16 / final_noc_o / final_noc_r / rejection)', () => {
  it('takes the inspection date and the decision remarks from the process log', () => {
    const a = byId(101);
    expect(inspectionDate(a)).toBe('20-Aug-2016');
    expect(decisionStep(a)?.role).toBe('DG');
    expect(letterDate('28-Sep-2016')).toBe('28/09/2016');
  });

  it('prints "Revised" Provisional NOCs when the site name says so (legacy rule)', () => {
    expect(isRevisedProvisional({ appl_type: 'P', site_name: 'Padma Rekha (Revised)' })).toBe(true);
    expect(isRevisedProvisional({ appl_type: 'O', site_name: 'Revised' })).toBe(false);
  });

  it('words MSB vs Non-MSB buildings and the renewal period', () => {
    expect(buildingClass('MSB')).toBe('Multi Storeyed Building');
    expect(buildingClass('DFO')).toBe('Non Multi Storeyed Building');
    expect(renewalPeriodLabel('28-Jul-2022', '27-Jul-2025')).toBe('2022-2025');
  });

  it('signs by approval level (DG for HQ NOCs, Director for HQ renewals)', () => {
    expect(signatoryLines('P', 'MSB', 'Krishna')).toContain('Prisons and Correctional Services');
    expect(signatoryLines('R', 'MSB', 'Krishna')[0]).toBe('Director');
    expect(signatoryLines('O', 'RFO', 'Krishna')).toEqual(['Regional Fire Officer', 'Andhra Pradesh, Vijayawada']);
    expect(signatoryLines('P', 'DFO', 'Guntur')).toEqual(['District Fire Officer', 'Andhra Pradesh, Guntur']);
    expect(signatoryLines('REJECTION', 'MSB', '', 'DFS')[0]).toBe('Director');
    expect(fromLines('REJECTION', 'MSB', '', 'DG')[0]).toBe('Director General');
  });

  it('lists the "Copy to" recipients by level', () => {
    const a = byId(101);
    expect(copyToLines('P', 'MSB', a)).toEqual([
      `${a.build_name}, ${a.corr_addr}`,
      'Chief Office for Record Purpose',
      'Regional Fire Officer concerned',
      'District Fire Officer concerned',
      'Assistant District Fire Officer concerned',
    ]);
    expect(copyToLines('P', 'DFO', a)).toHaveLength(3);
    expect(copyToLines('R', 'DFO', a)[0]).toMatch(/^Management /);
    expect(copyToLines('REJECTION', 'DFO', a)).toHaveLength(5);
  });

  it('prints the conditions for buildings above 60 m only when applicable', () => {
    const html = terms.P.MSB;
    expect(html).toContain('cond-height-gt-60');
    expect(termsHtmlForHeight(html, 24)).not.toContain('Emergency Action Plan');
    expect(termsHtmlForHeight(html, 70)).toContain('Emergency Action Plan');
    expect(termsHtmlForHeight(html, 24)).toContain('does not confer any ownership rights');
  });
});
