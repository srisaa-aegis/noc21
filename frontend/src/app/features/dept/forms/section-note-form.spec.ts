import { TestBed } from '@angular/core/testing';
import { fixture as data } from '../../../../testing/fixture-backend';
import { initialSectionNote } from '../../../core/domain/task-forms';
import { Application } from '../../../core/models';
import { SectionNoteForm } from './section-note-form';

describe('SectionNoteForm', () => {
  const app = data<Application[]>('assets/data/applications/applications.json').find((a) => a.appl_id === 101)!; // Provisional

  it('renders the bank guarantee / FFE estimate checks only for Provisional, and emits on every change', () => {
    const f = TestBed.createComponent(SectionNoteForm);
    const d = initialSectionNote(app, 'Section Officer (HQ)');
    f.componentRef.setInput('data', d);
    f.componentRef.setInput('app', app);
    let changed = 0;
    f.componentInstance.changed.subscribe(() => changed++);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('bank guarantee');

    const yes = el.querySelector<HTMLInputElement>('input[name="applicant_ok"]')!;
    yes.click();
    expect(d.applicant_ok).toBe('Y');
    expect(changed).toBe(1);
  });

  it('does not ask about the bank guarantee / FFE estimate for Occupancy', () => {
    const o = data<Application[]>('assets/data/applications/applications.json').find((a) => a.appl_id === 102)!;
    const f = TestBed.createComponent(SectionNoteForm);
    f.componentRef.setInput('data', initialSectionNote(o, 'x'));
    f.componentRef.setInput('app', o);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).not.toContain('bank guarantee');
  });
});
