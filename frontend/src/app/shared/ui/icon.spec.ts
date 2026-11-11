import { TestBed } from '@angular/core/testing';
import { IconComponent } from './icon';

describe('IconComponent', () => {
  it('renders an svg for a known icon name', () => {
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', 'home');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('svg')).toBeTruthy();
  });

  it('falls back to the file icon for an unknown name', () => {
    const fixture = TestBed.createComponent(IconComponent);
    fixture.componentRef.setInput('name', 'does-not-exist');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('svg path')).toBeTruthy();
  });
});
