import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { LeaveAware } from '../../../core/auth/unsaved-changes.guard';
import { BLOCK_STEPS, BlockStepId, WizardStepId, WizardTarget, isBlockStep } from '../../../core/domain/wizard-steps';
import { ApplicationTypeCode } from '../../../core/models';
import { ApplTypeBadge } from '../../../shared/ui/appl-type-badge';
import { ConfirmDialogService } from '../../../shared/ui/confirm-dialog.service';
import { IconComponent } from '../../../shared/ui/icon';
import { ToastService } from '../../../shared/ui/toast.service';
import { ApplicationDraftStore } from './application-draft.store';
import { StepBasic } from './step-basic';
import { StepBlockDetails } from './step-block-details';
import { StepBlockPlans } from './step-block-plans';
import { StepBlocksList } from './step-blocks-list';
import { StepDocuments } from './step-documents';
import { StepEscapes } from './step-escapes';
import { StepFfe } from './step-ffe';
import { StepFloors } from './step-floors';
import { StepSubmit } from './step-submit';

const TYPE_NAMES: Record<string, string> = {
  P: 'Provisional NOC',
  O: 'Occupancy NOC',
  R: 'Renewal of Occupancy NOC',
  RO: 'Renewal of Occupancy NOC',
  D: 'Declaration for Renewal',
};

/**
 * Application form. Like the legacy app, application-level pages (editpnoc.html) and a separate
 * flow per block (editpnoc_1 → _2 → _3 → _4):
 *   /citizen/applications/:id/edit/:step                               basic | blocks | documents | submit
 *   /citizen/applications/:id/edit/blocks/:blockId/:blockStep          details | floors | escapes | ffe | plans
 * (`:id` = "new" + `?type=` until the first save.)
 */
@Component({
  selector: 'app-wizard',
  imports: [
    RouterLink,
    ApplTypeBadge,
    IconComponent,
    StepBasic,
    StepBlocksList,
    StepBlockDetails,
    StepFloors,
    StepEscapes,
    StepFfe,
    StepBlockPlans,
    StepDocuments,
    StepSubmit,
  ],
  providers: [ApplicationDraftStore],
  templateUrl: './wizard.html',
  styleUrl: './wizard.scss',
})
export class Wizard implements LeaveAware {
  protected readonly store = inject(ApplicationDraftStore);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly dialog = inject(ConfirmDialogService);

  /** Route params / query params (bound via withComponentInputBinding). */
  readonly id = input.required<string>();
  readonly step = input<string>('basic');
  readonly type = input<string | undefined>(undefined);
  readonly blockId = input<string | undefined>(undefined);
  readonly blockStep = input<string | undefined>(undefined);

  protected readonly blockSteps = BLOCK_STEPS;

  protected readonly currentStep = computed(() => (this.step() || 'basic') as WizardStepId);
  protected readonly stepIndex = computed(() => this.store.steps().findIndex((s) => s.id === this.currentStep()));
  protected readonly title = computed(() => TYPE_NAMES[this.store.app()?.appl_type ?? ''] ?? '');

  /** Index of the block whose flow is open (-1 when on an application-level page). */
  protected readonly blockIndex = computed(() => {
    const id = this.blockId();
    if (this.currentStep() !== 'blocks' || !id || !isBlockStep(this.blockStep())) return -1;
    return this.store.blockIndexOf(Number(id));
  });
  protected readonly inBlock = computed(() => this.blockIndex() >= 0);
  protected readonly currentBlock = computed(() => {
    this.store.changeCount();
    return this.inBlock() ? (this.store.app()?.blocks[this.blockIndex()] ?? null) : null;
  });
  protected readonly currentBlockStep = computed(() => this.blockStep() as BlockStepId);
  protected readonly blockStepIndex = computed(() => BLOCK_STEPS.findIndex((s) => s.id === this.currentBlockStep()));

  /** Open items on the current page (application page, or the current page of the block flow). */
  protected readonly pageErrors = computed(() =>
    this.inBlock() ? this.store.blockErrorsFor(this.blockIndex(), this.currentBlockStep()).length : this.store.errorsFor(this.currentStep()).length,
  );

  protected readonly isLastPage = computed(() => !this.inBlock() && this.stepIndex() === this.store.steps().length - 1);

  /** Remarks that caused the latest return/rejection — shown as a banner while revising. */
  protected readonly revisionRemarks = computed(() => {
    this.store.changeCount();
    const a = this.store.app();
    if (!a || a.revision <= 1) return null;
    const last = [...a.processLog].reverse().find((s) => s.status_id === 8 || s.status_id === 9);
    return last ? `${last.role} (${last.at_date}): ${last.remarks}` : null;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      const type = this.type() as ApplicationTypeCode | undefined;
      untracked(() => {
        const current = this.store.app();
        // Same application already loaded (e.g. the URL changed from /new to /<id> after the first save).
        if (current && (String(current.appl_id) === id || (id === 'new' && current.appl_id === 0))) return;
        void this.store.load(id, this.auth.session()?.username ?? '', type);
      });
    });

