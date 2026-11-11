import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { authInterceptor, dataVersionInterceptor } from './core/api/interceptors';
import { ReferenceDataStore } from './core/api/reference-data.store';
import { AuthService } from './core/auth/auth.service';
import { LookupService } from './core/lookups/lookup.service';
import { registerStatuses } from './shared/status.util';
import { firstValueFrom } from 'rxjs';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor, dataVersionInterceptor])),
    // Restore the session from the refresh cookie and warm the reference-data
    // cache (IndexedDB) before the first route renders.
    provideAppInitializer(async () => {
      const auth = inject(AuthService);
      const cache = inject(ReferenceDataStore);
      const lookups = inject(LookupService);
      await auth.restore();
      await cache.init();
      // Status names and badges are configurable (N-4): take them from the reference data.
      await firstValueFrom(lookups.statuses$)
        .then(registerStatuses)
        .catch(() => undefined);
    }),
  ],
};
