import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { DelegationRule, FeeConfig } from '../../../core/models';
import { FakeApi, fixture, provideFakeApi } from '../../../../testing/fake-api';
import { resetBrowserState, seedSession } from '../../../../testing/session';
import { ApplicationsService } from '../applications.service';
import { ApplicationDraftStore } from './application-draft.store';

describe('ApplicationDraftStore', () => {
  let store: ApplicationDraftStore;

  beforeEach(() => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    TestBed.configureTestingModule({ providers: [ApplicationDraftStore, provideFakeApi()] });
    store = TestBed.inject(ApplicationDraftStore);
  });

  afterEach(() => resetBrowserState());

  const persisted = (id: number) => firstValueFrom(TestBed.inject(ApplicationsService).get(id));
  const all = () => firstValueFrom(TestBed.inject(ApplicationsService).listMine('citizen1'));

  it('loads a draft with its lookups and derives fee, approval level and the FFE grid', async () => {
    await store.load('104', 'citizen1');
    const app = store.app()!;
    expect(store.steps().map((s) => s.id)).toEqual(['basic', 'blocks', 'documents', 'submit']);
    expect(app.delegation_level).toBe('MSB'); // business 16 m ≥ 15 m
    expect(app.blocks[0].ffe.items.length).toBeGreaterThan(0);
    expect(store.fee()?.total).toBe(35000); // 3500 sq.m × Rs. 10
    expect(app.payment.amount).toBe(35000);
    expect(store.saveState()).toBe('saved');
    expect(store.isNew()).toBe(false);
  });

  it('uses the admin-configured approval levels and fees', async () => {
    // the published rule versions arrive with the rules bundle
    const api = TestBed.inject(FakeApi);
    api.delegationRules = fixture<DelegationRule[]>('assets/data/config/delegation-rules.json').map((r) => (r.id === 4 ? { ...r, min_height: 18 } : r));
    api.feeConfig = { ...fixture<FeeConfig>('assets/data/config/fee-config.json'), rates_per_sqm: { P: 12, O: 10, R: 2 } } as never;
    await store.load('104', 'citizen1');
    expect(store.app()!.delegation_level).toBe('RFO'); // 16 m is now below the HQ threshold
    expect(store.fee()?.total).toBe(42000);
  });

  it('a Declaration takes the approval level of the Occupancy NOC being renewed', async () => {
    await store.load('new', 'citizen1', 'D');
    const a = store.app()!;
    expect(a.delegation_level).toBe('DFO');
    expect(store.errorsFor('basic').map((i) => i.field)).toContain('noc_level');
    store.set(a, 'noc_level', 'MSB');
    expect(store.app()!.delegation_level).toBe('MSB');
    expect(store.errorsFor('basic').map((i) => i.field)).not.toContain('noc_level');
  });

  it('refuses to open a submitted application or another citizen’s draft', async () => {
    await store.load('102', 'citizen1');
    expect(store.loadError()).toContain('can no longer be edited');
    expect(store.app()).toBeNull();
    await store.load('112', 'citizen1');
    expect(store.loadError()).toContain('not found');
  });

  describe('Save (legacy SaveApplication)', () => {
    it('prepares a new application in the browser only — nothing is stored until the first save', async () => {
      const before = (await all()).length;
      await store.load('new', 'citizen1', 'P');
      expect(store.isNew()).toBe(true);
      expect(store.saveState()).toBe('new');
      expect(store.app()!.appl_id).toBe(0);
      expect((await all()).length).toBe(before);
    });

    it('needs only the site name and address; the first save creates the draft', async () => {
      await store.load('new', 'citizen1', 'O');
      const r1 = await store.save();
      expect(r1).toEqual({ ok: false, error: expect.stringContaining('Site Name and Site Address') });
      store.set(store.app()!, 'site_name', 'Sea Breeze');
      store.set(store.app()!, 'site_addr', 'Beach Road, Visakhapatnam');
      const r2 = await store.save();
      expect(r2.ok).toBe(true);
      expect(r2.createdId).toBeGreaterThan(114);
      expect(store.isNew()).toBe(false);
      expect(store.saveState()).toBe('saved');
      const saved = await persisted(r2.createdId!);
      expect(saved.status_id).toBe(1);
      expect(saved.appl_type).toBe('O');
      expect(saved.site_name).toBe('Sea Breeze');
    });

    it('saves an incomplete application any number of times', async () => {
      await store.load('104', 'citizen1');
      expect(store.errors().length).toBeGreaterThan(0);
      store.set(store.app()!, 'lic_auth', 'Commissioner, VMC');
      expect(store.saveState()).toBe('dirty');
      expect((await store.save()).ok).toBe(true);
      expect((await persisted(104)).lic_auth).toBe('Commissioner, VMC');
      store.set(store.app()!, 'lic_addr', 'MG Road');
      expect((await store.saveIfPossible()).ok).toBe(true);
      expect((await store.saveIfPossible()).ok).toBe(false); // nothing changed
    });
  });

  it('shows validation messages on the form at all times (no "attempted" gate)', async () => {
    await store.load('104', 'citizen1');
    expect(store.fieldError('lic_auth')).toContain('Licensing authority');
    expect(store.errorsFor('basic').length).toBe(3);
    expect(store.hasErrorUnder('blocks.0')).toBe(true); // agree_reqt on the FFE page
    expect(store.blockErrorsFor(0, 'ffe').map((i) => i.field)).toEqual(['blocks.0.ffe.agree_reqt']);
    expect(store.blockErrorsFor(0, 'details')).toEqual([]);
    expect(store.blockIndexOf(1)).toBe(0);
    expect(store.blockIndexOf(99)).toBe(-1);
  });

  it('recalculates the FFE grid when the building changes, keeping entered values', async () => {
    await store.load('104', 'citizen1');
    const block = store.app()!.blocks[0];
    const ext = block.ffe.items.find((i) => i.equip_id === 2)!;
    expect(ext.floors['1'].reqt).toBe(7); // ceil(700/100) — A_SH
    ext.floors['1'].prov = 9;
    store.set(block.floors[0], 'built_area', 1000);
    const ext2 = store.app()!.blocks[0].ffe.items.find((i) => i.equip_id === 2)!;
    expect(ext2.floors['1']).toEqual({ reqt: 10, prop: null, prov: 9 });
  });

  it('adds and removes applicant equipment (legacy Add Fire Fighting Equipment)', async () => {
    await store.load('104', 'citizen1');
    const block = store.app()!.blocks[0];
    store.addEquipment(block, 13);
    expect(block.ffe.items.some((i) => i.equip_id === 13 && i.added)).toBe(true);
    store.removeAddedEquipment(block, 13);
    expect(block.ffe.items.some((i) => i.equip_id === 13)).toBe(false);
  });

  it('adds blocks, floors and escape rows', async () => {
    await store.load('104', 'citizen1');
    const a = store.app()!;
    const idx = store.addBlock('T', 'Tower 1');
    expect(a.blocks[idx]).toEqual(expect.objectContaining({ block_name: 'Tower 1', block_type: 'T' }));
    store.addFloor(a.blocks[0]);
    expect(a.blocks[0].floors.at(-1)!.flr_name).toBe('5th Floor');
    store.addRow(a.blocks[0], 'refuges');
    expect(a.blocks[0].refuges).toHaveLength(1);
    store.removeBlock(idx);
    expect(a.blocks).toHaveLength(1);
  });

  it('rejects non-PDF uploads and attaches PDFs as metadata', async () => {
    await store.load('104', 'citizen1');
    const doc = store.requiredDocs().find((d) => d.code === 'SelfDeclaration')!;
    expect(await store.attachDocument(doc, new File(['x'], 'decl.docx'))).toContain('PDF');
    expect(await store.attachDocument(doc, new File(['x'.repeat(2048)], 'decl.pdf', { type: 'application/pdf' }))).toBeNull();
    expect(store.documentFor('SelfDeclaration')?.file_name).toBe('decl.pdf');
    expect((await persisted(104)).documents.some((d) => d.code === 'SelfDeclaration')).toBe(true);
  });

  it('requires challan details before recording a challan payment', async () => {
    await store.load('104', 'citizen1');
    expect(await store.recordChallan({ num: '', date: '', bank: '', branch: '' })).toContain('challan number');
    expect(await store.recordChallan({ num: 'CH1', date: '01-Nov-2026', bank: 'SBI', branch: 'Main' })).toBeNull();
    expect(store.app()!.payment).toEqual(expect.objectContaining({ mode: 'challan', status: 'paid', challan_num: 'CH1', amount: 35000 }));
    expect(store.requiredDocs().some((d) => d.code === 'ChallanCopy')).toBe(true);
  });

  it('cannot pay for an application that cannot be saved yet', async () => {
    await store.load('new', 'citizen1', 'P');
    expect((await store.payOnline()).ok).toBe(false);
  });

  it('Submit validates everything and lists the problems; the application is saved meanwhile', async () => {
    await store.load('104', 'citizen1');
    store.set(store.app()!, 'lic_auth', 'Commissioner, VMC');
    const r = await store.validateForSubmit();
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['lic_addr', 'perimeter', 'payment', 'declaration_accepted']));
    expect((await persisted(104)).lic_auth).toBe('Commissioner, VMC');
    expect((await store.submit()).ok).toBe(false);
  });

  it('completes and submits a Provisional NOC end to end', async () => {
    await store.load('104', 'citizen1');
    const a = store.app()!;
    a.lic_auth = 'Commissioner, VMC';
    a.lic_addr = 'VMC Office, Vijayawada';
    a.perimeter = 260;
    a.blocks[0].ffe.agree_reqt = true;
    store.touch();
    expect(store.errorsFor('basic')).toEqual([]);
    for (const page of ['details', 'floors', 'escapes', 'ffe'] as const) {
      expect(store.blockErrorsFor(0, page), page).toEqual([]);
    }
    for (const d of store.requiredDocs().filter((x) => !x.optional)) {
      expect(await store.attachDocument(d, new File(['x'.repeat(1000)], `${d.code}.pdf`, { type: 'application/pdf' }))).toBeNull();
    }
    expect(store.errorsFor('documents')).toEqual([]);
    expect(store.blockErrorsFor(0, 'plans')).toEqual([]);
    expect((await store.payOnline()).ok).toBe(true);
    store.set(store.app()!, 'declaration_accepted', true); // the payment adopted the server's copy
    expect((await store.validateForSubmit()).ok).toBe(true);
    const result = await store.submit();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.app.status_id).toBe(2);
      expect(result.app.appl_number).toMatch(/^\d{11}$/); // yyyymm + 5 digits (N-2)
    }
    // numbering, the workflow start and the assignment are the server's (backend/tests/integration)
    const api = TestBed.inject(FakeApi);
    expect(api.calls('POST', /^\/applications\/104\/payment$/)[0].body).toEqual({ mode: 'online' });
    expect(api.calls('POST', /^\/applications\/104\/submit$/)).toHaveLength(1);
    const saved = await persisted(104);
    expect(saved.status_id).toBe(2);
    expect(saved.payment.txn_ref).toMatch(/^PAYU/);
  });
});
