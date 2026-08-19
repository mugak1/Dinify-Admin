import { HttpContextToken } from '@angular/common/http';

/**
 * Per-request flags the error classifier reads. They exist to make each recovery
 * BOUNDED — one attempt, then the failure is honest — rather than looping.
 */

/**
 * Set on a request that has already been replayed once after a successful
 * re-elevation. If such a request is refused for elevation AGAIN, the modal must NOT
 * reopen: one elevation, one replay, then stop. A second refusal after a second
 * factor was just accepted is a defect, and is surfaced as one.
 */
export const ELEVATION_REPLAYED = new HttpContextToken<boolean>(() => false);

/**
 * Set on a request that has already been retried once after re-bootstrapping the CSRF
 * cookie from `GET /auth/session/`. Same bound, same reasoning: `verify/` rotates the
 * token, so ONE re-bootstrap explains every legitimate stale-token case (another tab
 * signed in). A second CSRF failure is a defect, not a race worth retrying.
 */
export const CSRF_RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * The caller renders this request's failure itself, so the global defect banner must
 * stay quiet. Set by the auth transport — the login form and the re-elevation modal
 * both show the server's message in place.
 */
export const SUPPRESS_DEFECT_REPORT = new HttpContextToken<boolean>(() => false);
