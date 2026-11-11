import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, debounceTime, distinctUntilChanged, of, switchMap } from 'rxjs';
import { outcomeLabel, type DecisionInput } from '@srisaa/noc-domain';
import { isoToLegacy, legacyToIso } from '../../../core/domain/dates';
import { validateUpload } from '../../../core/domain/documents';
import { WizardLookups } from '../../../core/lookups/lookup.service';
import { Application, WorkflowOutcome } from '../../../core/models';
import { DeclarationLetter } from '../../../shared/certificates/declaration-letter';
import { NocOccupancy } from '../../../shared/certificates/noc-occupancy';
import { NocProvisional } from '../../../shared/certificates/noc-provisional';
import { NocRenewal } from '../../../shared/certificates/noc-renewal';
import { RejectionLetter } from '../../../shared/certificates/rejection-letter';
import { IconComponent } from '../../../shared/ui/icon';
import { ToastService } from '../../../shared/ui/toast.service';
import { DeptWorkflowService } from '../dept-workflow.service';

/**
 * Final decision of the issuing authority — legacy dgfs_note / dgfs_note_o / dfs_note_r — with a live
 * preview of the NOC / letter while the form is filled in. The preview (validity from the renewal
 * period, the decision's log entry) is computed by the server; the signed scanned copy is uploaded to
 * the server as soon as it is chosen and is mandatory for the decision.
 */
@Component({
  selector: 'app-final-decision-form',
  imports: [FormsModule, IconComponent, NocProvisional, NocOccupancy, NocRenewal, DeclarationLetter, RejectionLetter],
  templateUrl: './final-decision-form.html',
  styleUrl: './final-decision-form.scss',
})
export class FinalDecisionForm {
  private readonly toast = inject(ToastService);
  private readonly dept = inject(DeptWorkflowService);

  readonly app = input.required<Application>();
  readonly taskId = input.required<number>();
  readonly lookups = input.required<WizardLookups>();
  readonly parent = input<Application | null>(null);
  readonly allowed = input.required<WorkflowOutcome[]>();
  readonly submitting = input(false);
  readonly decided = output<{ outcome: WorkflowOutcome; input: DecisionInput }>();

  protected readonly outcomeLabel = outcomeLabel;
  protected readonly outcome = signal<WorkflowOutcome | null>(null);
  protected readonly remark = signal('');
  protected readonly addcc = signal('');
  protected readonly remComm = signal('');
  protected readonly validFrom = signal('');
  protected readonly validTo = signal('');
  protected readonly signedDoc = signal<{ file_name: string; size?: number; file_id?: string } | null>(null);
  protected readonly uploading = signal(false);

  protected readonly needsValidity = computed(() => this.outcome() === 'approve' && this.app().appl_type !== 'P');

  private readonly input = computed<DecisionInput>(() => ({
    remark: this.remark(),
    addcc: this.addcc(),
    rem_comm: this.remComm(),
    valid_from: this.validFrom() || undefined,
    valid_to: this.validTo() || undefined,
  }));

  /** The server's preview of the application after the decision (debounced while typing). */
  protected readonly previewApp = signal<Application | null>(null);

  protected readonly problems = computed(() => {
    const o = this.outcome();
    if (!o) return ['Select a decision.'];
    if (o === 'inspect') return [];
    const out: string[] = [];
    if (!this.remark().trim()) out.push('Enter the remarks of the decision (they are printed on the NOC / letter).');
    if (!this.signedDoc()) out.push('Upload the signed copy of the NOC / letter.');
    return out;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    toObservable(computed(() => ({ outcome: this.outcome(), input: this.input() })))
      .pipe(
        debounceTime(300),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        switchMap(({ outcome, input }) =>
          outcome && outcome !== 'inspect'
            ? this.dept.decisionPreview(this.app().appl_id, this.taskId(), outcome, input).pipe(catchError(() => of(null)))
            : of(null),
        ),
        takeUntilDestroyed(destroyRef),
      )
      .subscribe((p) => this.previewApp.set(p));
    // Default validity of an approval: the renewal period the server computed.
    effect(() => {
      const p = this.previewApp();
      if (!p || !this.needsValidity()) return;
      untracked(() => {
        if (!this.validFrom() && p.valid_from) this.validFrom.set(p.valid_from);
        if (!this.validTo() && p.valid_to) this.validTo.set(p.valid_to);
      });
    });
  }

  protected selectOutcome(o: WorkflowOutcome): void {
    this.outcome.set(o);
  }

  protected validFromIso(): string {
    return legacyToIso(this.validFrom());
  }

  protected validToIso(): string {
    return legacyToIso(this.validTo());
  }

  protected setValidFrom(iso: string): void {
    this.validFrom.set(isoToLegacy(iso));
  }

  protected setValidTo(iso: string): void {
    this.validTo.set(isoToLegacy(iso));
  }

  protected onUpload(event: Event): void {
    const el = event.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    const problem = validateUpload(file);
    if (problem) {
      this.toast.error(problem);
      return;
    }
    this.uploading.set(true);
    this.dept.uploadSignedCopy(this.app().appl_id, this.taskId(), file).subscribe({
      next: (stored) => {
        this.uploading.set(false);
        this.signedDoc.set({ file_name: stored.file_name, size: stored.size, file_id: stored.file_id });
        this.toast.success(`${stored.file_name} uploaded — it will be attached to the decision.`);
      },
      error: (e: Error) => {
        this.uploading.set(false);
        this.toast.error(e.message);
      },
    });
  }

  protected submit(): void {
    const o = this.outcome();
    if (!o || this.problems().length) return;
    this.decided.emit({
      outcome: o,
      input: {
        remark: this.remark().trim(),
        addcc: this.addcc().trim() || undefined,
        rem_comm: this.remComm().trim() || undefined,
        valid_from: this.validFrom() || undefined,
        valid_to: this.validTo() || undefined,
      },
    });
  }
}
