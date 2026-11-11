import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { PortalRole } from '../models';
import { AuthService } from './auth.service';

/** Factory for a guard that restricts a route subtree to one portal role. */
export function portalGuard(portal: PortalRole): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const session = auth.session();
    if (!session) {
      return router.createUrlTree(['/auth/login']);
    }
    if (session.portal !== portal) {
      return router.createUrlTree(['/auth/login']);
    }
    return true;
  };
}
