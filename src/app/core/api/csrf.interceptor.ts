import { HttpInterceptorFn } from '@angular/common/http';

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  isAdminApiUrl,
  SAFE_METHODS,
} from './api.constants';
import { readCookie } from './cookie';

/**
 * Echo the admin plane's CSRF cookie back as `X-CSRFToken` on unsafe methods.
 *
 * SAFE METHODS ARE UNTOUCHED. `AdminSessionAuthentication.enforce_csrf` exempts
 * GET/HEAD/OPTIONS/TRACE, and `GET /auth/session/` is where the cookie is ISSUED —
 * attaching a header there would be noise at best.
 *
 * A MISSING COOKIE IS NOT AN ERROR HERE. The request goes out without the header and
 * the server answers `403 CSRF Failed: CSRF cookie not set.`, which the error
 * classifier turns into exactly one re-bootstrap and one retry. Guessing or blocking
 * here would duplicate that recovery in a second place.
 *
 * ORDER MATTERS: this interceptor is registered AFTER the error classifier, so a
 * request the classifier replays re-enters this function and picks up the CURRENT
 * cookie. Registered the other way round, a retry after a CSRF re-bootstrap would go
 * out carrying the stale token it had just been refused for. See `app.config.ts`.
 */
export const csrfInterceptor: HttpInterceptorFn = (req, next) => {
  if (SAFE_METHODS.includes(req.method.toUpperCase())) return next(req);
  if (!isAdminApiUrl(req.url)) return next(req);

  const token = readCookie(CSRF_COOKIE_NAME);
  if (!token) return next(req);

  return next(req.clone({ setHeaders: { [CSRF_HEADER_NAME]: token } }));
};
