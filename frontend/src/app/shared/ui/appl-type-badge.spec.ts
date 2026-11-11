import { TestBed } from '@angular/core/testing';
import { ApplTypeBadge } from './appl-type-badge';

describe('ApplTypeBadge', () => {
  it('renders the label for an application type', () => {
    const fixture = TestBed.createComponent(ApplTypeBadge);
    fixture.componentRef.setInput('applType', 'P');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Provisional');
  });
});
