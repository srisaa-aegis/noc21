import { TestBed } from '@angular/core/testing';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('renders the label for a status id', () => {
    const fixture = TestBed.createComponent(StatusBadge);
    fixture.componentRef.setInput('statusId', 7);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Approved');
  });

  it('renders the optional date label', () => {
    const fixture = TestBed.createComponent(StatusBadge);
    fixture.componentRef.setInput('statusId', 9);
    fixture.componentRef.setInput('dateLabel', '19-Aug-2016');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Rejected');
    expect(text).toContain('19-Aug-2016');
  });
});
