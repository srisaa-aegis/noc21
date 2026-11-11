import { fixture } from './fixtures.js';
import {
  Application,
  ApplicationType,
  BuildType,
  DocumentRequirements,
  Equipment,
  EscapeRules,
  FeeConfig,
  PartyRole,
  RuleTree,
  UserAccount,
} from '../src/models/index.js';
import { newDraft } from '../src/application-factory.js';
import { reqdOpenSpace } from '../src/commonrules.js';
import { parseLegacyDate } from '../src/dates.js';
import { ValidationContext, blockErrors, errorsFor, validateApplication } from '../src/validation.js';
import { BlockStepId } from '../src/wizard-steps.js';

const ctx: ValidationContext = {
  applicationTypes: fixture<ApplicationType[]>('assets/data/lookups/application-types.json'),
  buildTypes: fixture<BuildType[]>('assets/data/lookups/build-types.json'),
  partyRoles: fixture<PartyRole[]>('assets/data/lookups/party-roles.json'),
  documentRequirements: fixture<DocumentRequirements>('assets/data/lookups/document-requirements.json'),
  escapeRules: fixture<EscapeRules>('assets/data/lookups/escape-rules.json'),
  heightLimits: fixture<RuleTree>('assets/data/rules/height-limits.json'),
  feeConfig: fixture<FeeConfig>('assets/data/config/fee-config.json'),
  equipments: fixture<Equipment[]>('assets/data/lookups/equipments.json'),
};
const citizen = fixture<UserAccount[]>('assets/data/auth/users.json')[0];
const apps = fixture<Application[]>('assets/data/applications/applications.json');
const byId = (id: number) => structuredClone(apps.find((a) => a.appl_id === id)!);
const fields = (app: Application, step: Parameters<typeof errorsFor>[1], c: ValidationContext = ctx) => errorsFor(validateApplication(app, c), step).map((i) => i.field);
const blockFields = (app: Application, block: number, page: BlockStepId, c: ValidationContext = ctx) =>
  blockErrors(validateApplication(app, c), block, page).map((i) => i.field);
/** Seeds are validated as of their application date (fee penalty years). */
const asOf = (app: Application): ValidationContext => ({ ...ctx, now: parseLegacyDate(app.applied_date) ?? undefined });

