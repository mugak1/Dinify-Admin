import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AdminServiceStatus } from '../api/service-status';
import { SessionStore } from './session.store';

/**
 * Everything inside the shell requires a session.
 *
 * By the time any route activates, the bootstrap read has already run (see
 * `provideAppInitializer` in app.config.ts), so `SessionStore` and
 * `AdminServiceStatus` are both authoritative here and this guard never has to make a
 * request of its own.
 *
 * ── THREE OUTCOMES, BECAUSE THE BOOTSTRAP READ HAS THREE ──────────────────────────
 *
 * An empty store used to mean one thing: send them to /login. It means two, and they
 * need different destinations:
 *
 *   authenticated          the shell, as always.
 *   no session, reachable  /login. The server answered and this operator is signed
 *                          out.
 *   no session, no answer  the service-unavailable view. A login form here would
 *                          invite credentials that CANNOT work, and the attempt would
 *                          come back "Invalid credentials." from the uniform-failure
 *                          fallback — a dead control plane presenting as a wrong
 *                          password.
 *
 * A MID-SESSION outage is deliberately absent from that list. `isAuthenticated()` is
 * still true, so the shell stays up and the outage shows as a banner inside it: the
 * server never denied the session, and tearing the frame down would discard an
 * operator's place over a network blip.
 *
 * The `returnUrl` it writes is validated on the way OUT of the login page, never
 * here — see `sanitiseReturnUrl`. Validating on write would be the wrong place: the
 * value can also arrive from a hand-typed or pasted URL that never passed through
 * this function, so the check has to sit where the redirect is performed.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const store = inject(SessionStore);
  const status = inject(AdminServiceStatus);
  const router = inject(Router);

  if (store.isAuthenticated()) return true;

  if (status.unavailable()) {
    return router.createUrlTree(['/unavailable'], { queryParams: { returnUrl: state.url } });
  }

  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/**
 * The service-unavailable view exists for exactly one state, and says so.
 *
 * Without this, a bookmarked or hand-typed /unavailable would tell an operator the
 * control plane is down while it is answering perfectly — the same class of confident
 * false statement this whole change exists to remove, arriving from the other side.
 */
export const serviceUnavailableGuard: CanActivateFn = () => {
  const status = inject(AdminServiceStatus);
  const router = inject(Router);

  return status.unavailable() ? true : router.createUrlTree(['/']);
};
