import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState } from '../../../testing/session';
import { Login } from './login';

describe('Login', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  function submit(fixture: ReturnType<typeof TestBed.createComponent<Login>>, username: string, password: string) {
    fixture.componentInstance['username'].set(username);
    fixture.componentInstance['password'].set(password);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  }

  it('shows a validation message when submitted empty', () => {
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    submit(fixture, '', '');
    expect(fixture.nativeElement.textContent).toContain('Please enter both a username and a password.');
  });

  it('navigates to the role landing page on a valid login', () => {
    const fixture = TestBed.createComponent(Login);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture.detectChanges();
    submit(fixture, 'citizen1', 'demo');
    expect(navigate).toHaveBeenCalledWith('/citizen/dashboard');
  });

  it('shows the deactivation message for a deactivated account', () => {
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    submit(fixture, 'sai.constructions', 'demo');
    expect(fixture.nativeElement.textContent).toContain('deactivated');
  });

  it('fills credentials when a demo account chip is clicked', () => {
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    (fixture.nativeElement.querySelectorAll('.chip')[0] as HTMLButtonElement).click();
    expect(fixture.componentInstance['username']()).toBe('citizen1');
    expect(fixture.componentInstance['password']()).toBe('demo');
  });
});
