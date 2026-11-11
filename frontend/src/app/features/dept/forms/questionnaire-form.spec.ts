import { TestBed } from '@angular/core/testing';
import { fixture as data } from '../../../../testing/fixture-backend';
import { initialQuestionnaireData } from '../../../core/domain/task-forms';
import { FormDef } from '../../../core/models';
import { QuestionnaireForm } from './questionnaire-form';

describe('QuestionnaireForm (ADFS / DFS-CD / DFS / DFO notes)', () => {
  const form = data<FormDef[]>('assets/data/config/forms.json').find((f) => f.id === 'adfs_note')!;

  it('hides a show_if question until its condition is met, and reveals it once answered', () => {
    const f = TestBed.createComponent(QuestionnaireForm);
    const d = initialQuestionnaireData(form);
    f.componentRef.setInput('form', form);
    f.componentRef.setInput('data', d);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('what do the Act');

    const yes = el.querySelectorAll<HTMLInputElement>('input[name="adfs_diff_opi"]')[0];
    yes.click();
    expect(d['adfs_diff_opi']).toBe('1');
    f.detectChanges();
    expect(el.textContent).toContain('what do the Act');

    const textarea = el.querySelector<HTMLTextAreaElement>('#adfs_nbc_rules')!;
    textarea.value = 'NBC Part 4';
    textarea.dispatchEvent(new Event('input'));
    expect(d['adfs_nbc_rules']).toBe('NBC Part 4');
  });
});
