import { TestBed } from '@angular/core/testing';
import { fixture as data } from '../../../../testing/fixture-backend';
import { initialInspectionReport } from '../../../core/domain/task-forms';
import { Application } from '../../../core/models';
import { InspectionReportForm } from './inspection-report-form';

describe('InspectionReportForm', () => {
  const o = data<Application[]>('assets/data/applications/applications.json').find((a) => a.appl_id === 102)!; // Occupancy, 2 blocks, PNOC conditions

  it('shows one card per block and recomputes the recommendation live as observations are answered', () => {
    const f = TestBed.createComponent(InspectionReportForm);
    const d = initialInspectionReport(o, '15-Jan-2024');
    f.componentRef.setInput('data', d);
    f.componentRef.setInput('app', o);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.block-card').length).toBe(2);
    expect(el.querySelector('.computed')?.textContent).toContain('Do not recommend');

    const block1 = d.blocks[0].block_id;
    // answer Yes on every question of every block (mutating the shared `data` object directly, as the
    // radio (change) handlers do) and trigger one change event to let the component recompute
    d.blocks.forEach((b) => {
      b.open_spaces_ok = 'Y';
      b.escapes_ok = 'Y';
      b.floors_ok = 'Y';
      b.ffe_ok = 'Y';
      b.pnoc_complied = 'Y';
    });
    el.querySelector<HTMLInputElement>(`input[name="os${block1}"]`)!.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(el.querySelector('.computed')?.textContent).toContain('Recommend');
    expect(el.querySelector('.computed.ok-text')).not.toBeNull();
  });

  it('a Declaration (no blocks) asks about the maintenance of the installed systems instead', () => {
    const decl = data<Application[]>('assets/data/applications/applications.json').find((a) => a.appl_id === 107)!;
    const f = TestBed.createComponent(InspectionReportForm);
    f.componentRef.setInput('data', initialInspectionReport(decl, '01-Jan-2026'));
    f.componentRef.setInput('app', decl);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.block-card').length).toBe(0);
    expect(el.textContent).toContain('installed fire safety systems are maintained');
  });
});
