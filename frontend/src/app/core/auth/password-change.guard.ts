import { inject } from '@angular/core';
import { CanActivateChildFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * An account signed in with a temporary password (new registration, admin reset)
 * must set its own password first: every page of the portal redirects to
 * `<portal>/change-password` until it has. The backend enforces the same rule
 * (403 "change your temporary password") on everything else.
 */
export const passwordChangeGuard: CanActivateChildFn = (_route, state) => {
  const auth = inject(AuthService);
  const session = auth.session();
  if (!session || !auth.mustChangePassword()) return true;
  if (state.url.split('?')[0].endsWith('/change-password')) return true;
  return inject(Router).createUrlTree([`/${session.portal}/change-password`]);
};
