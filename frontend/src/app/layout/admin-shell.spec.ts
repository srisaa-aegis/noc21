import { HttpClientTestingModule } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AdminShell } from './admin-shell';

describe('AdminShell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminShell, HttpClientTestingModule],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders the admin portal header', () => {
    const fixture = TestBed.createComponent(AdminShell);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Admin Workbench');
  });
});
