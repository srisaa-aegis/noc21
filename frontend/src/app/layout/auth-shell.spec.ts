import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthShell } from './auth-shell';

describe('AuthShell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AuthShell],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders the department banner and NOC Portal title', () => {
    const fixture = TestBed.createComponent(AuthShell);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Fire Services Department');
    expect(text).toContain('NOC Portal');
  });
});