    // Unknown page / block → fall back to a valid page.
    effect(() => {
      const app = this.store.app();
      const step = this.currentStep();
      const blockId = this.blockId();
      const blockStep = this.blockStep();
      if (!app) return;
      untracked(() => {
        const ids = this.store.steps().map((s) => s.id);
        if (!ids.includes(step)) {
          this.navigate({ step: ids[0] }, true);
        } else if (step === 'blocks' && blockId !== undefined && (!isBlockStep(blockStep) || this.store.blockIndexOf(Number(blockId)) < 0)) {
          this.navigate({ step: 'blocks' }, true);
        }
      });
    });
  }

  private appId(): string {
    const a = this.store.app();
    return a && a.appl_id > 0 ? String(a.appl_id) : 'new';
  }

  private navigate(target: WizardTarget, replaceUrl = false): void {
    const a = this.store.app();
    const path =
      target.step === 'blocks' && target.blockId !== undefined && target.blockStep
        ? ['/citizen/applications', this.appId(), 'edit', 'blocks', String(target.blockId), target.blockStep]
        : ['/citizen/applications', this.appId(), 'edit', target.step];
    const extras = this.appId() === 'new' ? { queryParams: { type: a?.appl_type }, replaceUrl } : { replaceUrl };
    this.router.navigate(path, extras);
  }

  /** Moves to another page (application page or a page of a block's flow); saves first when possible. Never blocked. */
  protected async go(target: WizardTarget, saveFirst = true): Promise<void> {
    if (saveFirst && this.store.dirty()) {
      const r = await this.store.saveIfPossible();
      if (r.ok && r.createdId) this.toast.success(`Application saved (Draft #${r.createdId}).`);
      if (r.conflict) await this.resolveConflict();
    }
    this.navigate(target);
    window.scrollTo?.({ top: 0 });
  }

  protected goStep(step: WizardStepId): void {
    void this.go({ step });
  }

  protected goBlockStep(page: BlockStepId): void {
    const b = this.currentBlock();
    if (b) void this.go({ step: 'blocks', blockId: b.block_id, blockStep: page });
  }

  protected back(): void {
    if (this.inBlock()) {
      const i = this.blockStepIndex();
      if (i > 0) this.goBlockStep(BLOCK_STEPS[i - 1].id);
      else void this.go({ step: 'blocks' });
      return;
    }
    const steps = this.store.steps();
    const idx = this.stepIndex();
    if (idx > 0) void this.go({ step: steps[idx - 1].id });
  }

  protected next(): void {
    if (this.inBlock()) {
      const i = this.blockStepIndex();
      if (i < BLOCK_STEPS.length - 1) this.goBlockStep(BLOCK_STEPS[i + 1].id);
      else void this.go({ step: 'blocks' });
      return;
    }
    const steps = this.store.steps();
    const idx = this.stepIndex();
    if (idx < steps.length - 1) void this.go({ step: steps[idx + 1].id });
  }

  protected nextLabel(): string {
    if (!this.inBlock()) return 'Next';
    return this.blockStepIndex() === BLOCK_STEPS.length - 1 ? 'Finish block' : 'Next';
  }

  /** Legacy "Save": only Site Name and Site Address are needed. */
  protected async save(): Promise<void> {
    const r = await this.store.save();
    if (!r.ok) {
      if (r.conflict) await this.resolveConflict();
      else this.toast.error(r.error ?? 'Could not save the application.');
      return;
    }
    if (r.createdId) {
      this.toast.success(`Application saved as Draft #${r.createdId}. You can continue now or any time later from My Applications.`);
      const b = this.currentBlock();
      this.navigate(b ? { step: 'blocks', blockId: b.block_id, blockStep: this.currentBlockStep() } : { step: this.currentStep() }, true);
    } else {
      this.toast.success('Application saved.');
    }
  }

  /**
   * 409 from the server: the application was changed elsewhere (another tab or
   * device) since it was opened here. Offer to load the stored version; the
   * changes made on this page are lost in that case.
   */
  private async resolveConflict(): Promise<void> {
    const reload = await this.dialog.open({
      title: 'This application was changed elsewhere',
      message:
        'It has been saved from another window or device since you opened it here, so your changes were not saved. ' +
        'Load the latest saved version? (Changes made on this page since the last save will be lost.)',
      confirmText: 'Load latest version',
      cancelText: 'Keep editing',
    });
    if (!reload) return;
    try {
      await this.store.reload();
      this.toast.success('The latest saved version has been loaded.');
    } catch (e) {
      this.toast.error((e as Error).message);
    }
  }

  protected close(): void {
    this.router.navigate(['/citizen/dashboard']);
  }

  /** Used by the unsaved-changes guard. */
  async canLeave(nextUrl: string): Promise<boolean> {
    if (!this.store.dirty()) return true;
    const a = this.store.app();
    const sameForm = a && (nextUrl.includes(`/applications/${a.appl_id}/edit/`) || (a.appl_id === 0 && nextUrl.includes('/applications/new/edit/')));
    if (sameForm) return true;
    return this.dialog.open({
      title: 'Leave without saving?',
      message: 'You have unsaved changes on this application. Leave the page and discard them?',
      confirmText: 'Discard changes',
      cancelText: 'Stay',
    });
  }
}
