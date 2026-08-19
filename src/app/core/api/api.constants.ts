import { environment } from '../../../environments/environment';

/**
 * The admin control plane's wire contract, in one place.
 *
 * Every value here was read out of the backend source during Stage 1 recon, not out
 * of a summary. The corresponding source of truth is named beside each one so a
 * future divergence is checkable rather than guessable.
 */

/** Join the relative API base with a route. `apiBase` is never an absolute host. */
export function apiUrl(route: string): string {
  return `${environment.apiBase}${route}`;
}

/** True when `url` targets this application's own admin API. */
export function isAdminApiUrl(url: string): boolean {
  return url.startsWith(environment.apiBase);
}

/**
 * The five authentication routes. Browser paths are `/api/admin/v1/auth/*`: Apache
 * mounts the admin WSGI app at `/api` and STRIPS that prefix, so Django's
 * `admin/v1/...` routes (platform_admin_app/urls.py) are reached with it.
 */
export const AUTH_ROUTES = {
  login: '/auth/login/',
  verify: '/auth/verify/',
  logout: '/auth/logout/',
  session: '/auth/session/',
  elevate: '/auth/elevate/',
} as const;

/**
 * CSRF cookie name — `platform_admin_app` carries its OWN, NOT Django's default
 * `csrftoken` (which belongs to the customer plane). Declared in
 * `dinify_backend/settings_admin.py`; the `__Host-` prefix is a browser contract
 * requiring Secure + Path=/ + no Domain, which makes it host-only so no sibling
 * subdomain can plant one. `HttpOnly` is false precisely so this app can read it.
 *
 * ONE constant. Nothing else in this repo may spell this string.
 */
export const CSRF_COOKIE_NAME = '__Host-dinify_admin_csrftoken';

/** The header the server compares the cookie against. Django's default, unchanged. */
export const CSRF_HEADER_NAME = 'X-CSRFToken';

/**
 * The only header the admin plane adds to a response
 * (`platform_admin_app/middleware.py`). It is a fresh server-generated uuid4 — never
 * read from a client header — and it is the correlation key into the append-only
 * `AdminAuditLog`. Surfaced to the operator on any error that reaches them as a
 * defect, which is what makes a bug report traceable to a server log line.
 */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/** Methods Django (and `AdminSessionAuthentication.enforce_csrf`) treat as safe. */
export const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];

/**
 * THE TWO MATCH STRINGS the error classifier keys on. Both are read from the DRF
 * `detail` field and nowhere else.
 *
 * TODO(backend): these are prose, compared as strings, which is fragile by
 * construction — a copy edit on the server silently reclassifies an error here. A
 * follow-up backend PR should attach stable machine-readable codes (and normalise the
 * response envelope, see `extractErrorMessage`), at which point both of these and the
 * classifier that reads them get considerably simpler. Until then they live HERE,
 * exported, and are not spelled anywhere else in the repo.
 */

/**
 * `platform_admin_app/permissions.py::IsRecentlyElevated.message`. DRF renders a
 * failed permission as `{"detail": <message>}` with status 403.
 *
 * This is an EXPECTED SECURITY STATE, not an error: the session is valid, it simply
 * has not cleared a second factor recently enough.
 */
export const ELEVATION_REQUIRED_DETAIL = 'This action requires recent re-authentication.';

/**
 * `platform_admin_app/authentication.py::enforce_csrf` raises
 * `PermissionDenied('CSRF Failed: %s' % reason)`, so the body is
 * `{"detail": "CSRF Failed: <django reason>"}`. Matched on the PREFIX because the
 * reason varies — `CSRF cookie not set.`, `CSRF token missing.`,
 * `CSRF token incorrect.` are all the same situation from the client's point of view.
 */
export const CSRF_FAILURE_DETAIL_PREFIX = 'CSRF Failed';

/**
 * Client-side MIRROR of `settings_admin.ADMIN_ELEVATION_MAX_AGE` (5 minutes).
 *
 * ADVISORY ONLY. The server is authoritative and a 403 is the real signal; this
 * exists so a future preflight screen can pre-empt the modal rather than discovering
 * staleness by being refused. Never gate a request on it — if this constant drifts
 * from the server's, the worst outcome must be an unnecessary prompt, never a
 * suppressed one.
 */
export const ELEVATION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Below this, `verify/` reports `recovery_codes_remaining` prominently. Ten are
 * issued at enrolment; running out with a lost authenticator means
 * `manage.py reset_platform_admin_totp` on the box.
 */
export const LOW_RECOVERY_CODES_THRESHOLD = 3;
