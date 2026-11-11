import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, take } from 'rxjs';
import { CitizenApi } from '../../../core/api/citizen-api.service';
import { ApiError } from '../../../core/api/http-backend.service';
import type { Assessment } from '@srisaa/noc-domain';
import { AuthService } from '../../../core/auth/auth.service';
import { newBlock, newDraft } from '../../../core/domain/application-factory';
import { FeeBreakdown, computeDelegationLevel, computeFee, nextId, saveProblem } from '../../../core/domain/application-rules';
import { RequiredDocument, requiredDocuments, validateUpload } from '../../../core/domain/documents';
import { computeBlockFfe } from '../../../core/domain/ffe';
import { ValidationIssue, validateApplication } from '../../../core/domain/validation';
import { declarationLevel } from '@srisaa/noc-domain';
import { BlockStepId, WizardStep, WizardStepId, stepsFor } from '../../../core/domain/wizard-steps';
import { LookupService, WizardLookups } from '../../../core/lookups/lookup.service';
import { Application, ApplicationTypeCode, Block } from '../../../core/models';
import { ApplicationsService } from '../applications.service';

export type SaveState = 'new' | 'saved' | 'dirty' | 'saving' | 'error';

export interface SaveResult {
  ok: boolean;
  error?: string;
  /** The server refused the save because the application changed elsewhere (reload needed). */
  conflict?: boolean;
  /** Set when the application was created by this save (it had no id yet). */
  createdId?: number;
}

/**
 * Working copy + behaviour of the application being edited.
 *
 * Legacy model (applicationController.SaveApplication / ConfirmDoc):
 *  - **Save** may happen any number of times and only needs the Site Name and Site Address.
 *    A brand-new application exists only in the browser until its first save.
 *  - Validation messages are shown on the form at all times (legacy red fields) but never block
 *    moving between the pages of the application.
 *  - **Submit** validates everything; errors are listed, otherwise a single-page confirmation is
 *    shown and the application is submitted on confirmation.
 *
 * Derived values (FFE grid from the rule trees, approval level, fee, district name) are
 * recalculated on every change, exactly like the legacy pages recalculated on load/save.
 */
@Injectable()
export class ApplicationDraftStore {
  private readonly applications = inject(ApplicationsService);
  private readonly lookupService = inject(LookupService);
  private readonly auth = inject(AuthService);
  private readonly server = inject(CitizenApi);

  readonly app = signal<Application | null>(null);
  /** The server's calculation returned by the last save (authoritative). */
  readonly serverAssessment = signal<Assessment | null>(null);
  /** Upload progress per requirement code (0–100), while an upload is running. */
  readonly uploadProgress = signal<Record<string, number>>({});
  readonly lookups = signal<WizardLookups | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly saveState = signal<SaveState>('saved');
  readonly lastSavedAt = signal<Date | null>(null);

  private readonly version = signal(0);
  /** Increments on every change to the working copy — depend on it in computeds that read mutable fields. */
  readonly changeCount = this.version.asReadonly();

  readonly isNew = computed(() => {
    this.version();
    return (this.app()?.appl_id ?? 0) === 0;
  });
  readonly dirty = computed(() => this.saveState() === 'dirty' || this.saveState() === 'new');

  readonly steps = computed<WizardStep[]>(() => {
    this.version();
    const a = this.app();
    return a ? stepsFor(a.appl_type) : [];
  });

  readonly issues = computed<ValidationIssue[]>(() => {
    this.version();
    const a = this.app();
    const l = this.lookups();
    return a && l ? validateApplication(a, l) : [];
  });

  readonly errors = computed(() => this.issues().filter((i) => i.severity === 'error'));

  readonly fee = computed<FeeBreakdown | null>(() => {
    this.version();
    const a = this.app();
    const l = this.lookups();
    return a && l ? computeFee(a, l.feeConfig) : null;
  });

  readonly requiredDocs = computed<RequiredDocument[]>(() => {
    this.version();
    const a = this.app();
    const l = this.lookups();
    return a && l ? requiredDocuments(a, l.documentRequirements) : [];
  });

  // -------------------------------------------------------------------------
  // Loading / saving
  // -------------------------------------------------------------------------

  /** Loads a saved application, or prepares a new unsaved one when `id` is "new". */
  async load(id: string, owner: string, newType?: ApplicationTypeCode): Promise<void> {
    this.loadError.set(null);
    try {
      const lookups = await firstValueFrom(this.lookupService.wizard().pipe(take(1)));
      this.lookups.set(lookups);
      if (id === 'new') {
        const account = await firstValueFrom(this.auth.currentAccount());
        if (!account || !newType) throw new Error('Application not found.');
        this.app.set(newDraft(0, newType, account, lookups.partyRoles, new Date(), lookups.occupancyConditions));
        this.saveState.set('new');
      } else {
        const app = await firstValueFrom(this.applications.get(Number(id), owner));
        if (app.status_id !== 1) {
          this.loadError.set('This application has been submitted and can no longer be edited.');
          return;
        }
        this.app.set(app);
        this.saveState.set('saved');
      }
      this.syncDerived();
      this.version.update((v) => v + 1);
    } catch (e) {
      this.loadError.set((e as Error).message || 'Application not found.');
    }
  }

