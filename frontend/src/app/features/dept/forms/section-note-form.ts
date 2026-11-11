import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Application } from '../../../core/models';
import { SectionNoteData, YN } from '../../../core/domain/task-forms';

/** Scrutiny note of the Section (Head Office) — legacy section_note / section_note_o / section_note_r. */
@Component({
  selector: 'app-section-note-form',
  imports: [FormsModule],
  templateUrl: './section-note-form.html',
})
export class SectionNoteForm {
  readonly data = input.required<SectionNoteData>();
  readonly app = input.required<Application>();
  readonly changed = output<void>();

  protected set<K extends keyof SectionNoteData>(key: K, value: SectionNoteData[K]): void {
    this.data()[key] = value;
    this.changed.emit();
  }

  protected yn(key: keyof SectionNoteData): YN {
    return this.data()[key] as YN;
  }
}
