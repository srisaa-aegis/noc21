import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { SessionStore } from './session.store';
import { passwordChangeGuard } from './password-change.guard';

describe('passwordChangeGuard (temporary passwords must be replaced first)', () => {
  beforeEach(() => {
    resetBrowserState();
    seedSession('rfo.officer', 'dept', '5');
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideFixtureBackend()] });
  });

  afterEach(() => resetBrowserState());

  const run = (url: string) =>
    TestBed.runInInjectionContext(() => passwordChangeGuard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot));

  it('lets every page through when no change is pending', () => {
    expect(run('/dept/dashboard')).toBe(true);
  });

  it('redirects to the portal change-password page while a change is pending', () => {
    TestBed.inject(SessionStore).mustChangePassword.set(true);
    const result = run('/dept/dashboard');
    expect(result instanceof UrlTree).toBe(true);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/dept/change-password');
    expect(run('/dept/change-password')).toBe(true);
  });
});
