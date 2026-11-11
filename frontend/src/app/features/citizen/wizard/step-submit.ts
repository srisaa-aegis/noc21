import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { delegationLevelName } from '../../../core/domain/application-rules';
import { isoToLegacy } from '../../../core/domain/dates';
import { ValidationIssue } from '../../../core/domain/validation';
import { BLOCK_STEPS, WizardTarget } from '../../../core/domain/wizard-steps';
import { ConfirmDialogService } from '../../../shared/ui/confirm-dialog.service';
import { IconComponent } from '../../../shared/ui/icon';
import { Modal } from '../../../shared/ui/modal';
import { ToastService } from '../../../shared/ui/toast.service';
import { ApplicationDraftStore } from './application-draft.store';

interface IssueGroup {
  key: string;
  label: string;
  target: WizardTarget;
  issues: ValidationIssue[];
}

/**
 * Fee & Submit — legacy editpnoc.html bottom section (fee, challan / online payment, "I have verified…",
 * Submit → ConfirmDoc). Submit validates the whole application: problems are listed with links to the
 * page to fix, otherwise the single-page confirmation is shown (legacy confirmpnoc / confirmonoc / confirmrnoc).
 */
@Component({
  selector: 'app-step-submit',
  imports: [FormsModule, RouterLink, IconComponent, DecimalPipe, Modal],
  templateUrl: './step-submit.html',
  styleUrl: './step-submit.scss',
})
export class StepSubmit {
  protected readonly store = inject(ApplicationDraftStore);
  private readonly dialog = inject(ConfirmDialogService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  /** Ask the wizard to move to another page. */
  readonly goTo = output<WizardTarget>();

  protected readonly payMode = signal<'online' | 'challan'>('online');
  protected challan = { num: '', dateIso: '', bank: '', branch: '' };
  protected readonly challanError = signal<string | null>(null);
  protected readonly paying = signal(false);
  protected readonly validating = signal(false);
  /** Problems found by the last Submit click (shown in a dialog). */
  protected readonly submitProblems = signal<IssueGroup[] | null>(null);

  protected readonly levelName = computed(() => delegationLevelName(this.store.app()?.delegation_level ?? 'DFO'));

  protected readonly warnings = computed(() => this.store.issues().filter((i) => i.severity === 'warning'));

  /** Problems grouped by page; block problems by block and page of the block's flow. */
  protected group(issues: ValidationIssue[]): IssueGroup[] {
    const groups: IssueGroup[] = [];
    const blocks = this.store.app()?.blocks ?? [];
    for (const s of this.store.steps()) {
      if (s.id === 'blocks') {
        const general = issues.filter((i) => i.step === 'blocks' && i.block === undefined);
        if (general.length) groups.push({ key: 'blocks', label: 'Blocks', target: { step: 'blocks' }, issues: general });
        blocks.forEach((b, bi) => {
          for (const p of BLOCK_STEPS) {
            const list = issues.filter((i) => i.step === 'blocks' && i.block === bi && i.blockStep === p.id);
            if (list.length) {
              groups.push({ key: `b${b.block_id}-${p.id}`, label: `${b.block_name || 'Block ' + (bi + 1)} — ${p.label}`, target: { step: 'blocks', blockId: b.block_id, blockStep: p.id }, issues: list });
            }
          }
        });
        continue;
      }
      const list = issues.filter((i) => i.step === s.id);
      if (list.length) groups.push({ key: s.id, label: s.label, target: { step: s.id }, issues: list });
    }
    return groups;
  }

  protected async payOnline(): Promise<void> {
    const fee = this.store.fee();
    const ok = await this.dialog.open({
      title: 'Simulated payment gateway',
      message: `You would now be redirected to the PayU payment gateway to pay Rs. ${fee?.total}. In this demo the payment succeeds immediately. Do not close the browser during a real payment.`,
      confirmText: `Pay Rs. ${fee?.total}`,
      cancelText: 'Cancel',
    });
    if (!ok) return;
    this.paying.set(true);
    const r = await this.store.payOnline();
    this.paying.set(false);
    if (r.ok) this.toast.success('Payment successful.');
    else this.toast.error(r.error ?? 'Payment could not be recorded.');
  }

  protected async recordChallan(): Promise<void> {
    const error = await this.store.recordChallan({
      num: this.challan.num,
      date: isoToLegacy(this.challan.dateIso),
      bank: this.challan.bank,
      branch: this.challan.branch,
    });
    this.challanError.set(error);
    if (!error) this.toast.success('Challan details recorded. Remember to upload the scanned challan under Documents & Plans.');
  }

  protected setDeclaration(value: boolean): void {
    this.store.set(this.store.app()!, 'declaration_accepted', value);
  }

  /** Legacy ConfirmDoc: save, validate everything, then show the confirmation page or the list of problems. */
  protected async submit(): Promise<void> {
    this.validating.set(true);
    const r = await this.store.validateForSubmit();
    this.validating.set(false);
    if (r.error) {
      this.toast.error(r.error);
      return;
    }
    if (!r.ok) {
      this.submitProblems.set(this.group(r.errors));
      return;
    }
    this.router.navigate(['/citizen/applications', this.store.app()!.appl_id, 'confirm']);
  }

  protected fix(target: WizardTarget): void {
    this.submitProblems.set(null);
    this.goTo.emit(target);
  }
}
