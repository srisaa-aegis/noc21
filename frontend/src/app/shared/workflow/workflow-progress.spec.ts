import { TestBed } from '@angular/core/testing';
import { fixture as data } from '../../../testing/fixture-backend';
import { Application, DeptRole } from '../../core/models';
import { WorkflowProgress } from './workflow-progress';

describe('WorkflowProgress', () => {
  const app = data<Application[]>('assets/data/applications/applications.json').find((a) => a.appl_id === 102)!;
  const roles = data<DeptRole[]>('assets/data/lookups/dept-roles.json');

  it('shows the stages with their parallel tasks and officers, and the process steps', () => {
    const f = TestBed.createComponent(WorkflowProgress);
    f.componentRef.setInput('run', app.workflow!);
    f.componentRef.setInput('roles', roles);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.stage').length).toBe(6);
    const first = el.querySelector('.stage')!;
    expect(first.classList).toContain('stage--active');
    expect(first.querySelectorAll('.task').length).toBe(3);
    expect(first.textContent).toContain('3 in parallel');
    expect(first.textContent).toContain('SFO · SFO - Visakhapatnam');
    // started rows only: section done + two inspection tasks active
    expect(el.querySelectorAll('table.steps tbody tr').length).toBe(3);
  });

  it('the citizen (compact) view shows stages only', () => {
    const f = TestBed.createComponent(WorkflowProgress);
    f.componentRef.setInput('run', app.workflow!);
    f.componentRef.setInput('compact', true);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.stage').length).toBe(6);
    expect(el.querySelector('.task')).toBeNull();
    expect(el.querySelector('table')).toBeNull();
  });
});
