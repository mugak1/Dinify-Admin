import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AdminServiceStatus } from '../api/service-status';
import {
  classifyTransportFailure,
  extractRequestId,
  IncoherentResponseError,
  TransportFailure,
} from '../api/transport-failure';
import { NoticeService } from '../notices/notice.service';
import { ADMIN_AUTH } from './admin-auth.api';
import {
  AdminLoginResponse,
  AdminVerifyResponse,
  isAdminSessionResponse,
  SecondFactorMethod,
} from './session.model';
import { SessionStore } from './session.store';

/**
 * The second factor was ACCEPTED and the session cookie is live, but the session could
 * not be read back.
 *
 * A distinct error because the caller's correct response is nothing like the response
 * to a refused code: telling the operator their factor was rejected — which is what a
 * bare rethrow caused — is false, and it strands them on a login form while an
 * eight-hour session cookie sits in the browser.
 */
export class PostVerifyReadError extends Error {
  constructor(
    readonly failure: TransportFailure,
    readonly requestId: string | null,
  ) {
    super('The second factor was accepted, but the session could not be read back.');
    this.name = 'PostVerifyReadError';
  }
}

/**
 * Orchestration above the five-route transport: bootstrap, sign in, sign out.
 *
 * Deliberately NOT the thing behind the `ADMIN_AUTH` token. The token is the
 * transport; this is the logic. Swapping in the mock therefore exercises every line
 * below unchanged, which is what makes `npm start` a faithful review of the real flow
 * rather than a separate code path that merely looks similar.
 */
@Injectable({ providedIn: 'root' })
export class AdminAuthService {
  private readonly api = inject(ADMIN_AUTH);
  private readonly store = inject(SessionStore);
  private readonly status = inject(AdminServiceStatus);
  private readonly notices = inject(NoticeService);
  private readonly router = inject(Router);

  /**
   * False while a session read is in flight, true once one has settled either way.
   *
   * Read by the service-unavailable view to drive its retry button: `bootstrap()` is
   * re-enterable, so this doubles as "a read is happening right now".
   */
  readonly bootstrapped = signal(false);

  /**
   * THE BOOTSTRAP READ — `GET /auth/session/` before the shell renders.
   *
   * ORDERING IS LOAD-BEARING, for a reason that is not obvious from the call site:
   * `session/` is one of only TWO places the server issues the CSRF cookie (the other
   * is `verify/`). Running it before anything else guarantees the cookie exists
   * before any unsafe request can be attempted, so the first write of a restored
   * session does not have to discover its absence through a 403 and recover.
   *
   * It ENSURES rather than rotates — `get_token` reuses an existing secret — so
   * calling it from a second tab cannot invalidate the token the first tab holds.
   *
   * ── THREE OUTCOMES, AND THEY ARE GENUINELY THREE ──────────────────────────────
   *
   *   200          ADOPT. Identity, expiry, elevation and the server clock anchor.
   *   401          SIGNED OUT. The store is cleared and the guard routes to /login.
   *                The narrow case this always meant.
   *   no answer    UNAVAILABLE. No response, a 5xx, or a 2xx that is not a session.
   *                THE STORE IS NOT CLEARED — the server never denied anything, and
   *                a signed-out state is a statement about the operator's
   *                credentials that nothing here is entitled to make. The guard
   *                routes to the service-unavailable view instead of the login form.
   *
   * A bare catch collapsed all three into "signed out", and the operator then met a
   * login form that answered their correct password with "Invalid credentials." —
   * the uniform failure message doing exactly the job it was designed for, about a
   * situation it knows nothing about.
   *
   * NEVER REJECTS. `provideAppInitializer` awaits this, so a rejection here is a
   * blank page rather than a diagnosis.
   */
  async bootstrap(): Promise<void> {
    this.bootstrapped.set(false);
    try {
      await this.adoptSession();
      this.status.markReachable();

      // TODO(backend): when `GET /auth/session/` carries `recovery_codes_remaining`,
      // one `this.notices.record(...)` call here closes the reload gap documented on
      // `NoticeService` — a source change, not a redesign.
    } catch (error) {
      if (classifyTransportFailure(error) === 'unavailable') {
        this.status.reportUnavailable(extractRequestId(error));
      } else {
        // 401, or anything else the server actually answered: it IS reachable, and
        // this operator is not signed in.
        this.store.clear();
        this.status.markReachable();
      }
    } finally {
      this.bootstrapped.set(true);
    }
  }

