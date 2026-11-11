import { TestBed } from '@angular/core/testing';
import { provideRouter, UrlTree } from '@angular/router';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { portalGuard } from './role.guard';

describe('portalGuard', () => {
  afterEach(() => resetBrowserState());

  function run(portal: 'citizen' | 'dept' | 'admin') {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    return TestBed.runInInjectionContext(() => portalGuard(portal)({} as never, {} as never));
  }

  it('redirects to login when unauthenticated', () => {
    expect(run('citizen') instanceof UrlTree).toBe(true);
  });

  it('allows access when the session portal matches', () => {
    seedSession('citizen1', 'citizen');
    expect(run('citizen')).toBe(true);
  });

  it('redirects when the session portal does not match', () => {
    seedSession('admin', 'admin');
    expect(run('citizen') instanceof UrlTree).toBe(true);
  });
});
