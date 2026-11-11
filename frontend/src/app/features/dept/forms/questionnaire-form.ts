import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QuestionnaireData, visibleQuestions } from '../../../core/domain/task-forms';
import { FormDef } from '../../../core/models';

/**
 * Generic renderer of an admin-picked questionnaire form (ADFS / DFS-CD / DFS / DFO notes —
 * config/forms.json `kind: "questionnaire"`). Text / choice questions, `show_if` dependencies,
 * `required`. The admin only chooses which form a step uses; the questions themselves are fixed
 * (review decision §0.10 — no questionnaire editor).
 */
@Component({
  selector: 'app-questionnaire-form',
  imports: [FormsModule],
  templateUrl: './questionnaire-form.html',
})
export class QuestionnaireForm {
  readonly form = input.required<FormDef>();
  readonly data = input.required<QuestionnaireData>();
  readonly changed = output<void>();

  private readonly rev = signal(0);

  protected readonly visible = computed(() => {
    this.rev();
    return visibleQuestions(this.form(), this.data());
  });

  protected set(key: string, value: string): void {
    this.data()[key] = value;
    this.rev.update((n) => n + 1);
    this.changed.emit();
  }
}