  /** Call after any change to the working copy. */
  touch(): void {
    this.syncDerived();
    this.version.update((v) => v + 1);
    if (this.saveState() !== 'new') this.saveState.set('dirty');
  }

  /** Template helper: `(ngModelChange)="store.set(app, 'site_name', $event)"`. */
  set<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
    target[key] = value;
    this.touch();
  }

  /**
   * Legacy Save: needs only the site name and address. Creates the application on
   * its first save. The server recomputes every derived value and returns the
   * stored application: it is adopted (the server is the source of truth), and its
   * assessment is kept to compare with the live calculation.
   */
  async save(): Promise<SaveResult> {
    const a = this.app();
    if (!a) return { ok: false, error: 'Application not loaded.' };
    const problem = saveProblem(a);
    if (problem) return { ok: false, error: problem };
    const wasNew = a.appl_id === 0;
    this.saveState.set('saving');
    try {
      const snapshot = JSON.parse(JSON.stringify(a)) as Application;
      const r = await firstValueFrom(wasNew ? this.server.create(snapshot) : this.server.save(snapshot));
      this.adopt(r.application);
      this.serverAssessment.set(r.assessment);
      this.reportDrift(r.assessment);
      this.lastSavedAt.set(new Date());
      this.saveState.set('saved');
      return { ok: true, createdId: wasNew ? r.application.appl_id : undefined };
    } catch (e) {
      this.saveState.set('error');
      return { ok: false, error: (e as Error).message, conflict: e instanceof ApiError && e.status === 409 };
    }
  }

  /** Replaces the working copy with the server's version of the application. */
  private adopt(app: Application): void {
    this.app.set(app);
    this.syncDerived();
    this.version.update((v) => v + 1);
  }

  /** Reloads the application from the server (after a conflict, for example). */
  async reload(): Promise<void> {
    const a = this.app();
    if (!a?.appl_id) return;
    this.adopt(await firstValueFrom(this.server.get(a.appl_id)));
    this.saveState.set('saved');
  }

  /**
   * The browser computes the same values live for instant feedback; the server
   * is authoritative. A difference means the cached rules are stale or there is
   * a defect — it is reported, and the server's value is the one kept.
   */
  private reportDrift(server: Assessment): void {
    const local = this.fee();
    if (local && Math.round(local.total) !== Math.round(server.fee.total)) {
      console.warn(`[noc] fee computed in the browser (${local.total}) differs from the server (${server.fee.total}); the server value is used.`);
    }
  }

  /** Saves first when the application is new or has unsaved changes (needed before uploads and payment). */
  private async ensureSaved(): Promise<string | null> {
    const a = this.app();
    if (!a) return 'Application not loaded.';
    if (a.appl_id && !this.dirty()) return null;
    const r = await this.save();
    return r.ok ? null : (r.error ?? 'Could not save the application.');
  }

  /** Saves only when there are unsaved changes and the minimum (site name + address) is present. */
  async saveIfPossible(): Promise<SaveResult> {
    const a = this.app();
    if (!a || !this.dirty() || saveProblem(a)) return { ok: false };
    return this.save();
  }

  // -------------------------------------------------------------------------
  // Derived values kept in sync with the working copy
  // -------------------------------------------------------------------------

  private syncDerived(): void {
    const a = this.app();
    const l = this.lookups();
    if (!a || !l) return;
    a.dist_name = l.districts.find((d) => d.id === Number(a.district))?.desc ?? '';
    a.delegation_level = a.appl_type === 'D' ? declarationLevel(a) : computeDelegationLevel(a, l.delegationRules);
    for (const block of a.blocks) {
      block.ffe = computeBlockFfe(block, a.plot_area, a.perimeter, l.ffeRules, l.equipments, block.ffe);
    }
    if (a.payment.status !== 'paid') {
      a.payment.amount = computeFee(a, l.feeConfig).total;
    }
  }

  // -------------------------------------------------------------------------
  // Validation display (always visible, never blocking navigation)
  // -------------------------------------------------------------------------

  errorsFor(step: WizardStepId): ValidationIssue[] {
    return this.issues().filter((i) => i.step === step && i.severity === 'error');
  }

  warningsFor(step: WizardStepId): ValidationIssue[] {
    return this.issues().filter((i) => i.step === step && i.severity === 'warning');
  }

  /** Errors of one block (by index), optionally of one page of its flow. */
  blockErrorsFor(index: number, page?: BlockStepId): ValidationIssue[] {
    return this.issues().filter((i) => i.severity === 'error' && i.block === index && (!page || i.blockStep === page));
  }

  blockWarningsFor(index: number, page?: BlockStepId): ValidationIssue[] {
    return this.issues().filter((i) => i.severity === 'warning' && i.block === index && (!page || i.blockStep === page));
  }

  /** Position of a block in the application by its id (-1 when not found). */
  blockIndexOf(blockId: number): number {
    this.version();
    return this.app()?.blocks.findIndex((b) => b.block_id === Number(blockId)) ?? -1;
  }

  fieldError(field: string): string | null {
    return this.issues().find((i) => i.field === field && i.severity === 'error')?.message ?? null;
  }

  fieldWarning(field: string): string | null {
    return this.issues().find((i) => i.field === field && i.severity === 'warning')?.message ?? null;
  }

  /** Any error whose field starts with the given prefix (e.g. a block tab or table). */
  hasErrorUnder(prefix: string): boolean {
    return this.issues().some((i) => i.severity === 'error' && (i.field === prefix || i.field.startsWith(prefix + '.')));
  }

  // -------------------------------------------------------------------------
  // Blocks and their rows
  // -------------------------------------------------------------------------

  addBlock(blockType = 'N', name?: string): number {
    const a = this.app()!;
    const block = newBlock(nextId(a.blocks, (b) => b.block_id), blockType);
    if (name) block.block_name = name;
    a.blocks.push(block);
    this.touch();
    return a.blocks.length - 1;
  }

  removeBlock(index: number): void {
    const a = this.app()!;
    const [removed] = a.blocks.splice(index, 1);
    if (removed) {
      a.documents = a.documents.filter((d) => d.code.split(':')[1] !== String(removed.block_id));
    }
    this.touch();
  }

  addFloor(block: Block): void {
    const n = block.floors.filter((f) => f.flr_type === 'F').length + 1;
    const last = block.floors[block.floors.length - 1];
    const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
    block.floors.push({
      floor_id: nextId(block.floors, (f) => f.floor_id),
      flr_type: 'F',
      flr_name: `${n}${suffix} Floor`,
      built_area: last?.built_area ?? 0,
      occ_type: last?.occ_type ?? '',
      occ_c_app: last?.occ_c_app ?? 0,
      seats_num: 0,
    });
    this.touch();
  }

  removeFloor(block: Block, index: number): void {
    const [removed] = block.floors.splice(index, 1);
    const a = this.app()!;
    if (removed) {
      a.documents = a.documents.filter((d) => d.code !== `FloorPlan:${block.block_id}:${removed.floor_id}`);
    }
    this.touch();
  }

  /** Generic add for the block's row tables (escapes, exits, doors, lifts, refuges, car parks). */
  addRow<K extends 'escapes' | 'exits' | 'doors' | 'lifts' | 'refuges' | 'carparks'>(block: Block, list: K): void {
    const rows = block[list] as unknown as Record<string, unknown>[];
    const idKey = { escapes: 'escape_id', exits: 'exit_id', doors: 'door_id', lifts: 'lift_id', refuges: 'refuge_id', carparks: 'cpark_id' }[list];
    const id = rows.reduce((m, r) => Math.max(m, Number(r[idKey]) || 0), 0) + 1;
    const templates: Record<string, Record<string, unknown>> = {
      escapes: { etype: 'E', desc: 'External Staircase', width: 0, location: 'W' },
      exits: { ename: 'Entrance / Exit', width: 0, awidth: 0, direc: block.front_dir || 'E' },
      doors: { desc: '', width: 0, location: block.front_dir || 'E' },
      lifts: { ltype: 'F', lname: `Fire Lift ${id}`, capacity: 0 },
      refuges: { floor_id: block.floors[block.floors.length - 1]?.floor_id ?? 0, area: 0 },
      carparks: { floor: block.floors[0]?.flr_name ?? '', capacity: 0 },
    };
    rows.push({ [idKey]: id, ...templates[list] });
    this.touch();
  }

  removeRow(block: Block, list: 'escapes' | 'exits' | 'doors' | 'lifts' | 'refuges' | 'carparks', index: number): void {
    (block[list] as unknown[]).splice(index, 1);
    this.touch();
  }

  /** Legacy "Add Fire Fighting Equipment" (Occupancy): an item not required by the rules. */
  addEquipment(block: Block, equipId: number): void {
    const eq = this.lookups()?.equipments.find((e) => e.id === equipId);
    if (!eq || block.ffe.items.some((i) => i.equip_id === equipId)) return;
    const level: 'F' | 'B' = eq.level === 'F' ? 'F' : 'B';
    block.ffe.items.push({
      equip_id: equipId,
      level,
      floors: level === 'F' ? Object.fromEntries(block.floors.map((f) => [String(f.floor_id), { reqt: null, prop: null, prov: null }])) : {},
      block: { reqt: null, prop: null, prov: null },
      note_keys: [],
      added: true,
      remarks: '',
    });
    this.touch();
  }

  removeAddedEquipment(block: Block, equipId: number): void {
    block.ffe.items = block.ffe.items.filter((i) => !(i.added && i.equip_id === equipId && this.isNotRequired(i)));
    this.touch();
  }

  private isNotRequired(item: Block['ffe']['items'][number]): boolean {
    return item.block.reqt === null && Object.values(item.floors).every((c) => c.reqt === null);
  }

  // -------------------------------------------------------------------------
  // Documents (stored on the server, outside the web root)
  // -------------------------------------------------------------------------

  async attachDocument(doc: RequiredDocument, file: { name: string; size: number; type?: string }): Promise<string | null> {
    const problem = validateUpload(file);
    if (problem) return problem;
    const saveProblemText = await this.ensureSaved();
    if (saveProblemText) return saveProblemText;
    try {
      this.uploadProgress.update((p) => ({ ...p, [doc.code]: 0 }));
      const after = await firstValueFrom(
        this.server.uploadDocument(this.app()!.appl_id, doc.code, file as File, (pct) => this.uploadProgress.update((p) => ({ ...p, [doc.code]: pct }))),
      );
      this.adoptDocuments(after);
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      this.uploadProgress.update((p) => {
        const next = { ...p };
        delete next[doc.code];
        return next;
      });
    }
  }

  async removeDocument(code: string): Promise<void> {
    const a = this.app()!;
    const doc = a.documents.find((d) => d.code === code);
    if (!doc) return;
    this.adoptDocuments(await firstValueFrom(this.server.removeDocument(a.appl_id, doc.doc_id)));
  }

  /** Takes the server's document list and version without touching the applicant's unsaved edits. */
  private adoptDocuments(server: Application): void {
    const a = this.app()!;
    a.documents = server.documents;
    a.row_version = server.row_version;
    a.last_modified = server.last_modified;
    this.version.update((v) => v + 1);
  }

  documentFor(code: string) {
    return this.app()?.documents.find((d) => d.code === code) ?? null;
  }

  // -------------------------------------------------------------------------
  // Payment (simulated PayU gateway / manual bank challan) — requires a saved application
  // -------------------------------------------------------------------------

  async payOnline(): Promise<SaveResult> {
    const a = this.app()!;
    const problem = saveProblem(a);
    if (problem) return { ok: false, error: problem };
    const notSaved = await this.ensureSaved();
    if (notSaved) return { ok: false, error: notSaved };
    try {
      const r = await firstValueFrom(this.server.pay(this.app()!.appl_id, { mode: 'online' }));
      this.adopt(r.application);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async recordChallan(challan: { num: string; date: string; bank: string; branch: string }): Promise<string | null> {
    if (![challan.num, challan.date, challan.bank, challan.branch].every((v) => v && v.trim())) {
      return 'Enter the challan number, date, bank and branch.';
    }
    const notSaved = await this.ensureSaved();
    if (notSaved) return notSaved;
    try {
      const r = await firstValueFrom(
        this.server.pay(this.app()!.appl_id, {
          mode: 'challan',
          challan_num: challan.num.trim(),
          challan_date: challan.date,
          bank: challan.bank.trim(),
          branch: challan.branch.trim(),
        }),
      );
      this.adopt(r.application);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  // -------------------------------------------------------------------------
  // Submit (legacy ConfirmDoc → confirm page → submitapplication.aspx)
  // -------------------------------------------------------------------------

  /**
   * Step 1 of submission: save, then list what still blocks the submission —
   * the server's assessment (it also judges the fee paid against the frozen fee).
   */
  async validateForSubmit(): Promise<{ ok: boolean; errors: ValidationIssue[]; error?: string }> {
    const saved = await this.save();
    if (!saved.ok) return { ok: false, errors: [], error: saved.error };
    const server = this.serverAssessment();
    const errors = server ? server.issues.filter((i) => i.severity === 'error') : this.errors();
    return { ok: errors.length === 0, errors };
  }

  /** Step 2 of submission (from the confirmation page): the server numbers the application and starts the workflow. */
  async submit(undertakings: string[] = []): Promise<{ ok: true; app: Application } | { ok: false; error: string }> {
    const a = this.app();
    if (!a) return { ok: false, error: 'Application not loaded.' };
    try {
      const notSaved = await this.ensureSaved();
      if (notSaved) return { ok: false, error: notSaved };
      const submitted = await firstValueFrom(this.applications.submit(this.app()!, undertakings));
      this.app.set(submitted);
      this.saveState.set('saved');
      return { ok: true, app: submitted };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
