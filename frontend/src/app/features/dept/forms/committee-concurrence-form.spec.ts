import { TestBed } from '@angular/core/testing';
import { initialCommitteeConcurrence } from '../../../core/domain/task-forms';
import { CommitteeConcurrenceForm } from './committee-concurrence-form';

describe('CommitteeConcurrenceForm', () => {
  it('defaults to the standard concurrence text and answers Yes/No', async () => {
    const f = TestBed.createComponent(CommitteeConcurrenceForm);
    const d = initialCommitteeConcurrence();
    f.componentRef.setInput('data', d);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toContain('I agree with the report');
    el.querySelector<HTMLInputElement>('input[name="agree"]')!.click();
    expect(d.agree).toBe('Y');
  });
});
