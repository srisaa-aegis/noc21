import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommitteeConcurrenceData } from '../../../core/domain/task-forms';

/** Committee member concurrence with the Chairman's inspection report — legacy dfo_others_o. */
@Component({
  selector: 'app-committee-concurrence-form',
  imports: [FormsModule],
  templateUrl: './committee-concurrence-form.html',
})
export class CommitteeConcurrenceForm {
  readonly data = input.required<CommitteeConcurrenceData>();
  readonly changed = output<void>();

  protected set<K extends keyof CommitteeConcurrenceData>(key: K, value: CommitteeConcurrenceData[K]): void {
    this.data()[key] = value;
    this.changed.emit();
  }
}
