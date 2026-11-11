import { TestBed } from '@angular/core/testing';
import { BarChart } from './bar-chart';

describe('BarChart', () => {
  it('draws one bar per category × series with value labels, a legend and an accessible table', () => {
    const fixture = TestBed.createComponent(BarChart);
    fixture.componentRef.setInput('title', 'Pending');
    fixture.componentRef.setInput('categories', ['HO', 'Regional', 'District']);
    fixture.componentRef.setInput('series', [
      { label: 'P', color: '#f00', values: [1, 0, 3] },
      { label: 'O', color: '#00f', values: [2, 1, 0] },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('rect').length).toBe(6);
    expect(Array.from(el.querySelectorAll('text.val')).map((t) => t.textContent)).toEqual(['1', '2', '1', '3']);
    expect(el.querySelector('svg')?.getAttribute('aria-label')).toBe('Pending');
    expect(el.querySelectorAll('.legend span').length).toBe(2);
    expect(el.querySelectorAll('table tr').length).toBe(4);
  });
});
