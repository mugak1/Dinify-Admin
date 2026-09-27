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
import { CommandOwner, compareOwners, OwnerReading, readCommandOwner } from './command-owner';
import { SessionContinuityService } from './session-continuity.service';
import {
  AdminLoginResponse,
  AdminVerifyResponse,
  isAdminSessionResponse,
  SecondFactorMethod,
} from './session.model';
import { SessionStore } from './session.store';

/**
 * What became of the remote half of the last sign-out (D10).
 *
 *   'pending'      the named `logout/` is on its way.
 *   'ended'        the server answered it.
 *   'unconfirmed'  it was not established: the owner was unknown so nothing was sent,
 *                  or the request was refused or got no usable answer. This tab is
 *                  signed out either way; the browser may still hold a session.
 */
export type RemoteSignOut = 'pending' | 'ended' | 'unconfirmed';

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
 * The factor was accepted, but the session read back is not the one that `verify/`
 * just minted — its actor or its session differs (D10). Another sign-in happened in
 * this browser in between. Nothing is adopted and no notice is published: the verified
 * operator's facts must not greet whoever the cookie now names. It is NEVER retried —
 * a mismatch is not a transient read failure, and retrying it could only adopt the
 * other operator.
 */
export class PostVerifyCorrelationError extends PostVerifyReadError {
  constructor() {
    super('other', null);
    this.name = 'PostVerifyCorrelationError';
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
  private readonly continuity = inject(SessionContinuityService);

  /**
   * False while a session read is in flight, true once one has settled either way.
   *
   * Read by the service-unavailable view to drive its retry button: `bootstrap()` is
   * re-enterable, so this doubles as "a read is happening right now".
   */
  readonly bootstrapped = signal(false);

  /** The remote half of the last sign-out. Null until one happens. See `RemoteSignOut`. */
  readonly remoteSignOut = signal<RemoteSignOut | null>(null);

  /** Only the newest bootstrap may settle `bootstrapped`. */
  private bootstrapRun = 0;
  /** Only the newest sign-out may report its remote half. */
  private signOutRun = 0;

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
   *
   * ── D10: THE READ ANSWERS FOR THE LIFECYCLE IT WAS ISSUED IN ──────────────────
   *
   * Its success, its failure and its finaliser are all fenced. A read that lands after
   * this document's session ended adopts nothing and clears nothing — a late 401 cannot
   * sign out whoever signed in since — and a read naming a different owner is a SESSION
   * BOUNDARY, never a silent swap of who this document works for. Every read goes
   * through the same rule as the resume check (`SessionContinuityService.apply`), which
   * is what lets the outage banner's "Check again" confirm continuity too.
   */
  async bootstrap(): Promise<void> {
    const run = ++this.bootstrapRun;
    this.bootstrapped.set(false);
    const ticket = this.store.issueTicket();
    const epoch = this.continuity.epoch();
    try {
      const session = await firstValueFrom(this.api.readSession());
      if (!this.store.isCurrent(ticket.lifecycle)) return;
      if (!isAdminSessionResponse(session)) throw new IncoherentResponseError();
      const observed = this.continuity.apply(ticket, epoch, session);
      if (observed === 'actor-changed' || observed === 'session-changed') return;
      this.status.markReachable();

      // TODO(backend): when `GET /auth/session/` carries `recovery_codes_remaining`,
      // one `this.notices.record(...)` call here closes the reload gap documented on
      // `NoticeService` — a source change, not a redesign.
    } catch (error) {
      if (!this.store.isCurrent(ticket.lifecycle)) return;
      if (classifyTransportFailure(error) === 'unavailable') {
        this.status.reportUnavailable(extractRequestId(error));
      } else {
        // 401, or anything else the server actually answered: it IS reachable, and
        // this operator is not signed in. Ending a lifecycle needs a session to end —
        // a signed-out document has none, and nothing issued under it is outstanding.
        if (this.store.isAuthenticated()) this.store.end();
        this.status.markReachable();
      }
    } finally {
      if (run === this.bootstrapRun) this.bootstrapped.set(true);
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
   *
   * ── D10: THE READ AND ITS RETRY ARE ONE OPERATION, OWNED BY ONE LIFECYCLE ─────
   *
   * The lifecycle `verify/` begins is captured ONCE, and the whole recovery answers to
   * it: the retry, each read, the adoption, and every effect of a failure — the outage
   * report included — happen only while it is still current. Once something else has
   * ended it (a sign-out, a denial, a boundary, a successor), whatever the recovery
   * holds is a late answer about a lifecycle that is over: nothing more is read,
   * adopted, reported or published, and the caller is told the sign-in was not
   * completed here. A read never takes its authority from whatever lifecycle holds when
   * an earlier answer lands — that is how an old verification adopted its session after
   * the operator had signed out.
   */
  async verify(method: SecondFactorMethod, code: string): Promise<AdminVerifyResponse> {
    const before = this.store.lifecycle();
    const result = await firstValueFrom(this.api.verify(method, code));
    // Something ended this document's state while the factor was being checked. The
    // new session exists, but this document is no longer the place to adopt it.
    if (!this.store.isCurrent(before)) throw new PostVerifyCorrelationError();

    // D10: A NEW SESSION IS A NEW LIFECYCLE — whatever this document held before is
    // replaced, and anything still waiting on it drains as not run.
    const expected = readCommandOwner(result);
    this.store.end();
    const lifecycle = this.store.lifecycle();
    const owned = (): boolean => this.store.isCurrent(lifecycle);

    try {
      await this.adoptVerified(lifecycle, result, expected);
    } catch (first) {
      // A mismatch is not a transient read failure, and is never retried.
      if (first instanceof PostVerifyCorrelationError) throw first;
      try {
        // The one retry. It refuses before reading if the lifecycle is already over.
        await this.adoptVerified(lifecycle, result, expected);
      } catch (error) {
        // No effect of a failure for a lifecycle that has ended: an outage reported, or
        // a read failure the caller routes on, would be acting on its behalf.
        if (error instanceof PostVerifyCorrelationError || !owned()) {
          throw new PostVerifyCorrelationError();
        }
        const failure = classifyTransportFailure(error);
        const requestId = extractRequestId(error);
        if (failure === 'unavailable') this.status.reportUnavailable(requestId);
        throw new PostVerifyReadError(failure, requestId);
      }
    }
    if (!owned()) throw new PostVerifyCorrelationError();

    this.status.markReachable();
    // A new session: whatever the last sign-out's server half was is no longer news.
    this.remoteSignOut.set(null);
    this.notices.record({
      lockoutCleared: result.lockout_cleared,
      usedRecoveryCode: result.used_recovery_code,
      recoveryCodesRemaining: result.recovery_codes_remaining,
    });
    return result;
  }

  /**
   * Sign out. CLIENT STATE IS CLEARED AT INTENT, before the network — a failed or slow
   * revoke must not leave the operator looking at a portal they believe they have left.
   *
   * D10: THE LIFECYCLE ENDS FIRST. Queued prompts drain as not run and every late
   * answer for this session drives nothing. The owner is captured before that, so
   * `logout/` names the session it means to end: a stale tab cannot end whoever has
   * signed in since (the server answers 409 and revokes nothing).
   *
   * WHEN THE OWNER IS UNKNOWN, NO SIGN-OUT REQUEST IS SENT. An unnamed `logout/` ends
   * whatever session the browser holds, which may be another tab's; downgrading to one
   * silently would re-open exactly that. This tab is still signed out, and
   * `remoteSignOut` says the server side was not established rather than implying it.
   *
   * The CSRF cookie is deliberately NOT cleared. It is inert without a session, and
   * `verify/` rotates it on the next sign-in, so clearing it here would only add a
   * second place that touches CSRF state. See CLAUDE.md.
   */
  async signOut(): Promise<void> {
    const owner = this.store.binding() === 'supported' ? this.store.owner() : null;
    const hadSession = this.store.isAuthenticated();
    const run = ++this.signOutRun;

    this.store.end();
    // Recovery-code counts and a cleared lockout are facts about ONE session and must
    // not greet the next operator to sign in on this machine.
    this.notices.clear();

    if (owner) {
      this.remoteSignOut.set('pending');
      // Fenced: the answer reports on THIS sign-out only, and never once a newer one
      // started or a successor session was adopted here.
      const settle = (outcome: RemoteSignOut): void => {
        if (run === this.signOutRun && !this.store.isAuthenticated()) {
          this.remoteSignOut.set(outcome);
        }
      };
      this.api.logout(owner).subscribe({
        next: () => settle('ended'),
        error: () => settle('unconfirmed'),
      });
    } else {
      this.remoteSignOut.set(hadSession ? 'unconfirmed' : null);
    }

    await this.router.navigate(['/login'], { replaceUrl: true });
  }

  /**
   * The post-verify read must be about the session `verify/` just minted. A server that
   * published an owner is held to it exactly — actor AND session. One that published
   * none (or one this client cannot read) is held to the username, which is all it
   * states, and the lifecycle is then unsupported whatever the read says: nothing ties
   * that read's owner to this sign-in.
   *
   * `lifecycle` is the one `verify()` began. It is checked BEFORE the read is issued —
   * which is what stops the retry once the lifecycle is over — and again when it
   * answers, so no read, and no ticket, is ever taken under a lifecycle this sign-in did
   * not begin.
   */
  private async adoptVerified(
    lifecycle: number,
    result: AdminVerifyResponse,
    expected: OwnerReading,
  ): Promise<void> {
    if (!this.store.isCurrent(lifecycle)) throw new PostVerifyCorrelationError();
    const ticket = this.store.issueTicket();
    const session = await firstValueFrom(this.api.readSession());
    if (!this.store.isCurrent(lifecycle)) throw new PostVerifyCorrelationError();
    if (!isAdminSessionResponse(session)) throw new IncoherentResponseError();
    if (session.username !== result.username) throw new PostVerifyCorrelationError();

    let owner: CommandOwner | null = null;
    if (expected.kind === 'owner') {
      const reading = readCommandOwner(session);
      if (reading.kind !== 'owner' || compareOwners(expected.owner, reading.owner) !== 'same') {
        throw new PostVerifyCorrelationError();
      }
      owner = expected.owner;
    }
    if (!this.store.adoptVerified(ticket, session, owner)) throw new PostVerifyCorrelationError();
  }
}
