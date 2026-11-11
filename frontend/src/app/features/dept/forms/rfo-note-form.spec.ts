import { TestBed } from '@angular/core/testing';
import { fixture as data } from '../../../../testing/fixture-backend';
import { initialRfoNote } from '../../../core/domain/task-forms';
import { Application } from '../../../core/models';
import { RfoNoteForm } from './rfo-note-form';

describe('RfoNoteForm', () => {
  it('shows one NBC check per block and the overall checks / recommendation', () => {
    const app = data<Application[]>('assets/data/applications/applications.json').find((a) => a.appl_id === 101)!; // 2 blocks
    const f = TestBed.createComponent(RfoNoteForm);
    const d = initialRfoNote(app);
    f.componentRef.setInput('data', d);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.yn-row').length).toBe(5); // 2 blocks + approach road + parking + conditions
    el.querySelector<HTMLInputElement>('input[name="recommendation"]')!.click();
    expect(d.recommendation).toBe('Y');
  });
});
