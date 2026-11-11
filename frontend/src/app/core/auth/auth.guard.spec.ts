import { TestBed } from '@angular/core/testing';
import { provideRouter, UrlTree } from '@angular/router';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { authGuard } from './auth.guard';

describe('authGuard', () => {
  afterEach(() => resetBrowserState());

  function run(): boolean | UrlTree {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    return TestBed.runInInjectionContext(() => authGuard({} as never, {} as never)) as boolean | UrlTree;
  }

  it('redirects to /auth/login when there is no session', () => {
    resetBrowserState();
    expect(run() instanceof UrlTree).toBe(true);
  });

  it('allows navigation when a session exists', () => {
    seedSession('citizen1', 'citizen');
    expect(run()).toBe(true);
  });
});
