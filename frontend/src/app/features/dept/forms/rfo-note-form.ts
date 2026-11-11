import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RfoNoteBlock, RfoNoteData, YN } from '../../../core/domain/task-forms';

/** Regional Fire Officer note (Head Office workflows) — legacy rfo_note / rfo_note_o / rfo_note_r. */
@Component({
  selector: 'app-rfo-note-form',
  imports: [FormsModule],
  templateUrl: './rfo-note-form.html',
})
export class RfoNoteForm {
  readonly data = input.required<RfoNoteData>();
  readonly changed = output<void>();

  protected set<K extends keyof RfoNoteData>(key: K, value: RfoNoteData[K]): void {
    this.data()[key] = value;
    this.changed.emit();
  }

  protected setBlock<K extends keyof RfoNoteBlock>(b: RfoNoteBlock, key: K, value: RfoNoteBlock[K]): void {
    b[key] = value;
    this.changed.emit();
  }

  protected yn(key: keyof RfoNoteData): YN {
    return this.data()[key] as YN;
  }
}
