import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { SessionStore } from './session.store';

/**
 * Everything inside the shell requires a session.
 *
 * By the time any route activates, the bootstrap read has already run (see
 * `provideAppInitializer` in app.config.ts), so `SessionStore` is authoritative here
 * and this guard never has to make a request of its own.
 *
 * The `returnUrl` it writes is validated on the way OUT of the login page, never
 * here — see `sanitiseReturnUrl`. Validating on write would be the wrong place: the
 * value can also arrive from a hand-typed or pasted URL that never passed through
 * this function, so the check has to sit where the redirect is performed.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const store = inject(SessionStore);
  const router = inject(Router);

  if (store.isAuthenticated()) return true;

  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
