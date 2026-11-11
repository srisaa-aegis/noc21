import { HttpClientTestingModule } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CitizenShell } from './citizen-shell';

describe('CitizenShell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CitizenShell, HttpClientTestingModule],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders the citizen portal header', () => {
    const fixture = TestBed.createComponent(CitizenShell);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Citizen Portal');
  });
});
