import { fixture } from './fixtures.js';
import { Application, DocumentRequirements } from '../src/models/index.js';
import { requiredDocuments, validateUpload } from '../src/documents.js';

const reqs = fixture<DocumentRequirements>('assets/data/lookups/document-requirements.json');
const apps = fixture<Application[]>('assets/data/applications/applications.json');
const byId = (id: number) => structuredClone(apps.find((a) => a.appl_id === id)!);

describe('required documents', () => {
  it('requires the full MSB document set and per-block/per-floor plans for a Provisional NOC', () => {
    const app = byId(101);
    const codes = requiredDocuments(app, reqs).map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['ChallanCopy', 'Undertaking', 'BankGuarantee', 'SelfDeclaration', 'FFEEstimate', 'SitePlan:1', 'SitePlan:2', 'FloorPlan:1:1', 'FloorPlan:2:2']));
    expect(codes).not.toContain('ProofSurrender');
  });

  it('drops undertaking / bank guarantee / estimate at DFO level and challan copy for online payment (legacy ng-if rules)', () => {
    const app = byId(101);
    app.delegation_level = 'DFO';
    app.payment.mode = 'online';
    const codes = requiredDocuments(app, reqs).map((d) => d.code);
    expect(codes).not.toContain('Undertaking');
    expect(codes).not.toContain('BankGuarantee');
    expect(codes).not.toContain('ChallanCopy');
  });

  it('requires proof of surrender when road widening relaxation is claimed', () => {
    const app = byId(101);
    app.blocks[0].road_wide = true;
    expect(requiredDocuments(app, reqs).map((d) => d.code)).toContain('ProofSurrender');
  });

  it('requires the Provisional NOC copy only for Occupancy carried forward from one', () => {
    expect(requiredDocuments(byId(102), reqs).map((d) => d.code)).toContain('ProNOC');
    expect(requiredDocuments(byId(111), reqs).map((d) => d.code)).not.toContain('ProNOC');
  });

  it('has no plans for Declarations', () => {
    expect(requiredDocuments(byId(107), reqs).every((d) => d.group === 'general')).toBe(true);
  });

  it('accepts only PDFs up to 10 MB', () => {
    expect(validateUpload({ name: 'plan.pdf', size: 1000 })).toBeNull();
    expect(validateUpload({ name: 'plan.docx', size: 1000 })).toContain('PDF');
    expect(validateUpload({ name: 'plan.pdf', size: 11 * 1024 * 1024 })).toContain('10 MB');
  });
});
