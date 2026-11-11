import { fixture } from './fixtures.js';
import { Application, OccupancyCondition, PartyRole, UserAccount } from '../src/models/index.js';
import { newBlock, newDraft, occupancyFromProvisional, renewalFromOccupancy } from '../src/application-factory.js';
import { reqdOpenSpace } from '../src/commonrules.js';
import { BLOCK_STEPS, stepsFor } from '../src/wizard-steps.js';

const roles = fixture<PartyRole[]>('assets/data/lookups/party-roles.json');
const conditions = fixture<OccupancyCondition[]>('assets/data/lookups/occupancy-conditions.json');
const citizen = fixture<UserAccount[]>('assets/data/auth/users.json')[0];
const apps = fixture<Application[]>('assets/data/applications/applications.json');
const byId = (id: number) => structuredClone(apps.find((a) => a.appl_id === id)!);

describe('application factory', () => {
  it('creates a Provisional draft pre-filled from the citizen account with the party roles and one block', () => {
    const d = newDraft(0, 'P', citizen, roles);
    expect(d.appl_id).toBe(0);
    expect(d.status_id).toBe(1);
    expect(d.owner).toBe('citizen1');
    expect(d.build_name).toBe(citizen.displayName);
    expect(d.parties.map((p) => p.role_name)).toEqual(roles.map((r) => r.role_name));
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0].sides.map((s) => s.direc)).toEqual(['N', 'E', 'S', 'W']);
    expect(d.blocks[0].ffe).toEqual({ items: [], notes: [], agree_reqt: false });
  });

  it('creates an Occupancy draft (without PNOC) with the PNOC conditions checklist unanswered', () => {
    const d = newDraft(0, 'O', citizen, roles, new Date(), conditions);
    expect(d.appl_mode).toBe('N');
    expect(d.conditions).toHaveLength(conditions.length);
    expect(d.conditions!.every((c) => c.selected === null)).toBe(true);
  });

  it('creates a Declaration draft without blocks or parties, in manual-reference mode', () => {
    const d = newDraft(0, 'D', citizen, roles);
    expect(d.blocks).toEqual([]);
    expect(d.parties).toEqual([]);
    expect(d.appl_mode).toBe('M');
  });

  it('creates Tower / Podium blocks with the legacy block type', () => {
    expect(newBlock(2, 'T').block_type).toBe('T');
    expect(newBlock(3, 'P').block_name).toBe('Block C');
  });

  it('carries an issued Provisional forward into an Occupancy draft (required -> proposed, PNOC values kept)', () => {
    const parent = byId(101);
    const child = occupancyFromProvisional(parent, 300, new Date(), conditions);
    expect(child.appl_type).toBe('O');
    expect(child.appl_mode).toBe('O');
    expect(child.parent_id).toBe(101);
    expect(child.ref_no).toBe('2016080001');
    expect(child.status_id).toBe(1);
    expect(child.appl_number).toBe('');
    expect(child.documents).toEqual([]);
    expect(child.processLog).toEqual([]);
    expect(child.payment.status).toBe('pending');
    expect(child.feedback).toBeUndefined();
    const pItem = parent.blocks[0].ffe.items[0];
    const cItem = child.blocks[0].ffe.items[0];
    expect(cItem.equip_id).toBe(pItem.equip_id);
    const fid = Object.keys(pItem.floors)[0];
    if (pItem.level === 'F') {
      expect(cItem.floors[fid].prop).toEqual(pItem.floors[fid].reqt);
      expect(cItem.floors[fid].prov).toBeNull();
    }
    expect(child.blocks[0].ffe.agree_reqt).toBe(false);
    expect(child.blocks[0].floors[2].parent_built_area).toBe(parent.blocks[0].floors[2].built_area);
    expect(child.blocks[0].ospaces[0].parent_proposed).toBe(parent.blocks[0].ospaces[0].proposed);
    expect(child.blocks[0].ospaces[0].os_preqd).toBe(reqdOpenSpace(parent.blocks[0], parent.blocks[0].ospaces[0].direc, parent.plot_area, 'P', ''));
    expect(child.conditions).toHaveLength(conditions.length);
    // Deep copy: editing the child never touches the parent.
    child.blocks[0].block_name = 'changed';
    expect(parent.blocks[0].block_name).toBe('Block A');
  });

  it('carries an issued Occupancy forward into a Renewal draft (provided -> proposed, NOC number as reference)', () => {
    const parent = byId(111);
    const child = renewalFromOccupancy(parent, 301);
    expect(child.appl_type).toBe('R');
    expect(child.ref_no).toBe(parent.appl_number);
    const pItem = parent.blocks[0].ffe.items.find((i) => i.level === 'B')!;
    const cItem = child.blocks[0].ffe.items.find((i) => i.equip_id === pItem.equip_id)!;
    expect(cItem.block.prop).toEqual(pItem.block.prov ?? pItem.block.reqt);
    expect(cItem.block.prov).toBeNull();
  });

  it('keeps the original Occupancy NOC reference for the next periodic renewal', () => {
    const renewal = byId(114);
    const child = renewalFromOccupancy(renewal, 302);
    expect(child.ref_no).toBe(renewal.ref_no);
  });

  it('uses application pages + a per-block flow for P/O/R and a 3-page form for Declarations', () => {
    expect(stepsFor('P').map((s) => s.id)).toEqual(['basic', 'blocks', 'documents', 'submit']);
    expect(stepsFor('D').map((s) => s.id)).toEqual(['basic', 'documents', 'submit']);
    expect(BLOCK_STEPS.map((s) => s.id)).toEqual(['details', 'floors', 'escapes', 'ffe', 'plans']);
  });
});
