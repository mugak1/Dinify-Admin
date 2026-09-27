import { HttpContextToken } from '@angular/common/http';

import { CommandOwner } from '../auth/command-owner';

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
 * cookie from `GET /auth/session/`. Same bound, same reasoning: ONE re-read explains
 * the legitimate stale-token cases (a missing cookie, a secret rotated by a sign-in in
 * another tab). A second CSRF failure is a defect, not a race worth retrying.
 *
 * A re-read that repairs CSRF proves NOTHING about which session the command belongs
 * to: `session/` re-emits whatever CSRF secret it was sent. The retry is allowed only
 * when that read names the owner the command was issued under (see `COMMAND_OWNER`).
 */
export const CSRF_RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * The caller renders this request's failure itself, so the global defect banner must
 * stay quiet. Set by the auth transport — the login form and the re-elevation modal
 * both show the server's message in place.
 */
export const SUPPRESS_DEFECT_REPORT = new HttpContextToken<boolean>(() => false);

/**
 * The command owner a request was ISSUED under (D10). Captured once by the error
 * classifier before the first send — or supplied by the caller that owns it: an
 * elevation attempt, or the one named sign-out — and never rewritten by a retry or a
 * replay. Null means not captured yet.
 */
export const COMMAND_OWNER = new HttpContextToken<CommandOwner | null>(() => null);

/**
 * The local session LIFECYCLE a request belongs to (D10). An answer that arrives after
 * that lifecycle ended adopts nothing, clears nothing, navigates nowhere and releases
 * nothing, and a retry or replay whose lifecycle has ended is never sent. Null means
 * not captured yet.
 */
export const LIFECYCLE = new HttpContextToken<number | null>(() => null);

/**
 * THE ONE TEARDOWN EXCEPTION (D10). Sign-out ends the local lifecycle at intent and
 * THEN sends `logout/` naming the owner it captured, so that request is the only one
 * allowed to go out after its lifecycle ended. It must carry a captured owner — an
 * unnamed sign-out is never sent — and its answer drives nothing.
 */
export const SIGN_OUT_TEARDOWN = new HttpContextToken<boolean>(() => false);