describe('validateApplication (submission validation)', () => {
  it('flags every mandatory basic field on a blank Provisional draft', () => {
    const draft = newDraft(0, 'P', citizen, ctx.partyRoles);
    const f = fields(draft, 'basic');
    expect(f).toEqual(
      expect.arrayContaining(['site_name', 'site_addr', 'district', 'fire_station_id', 'lic_auth', 'lic_addr', 'plot_area', 'perimeter', 'parties.1.party_name', 'parties.2.party_name']),
    );
    // Builder details are pre-filled from the account.
    expect(f).not.toContain('build_name');
    expect(f).not.toContain('build_email');
  });

  it('does not require licensing authority or parties for a Declaration but requires the NOC reference and inspection date', () => {
    const draft = newDraft(0, 'D', citizen, ctx.partyRoles);
    const f = fields(draft, 'basic');
    expect(f).not.toContain('lic_auth');
    expect(f.some((x) => x.startsWith('parties'))).toBe(false);
    expect(f).toEqual(expect.arrayContaining(['ref_no', 'last_inspect_date', 'noc_level']));
    // the level of the Occupancy NOC decides the workflow of the declaration
    expect(fields({ ...draft, noc_level: 'RFO' }, 'basic')).not.toContain('noc_level');
  });

  it('requires the municipal approval date and the PNOC conditions for Occupancy', () => {
    const app = byId(111);
    app.mcapprove_date = '';
    expect(fields(app, 'basic')).toContain('mcapprove_date');
    const occ = byId(102);
    occ.conditions![0].selected = null;
    expect(fields(occ, 'basic')).toContain('conditions.0');
  });

  it('Occupancy with a manual Provisional NOC needs its Rc. No.; without one the PNOC conditions do not apply', () => {
    const manual = byId(105);
    manual.ref_no = '';
    expect(fields(manual, 'basic')).toContain('ref_no');
    const without = newDraft(0, 'O', citizen, ctx.partyRoles, new Date(), [{ checklist_id: 1, item_desc: 'x' }]);
    expect(without.appl_mode).toBe('N');
    expect(fields(without, 'basic')).not.toContain('conditions.0');
    without.appl_mode = 'M';
    expect(fields(without, 'basic')).toEqual(expect.arrayContaining(['conditions.0', 'ref_no']));
  });

  it('validates contact formats', () => {
    const app = byId(101);
    app.build_mobile = '12345';
    app.build_email = 'not-an-email';
    expect(fields(app, 'basic')).toEqual(expect.arrayContaining(['build_mobile', 'build_email']));
  });

  it('requires the sub-type to belong to the type and enforces the height.rule maximum', () => {
    const app = byId(108);
    app.blocks[0].site_type = 'edu';
    app.blocks[0].site_stype = 'A4';
    app.blocks[0].height = 45; // edu max 30 m
    const f = fields(app, 'blocks');
    expect(f).toContain('blocks.0.site_stype');
    expect(f).toContain('blocks.0.height');
  });

  it('blocks submission when the proposed open space is below the commonrules requirement', () => {
    const app = byId(103);
    const reqd = reqdOpenSpace(app.blocks[0], 'N', app.plot_area, 'P', '');
    expect(app.blocks[0].ospaces[0].proposed).toBeLessThan(reqd);
    const issue = validateApplication(app, ctx).find((i) => i.field === 'blocks.0.ospaces.0.proposed')!;
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain(`${reqd} m`);
  });

  it('limits projections into open spaces and requires road-widening figures when land was surrendered', () => {
    const app = byId(108);
    app.blocks[0].ospaces[0].projection = 1.2;
    app.blocks[0].road_wide = true;
    const f = fields(app, 'blocks');
    expect(f).toContain('blocks.0.ospaces.0.projection');
    expect(f).toContain('blocks.0.roadwidening.0.rw_reqd');
  });

  it('requires a road width for road-facing sides and the front direction', () => {
    const app = byId(108);
    const road = app.blocks[0].sides.findIndex((s) => s.ptype === 'R');
    app.blocks[0].sides[road].width = 0;
    app.blocks[0].front_dir = '';
    expect(fields(app, 'blocks')).toEqual(expect.arrayContaining([`blocks.0.sides.${road}.width`, 'blocks.0.front_dir']));
  });

  it('checks means of escape: staircase count/width, travel distance, refuge areas and fire lifts', () => {
    const app = byId(109); // 33 m apartments
    app.blocks[0].escapes = [{ escape_id: 1, etype: 'E', desc: 'Ext', width: 0.5, location: 'W' }];
    app.blocks[0].ta_dist = 99;
    app.blocks[0].refuges = [];
    app.blocks[0].lifts = [];
    const f = blockFields(app, 0, 'escapes');
    expect(f).toEqual(expect.arrayContaining(['blocks.0.escapes', 'blocks.0.escapes.0.width', 'blocks.0.ta_dist', 'blocks.0.refuges', 'blocks.0.lifts']));
  });

  it('requires the FFE confirmation for a Provisional NOC', () => {
    const app = byId(101);
    app.blocks[0].ffe.agree_reqt = false;
    expect(blockFields(app, 0, 'ffe')).toContain('blocks.0.ffe.agree_reqt');
  });

  it('requires the provided quantities for Occupancy (one message per system) and warns on shortfalls', () => {
    const app = byId(111);
    const ext = app.blocks[0].ffe.items.findIndex((i) => i.equip_id === 2);
    app.blocks[0].ffe.items[ext].floors['1'].prov = null;
    const issues = validateApplication(app, asOf(app)).filter((i) => i.blockStep === 'ffe');
    const missing = issues.filter((i) => i.field === `blocks.0.ffe.items.${ext}.prov`);
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('Fire Extinguishers');
    app.blocks[0].ffe.items[ext].floors['1'].prov = 0;
    const warn = validateApplication(app, asOf(app)).find((i) => i.field === `blocks.0.ffe.items.${ext}.short`);
    expect(warn?.severity).toBe('warning');
  });

  it('flags missing documents, unpaid / short fee and the verification tick', () => {
    const app = byId(104);
    const issues = validateApplication(app, ctx);
    expect(errorsFor(issues, 'documents').length).toBeGreaterThan(0);
    expect(errorsFor(issues, 'submit').map((i) => i.field)).toEqual(['payment', 'declaration_accepted']);
    const paid = byId(101);
    paid.payment.amount = 100;
    expect(errorsFor(validateApplication(paid, asOf(paid)), 'submit')[0].message).toMatch(/Insufficient fee/);
  });

  it('files every block issue under its block and the page of the block flow', () => {
    const app = byId(101);
    app.blocks[1].height = 0; // Club House → Block Details
    app.blocks[1].floors[0].built_area = 0; // → Floors
    app.blocks[1].escapes[0].width = 0; // → Means of Escape
    app.blocks[1].ffe.agree_reqt = false; // → Fire Fighting Equipment
    app.documents = app.documents.filter((d) => d.code !== 'SitePlan:2'); // → Plans
    const issues = validateApplication(app, asOf(app)).filter((i) => i.step === 'blocks');
    expect(issues.every((i) => i.block === 1 && i.blockStep)).toBe(true);
    expect(blockErrors(issues, 1, 'details').map((i) => i.field)).toContain('blocks.1.height');
    expect(blockErrors(issues, 1, 'floors').map((i) => i.field)).toContain('blocks.1.floors.0.built_area');
    expect(blockErrors(issues, 1, 'escapes').map((i) => i.field)).toContain('blocks.1.escapes.0.width');
    expect(blockErrors(issues, 1, 'ffe').map((i) => i.field)).toContain('blocks.1.ffe.agree_reqt');
    expect(blockErrors(issues, 1, 'plans').map((i) => i.field)).toEqual(['doc.SitePlan:2']);
    expect(blockErrors(issues, 0)).toEqual([]);
  });

  it('passes basic/blocks/escapes/ffe/submit for the seeded submitted applications', () => {
    for (const id of [101, 102, 106, 108, 109, 110, 111, 114]) {
      const app = byId(id);
      for (const step of ['basic', 'blocks', 'submit'] as const) {
        expect(fields(app, step, asOf(app)), `${step} for ${id}`).toEqual([]);
      }
    }
  });
});
