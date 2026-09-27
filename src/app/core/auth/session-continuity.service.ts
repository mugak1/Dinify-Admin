import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';

import { AdminServiceStatus } from '../api/service-status';
import { classifyTransportFailure, extractRequestId } from '../api/transport-failure';
import { ADMIN_AUTH } from './admin-auth.api';
import { boundaryKindFor, SessionBoundary } from './session-boundary.service';
import { AdminSessionResponse, isAdminSessionResponse } from './session.model';
import { Observation, ReadTicket, SessionStore } from './session.store';

/**
 * 'confirmed'    the newest read names the session this document holds.
 * 'unconfirmed'  since the tab was hidden or came back, no read issued AFTER that has
 *                confirmed it — a check is in flight, or could not get a usable answer.
 *                NOT a denial: nobody is signed out. A 401 is the only honest signal of
 *                that, and the error classifier owns it.
 */
export type Continuity = 'confirmed' | 'unconfirmed';

/**
 * RESUME REVALIDATION (D10). A tab that was hidden, restored from the back-forward
 * cache or brought back to the foreground may be holding a session that another tab of
 * this browser has since replaced — and nothing about CSRF has to change for that to be
 * true. So on resume this reads `session/` once and compares the owner with the one the
 * document holds: the same owner confirms, a different one crosses the session boundary.
 *
 * ── SENSITIVE CONTENT IS HIDDEN SYNCHRONOUSLY ─────────────────────────────────────
 *
 * `sensitiveHidden` goes true the moment the tab is hidden or resumes, before any
 * request, and stays true until a read issued AFTER that moment names the same owner —
 * or for good, when there is no session or no binding to confirm against. A claim code
 * is removed from the DOM while it is true. It is not destroyed: the component that
 * holds it still holds it, and it comes back only if that holder still has it.
 *
 * ── BOUNDED AND COALESCED ─────────────────────────────────────────────────────────
 *
 * At most one check is in flight and at most one is queued behind it; any number of
 * events in between collapse into that one. An answer to a check issued before the
 * latest event cannot confirm (`epoch`), so an older check never un-hides content over
 * a newer state — the queued check does that. There is NO polling: a tab that is
 * offline, suspended or never brought back keeps showing what it showed until an event
 * or a request tells it otherwise, and nothing here claims instant erasure.
 *
 * ── LIFECYCLE OWNED ───────────────────────────────────────────────────────────────
 *
 * A check answers for the lifecycle it was issued in. When that lifecycle ends, the
 * in-flight and queued checks are forgotten and whatever they return drives nothing.
 * The event listeners belong to the shell that started them (`start()` returns their
 * teardown).
 *
 * It narrows exposure; it does not remove it. The SERVER's owner precondition is what
 * protects commands. This protects what is SHOWN.
 */
@Injectable({ providedIn: 'root' })
export class SessionContinuityService {
  private readonly store = inject(SessionStore);
  private readonly api = inject(ADMIN_AUTH);
  private readonly boundary = inject(SessionBoundary);
  private readonly status = inject(AdminServiceStatus);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  private readonly _state = signal<Continuity>('confirmed');
  readonly state = this._state.asReadonly();

  /** True whenever this document cannot vouch that its session is still the browser's. */
  readonly sensitiveHidden = computed(
    () =>
      !this.store.isAuthenticated() ||
      this.store.binding() !== 'supported' ||
      this._state() !== 'confirmed',
  );

  /** Advanced by every hide or resume. A read may confirm only the epoch it was issued in. */
  private epochValue = 0;
  private inFlight: object | null = null;
  private queued = false;

