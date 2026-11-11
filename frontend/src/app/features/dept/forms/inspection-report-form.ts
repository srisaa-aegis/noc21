import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { isoToLegacy, legacyToIso } from '../../../core/domain/dates';
import { BlockObservation, InspectionReportData, inspectionRecommendation, YN } from '../../../core/domain/task-forms';
import { Application } from '../../../core/models';

/**
 * Inspection Report of the Committee Chairman — legacy dfo_report / dfo_report_o / dfo_report_r.
 * One set of observations per block (open spaces / means of escape / floors / fire fighting
 * equipment, + type-specific extras); the recommendation is computed, not chosen (legacy: computed
 * automatically — every observation OK ⇒ Recommend).
 */
@Component({
  selector: 'app-inspection-report-form',
  imports: [FormsModule],
  templateUrl: './inspection-report-form.html',
})
export class InspectionReportForm {
  readonly data = input.required<InspectionReportData>();
  readonly app = input.required<Application>();
  readonly changed = output<void>();

  /** Bumped on every edit so `recommendation` (derived from the mutated, non-signal `data` object) refreshes. */
  private readonly rev = signal(0);

  protected readonly recommendation = computed(() => {
    this.rev();
    return inspectionRecommendation(this.data());
  });

  protected readonly hasPnocConditions = computed(() => this.app().appl_type === 'O' && !!this.app().conditions?.length);

  protected inspectionDateIso(): string {
    return legacyToIso(this.data().inspection_date);
  }

  protected setInspectionDate(iso: string): void {
    this.set('inspection_date', isoToLegacy(iso));
  }

  protected set<K extends keyof InspectionReportData>(key: K, value: InspectionReportData[K]): void {
    this.data()[key] = value;
    this.touch();
  }

  protected setBlock<K extends keyof BlockObservation>(b: BlockObservation, key: K, value: BlockObservation[K]): void {
    b[key] = value;
    this.touch();
  }

  protected yn(b: BlockObservation, key: keyof BlockObservation): YN {
    return b[key] as YN;
  }

  private touch(): void {
    this.rev.update((n) => n + 1);
    this.data().recommendation = inspectionRecommendation(this.data());
    this.changed.emit();
  }
}