  /** Step 1. A 200 means the password was accepted, NOT that a session exists. */
  login(username: string, password: string): Promise<AdminLoginResponse> {
    return firstValueFrom(this.api.login(username, password));
  }

  /**
   * Step 2. On success the server has minted the session cookie and ROTATED the CSRF
   * cookie; the session is then read so the store holds an identity and a clock
   * anchor, and so the rest of the application never has to synthesise either.
   *
   * ── THE READ AFTER THE SUCCESSFUL VERIFY ──────────────────────────────────────
   *
   * By the time the read runs, `__Host-dinify_admin_session` IS LIVE FOR EIGHT HOURS,
   * the CSRF cookie has been rotated, and the challenge cookie has been cleared. If
   * the read then fails, the browser is signed in and the store is empty — and the
   * old code rejected, which the login form rendered as "Invalid or expired
   * verification.", seconds after the server accepted that very factor. The operator's
   * one retry then failed for real (the challenge is spent), they were returned to
   * step 1, and only a page reload could recover them.
   *
   * SO: RETRY THE READ ONCE, then hand the caller a nameable failure.
   *
   * Retry-once rather than a longer policy, because the two things it can fix are a
   * dropped packet and a worker recycling mid-request; anything more durable than
   * that is not a retry problem, and the service-unavailable view offers a MANUAL
   * retry that keeps the operator in charge of when to try again. The retry is
   * immediate — a timer would mean a spinner that hides the fact.
   */
  async verify(method: SecondFactorMethod, code: string): Promise<AdminVerifyResponse> {
    const result = await firstValueFrom(this.api.verify(method, code));

    try {
      await this.adoptSession();
    } catch {
      try {
        await this.adoptSession();
      } catch (error) {
        const failure = classifyTransportFailure(error);
        const requestId = extractRequestId(error);
        if (failure === 'unavailable') this.status.reportUnavailable(requestId);
        throw new PostVerifyReadError(failure, requestId);
      }
    }

    this.status.markReachable();
    this.notices.record({
      lockoutCleared: result.lockout_cleared,
      usedRecoveryCode: result.used_recovery_code,
      recoveryCodesRemaining: result.recovery_codes_remaining,
    });
    return result;
  }

  /**
   * Sign out. Idempotent server-side, and CLIENT STATE IS CLEARED REGARDLESS of the
   * response — a failed revoke must not leave the operator looking at a portal they
   * believe they have left.
   *
   * The CSRF cookie is deliberately NOT cleared. It is inert without a session, and
   * `verify/` rotates it on the next sign-in, so clearing it here would only add a
   * second place that touches CSRF state. See CLAUDE.md.
   */
  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.api.logout());
    } catch {
      // Deliberately swallowed — see above.
    }
    this.store.clear();
    // Recovery-code counts and a cleared lockout are facts about ONE session and must
    // not greet the next operator to sign in on this machine.
    this.notices.clear();
    await this.router.navigate(['/login'], { replaceUrl: true });
  }

  /**
   * Read the session and adopt it, or throw something `classifyTransportFailure` can
   * classify. Shared by the bootstrap read and the post-verify read so the two cannot
   * disagree about what counts as a usable answer.
   */
  private async adoptSession(): Promise<void> {
    const session = await firstValueFrom(this.api.readSession());
    if (!isAdminSessionResponse(session)) throw new IncoherentResponseError();
    this.store.adopt(session);
  }
}