  constructor() {
    // A new lifecycle starts from its own verified read; nothing about the last one's
    // checks carries over, and a check still in flight for it answers nothing.
    this.store.ended$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.epochValue += 1;
      this.inFlight = null;
      this.queued = false;
      this._state.set('confirmed');
    });
  }

  /** The epoch a caller must capture BEFORE issuing a session read it will `apply`. */
  epoch(): number {
    return this.epochValue;
  }

  /** Wire the resume signals. Returns the teardown. Called by the shell. */
  start(): () => void {
    const view = this.document.defaultView;
    const onVisibility = (): void => {
      if (this.document.visibilityState === 'visible') this.revalidate();
      else this.markUnconfirmed();
    };
    const onHide = (): void => this.markUnconfirmed();
    const onResume = (): void => this.revalidate();

    this.document.addEventListener('visibilitychange', onVisibility);
    view?.addEventListener('pagehide', onHide);
    view?.addEventListener('pageshow', onResume);
    view?.addEventListener('focus', onResume);
    return () => {
      this.document.removeEventListener('visibilitychange', onVisibility);
      view?.removeEventListener('pagehide', onHide);
      view?.removeEventListener('pageshow', onResume);
      view?.removeEventListener('focus', onResume);
    };
  }

  /** Synchronous: sensitive content is hidden before anything is sent. */
  markUnconfirmed(): void {
    this.epochValue += 1;
    if (this.store.isAuthenticated()) this._state.set('unconfirmed');
  }

  /** Hide now, then ask. */
  revalidate(): void {
    this.markUnconfirmed();
    this.check();
  }

  /** One read, coalesced: a check already in flight queues at most one more. */
  check(): void {
    if (!this.store.isAuthenticated()) return;
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    const token = {};
    this.inFlight = token;
    const ticket = this.store.issueTicket();
    const epoch = this.epochValue;

    this.api.readSession().subscribe({
      next: (session) => this.settle(token, () => this.onSession(ticket, epoch, session)),
      error: (error: unknown) => this.settle(token, () => this.onFailure(ticket, error)),
    });
  }

  /**
   * What a session read issued at (`ticket`, `epoch`) means for this document. Shared
   * with the bootstrap read, so the outage banner's "Check again" confirms exactly the
   * way a resume check does.
   */
  apply(ticket: ReadTicket, epoch: number, session: AdminSessionResponse): Observation {
    const observed = this.store.observe(ticket, session);
    if (observed === 'actor-changed' || observed === 'session-changed') {
      this.boundary.cross(boundaryKindFor(observed));
    } else if ((observed === 'adopted' || observed === 'same') && epoch === this.epochValue) {
      this._state.set('confirmed');
    }
    return observed;
  }

  private settle(token: object, run: () => void): void {
    if (this.inFlight !== token) return;
    this.inFlight = null;
    run();
    if (this.queued && this.inFlight === null) {
      this.queued = false;
      this.check();
    }
  }

  private onSession(ticket: ReadTicket, epoch: number, session: unknown): void {
    if (!this.store.isCurrent(ticket.lifecycle)) return;
    if (!isAdminSessionResponse(session)) {
      // A 200 that is not a session is the same actionable state as no answer.
      this.status.reportUnavailable(null);
      return;
    }
    this.apply(ticket, epoch, session);
  }

  private onFailure(ticket: ReadTicket, error: unknown): void {
    // Ended already — by the classifier's genuine 401, or by anything else. Either
    // way this answer is about a lifecycle this document no longer has.
    if (!this.store.isCurrent(ticket.lifecycle)) return;

    const failure = classifyTransportFailure(error);
    if (failure === 'unavailable') {
      // UNAVAILABLE IS NOT DENIED. The operator stays signed in, sensitive content stays
      // hidden, and the shell's outage banner offers the existing recovery (its "Check
      // again" re-runs the bootstrap read, which confirms through `apply`). Reported
      // here as well as by the interceptor because the development mock runs none.
      this.status.reportUnavailable(extractRequestId(error));
      return;
    }
    if (failure === 'denied' && this.store.isAuthenticated()) {
      // Reached with the lifecycle still current only when no interceptor ran (the
      // development mock). The same genuine current-session denial as the classifier's
      // case 1, handled the same way.
      this.store.end();
      void this.router.navigate(['/login'], {
        queryParams: { returnUrl: this.router.url },
        replaceUrl: true,
      });
    }
    // Anything else is an answer that confirms nothing: content stays hidden.
  }
}
