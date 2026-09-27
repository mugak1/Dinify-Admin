import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { ELEVATION_MAX_AGE_MS } from '../api/api.constants';
import { CommandOwner, compareOwners, readCommandOwner } from './command-owner';
import { AdminSessionResponse } from './session.model';

/** How often the derived time signals recompute. Cheap; nothing else depends on it. */
const TICK_MS = 15_000;

/**
 * D10. Whether commands from this lifecycle can be bound to the session that issued
 * them.
 *
 *   'unknown'      no session is held.
 *   'supported'    the session's owner was read and is held; guarded writes name it.
 *   'unsupported'  the server published no usable owner, or stopped publishing one.
 *                  Guarded writes are not sent: an unnamed command is exactly the one
 *                  the server cannot refuse on the operator's behalf.
 */
export type CommandBinding = 'unknown' | 'supported' | 'unsupported';

/** When a session read was issued: its lifecycle, and its place in issue order. */
export interface ReadTicket {
  readonly lifecycle: number;
  readonly seq: number;
}

/**
 * What a session read says about the session this document holds.
 *
 *   'stale'            issued under a lifecycle that has since ended; it answers nothing.
 *   'superseded'       issued BEFORE a read this lifecycle has already applied, and it
 *                      disagrees with it. It describes an earlier moment: nothing is
 *                      adopted, withdrawn, confirmed or crossed on its strength.
 *   'adopted'          the lifecycle's first session.
 *   'same'             still the owner this document holds.
 *   'unbound'          the same account, but no owner to compare. Nothing is confirmed
 *                      and guarded writes stay disabled for the rest of the lifecycle.
 *   'actor-changed'    a different administrator.
 *   'session-changed'  the same administrator in a different session.
 *
 * The last two are a SESSION BOUNDARY. The store adopts neither — silently swapping who
 * this document works for is the defect D10 closes — and the caller crosses it.
 */
export type Observation =
  | 'stale'
  | 'superseded'
  | 'adopted'
  | 'same'
  | 'unbound'
  | 'actor-changed'
  | 'session-changed';

/**
 * The signed-in session, and the SERVER-ANCHORED clock derived from it.
 *
 * ── WHY THERE IS NO SESSION COUNTDOWN, AND WHY ONE MUST NOT BE ADDED ──────────────
 *
 * A session dies for three independent reasons: the 8-hour absolute expiry, a
 * 30-MINUTE IDLE TIMEOUT, or revocation. Only the first is visible from here.
 * `ADMIN_SESSION_IDLE_TIMEOUT` is a server constant that appears in NO response body
 * and NO response header — verified by grep across `platform_admin_app` during
 * recon — and `sessions.touch()` writes `last_seen` at most once every five minutes,
 * so the client cannot even infer it from request timing.
 *
 * A countdown built from `expires_at` alone would therefore read "6h 12m remaining"
 * to an operator whose session died thirty minutes ago. That is not an imprecise
 * indicator; it is a confident false statement, on the surface where the operator
 * decides whether it is safe to start something consequential. A 401 is the only
 * honest signal that a session has ended, and the error classifier already routes it.
 *
 * If a warning is ever genuinely wanted, the correct fix is a backend PR exposing the
 * idle deadline — not arithmetic on the one field that happens to be visible.
 *
 * ── THE CLOCK ─────────────────────────────────────────────────────────────────────
 *
 * `serverNowMs()` is `server_time` from the last session read, advanced by ELAPSED
 * time from `performance.now()`. Two properties follow, and both matter:
 *
 *   - it never reads `Date.now()`, so an operator administering from another timezone
 *     on a machine with a skewed clock still sees correct staleness and correct
 *     relative times;
 *   - `performance.now()` is monotonic, so it survives the user (or NTP) changing the
 *     system clock mid-session, which `Date.now()` would not.
 *
 * `Date.parse()` on an ISO string with an offset yields an absolute epoch instant and
 * does NOT consult the local clock, so parsing the server's timestamps is safe.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly _session = signal<AdminSessionResponse | null>(null);
  /** `{ serverMs, monotonicMs }` captured whenever the server states its own time. */
  private readonly _anchor = signal<{ serverMs: number; monotonicMs: number } | null>(null);
  /** Advances so the derived time signals recompute without anyone re-reading. */
  private readonly _tick = signal(0);

  /** D10. The adopted session's owner. Fixed for a lifecycle; never swapped in place. */
  private readonly _owner = signal<CommandOwner | null>(null);
  private readonly _binding = signal<CommandBinding>('unknown');
  /**
   * D10. A GENERATION, advanced whenever this document's session ENDS: sign-out intent,
   * a genuine current-session denial, a session boundary, or a new sign-in replacing
   * it. Every request captures it at issuance, and an answer that lands under a later
   * one drives nothing.
   */
  private readonly _lifecycle = signal(0);
  private readonly _ended = new Subject<number>();
  /** The last read ticket issued, and the newest read whose fields were adopted. */
  private issuedSeq = 0;
  private appliedSeq = 0;

  readonly owner = this._owner.asReadonly();
  readonly binding = this._binding.asReadonly();
  readonly lifecycle = this._lifecycle.asReadonly();
  /**
   * Emits the number of the lifecycle that just ENDED, synchronously and before any
   * network call that follows it — so queued work is drained before anything else runs.
   */
  readonly ended$: Observable<number> = this._ended.asObservable();

  /** The current session, or null when signed out. */
  readonly session = this._session.asReadonly();
  readonly isAuthenticated = computed(() => this._session() !== null);
  readonly username = computed(() => this._session()?.username ?? null);
  readonly email = computed(() => this._session()?.email ?? null);

  constructor() {
    const timer = setInterval(() => this._tick.update((n) => n + 1), TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /**
   * The server's clock, now — anchored on the last `server_time` the server stated.
   *
   * Null before the first session read. Callers that format a relative time should
   * fall back to showing an absolute time rather than guessing.
   */
  readonly serverNowMs = computed<number | null>(() => {
    this._tick();
    const anchor = this._anchor();
    if (!anchor) return null;
    return anchor.serverMs + (performance.now() - anchor.monotonicMs);
  });

  /** How long ago this session last cleared a second factor, in ms. Null if never. */
  readonly elevationAgeMs = computed<number | null>(() => {
    const elevatedAt = this._session()?.elevated_at;
    const now = this.serverNowMs();
    if (!elevatedAt || now === null) return null;
    const parsed = Date.parse(elevatedAt);
    return Number.isNaN(parsed) ? null : now - parsed;
  });

  /**
   * Whether a step-up-gated action would currently be refused.
   *
   * ADVISORY. `ELEVATION_MAX_AGE_MS` mirrors a server constant this client cannot
   * read, so treat a `true` as "expect a prompt" and never as "suppress the request".
   * The server's 403 remains the only authority; this signal exists so a future
   * preflight screen can PRE-EMPT the modal instead of discovering staleness by
   * being refused mid-action.
   */
  readonly elevationStale = computed<boolean>(() => {
    const age = this.elevationAgeMs();
    return age === null || age > ELEVATION_MAX_AGE_MS;
  });

  /** True while `lifecycle` is still this document's current one. */
  isCurrent(lifecycle: number | null): boolean {
    return lifecycle === this._lifecycle();
  }

  /** Take a ticket BEFORE issuing a session read; hand it to `observe` with the answer. */
  issueTicket(): ReadTicket {
    this.issuedSeq += 1;
    return { lifecycle: this._lifecycle(), seq: this.issuedSeq };
  }

  /**
   * THE ONE RULE FOR A SESSION READ (D10). The bootstrap, the resume check and the CSRF
   * recovery all come through here, so they cannot disagree about what a read proves.
   *
   * A read answers for the lifecycle it was ISSUED in. Within that lifecycle the first
   * session is adopted and its owner fixed; every later read must name the same owner,
   * and a read that names someone else is reported rather than adopted.
   *
   * AN OLDER READ NEVER OVERTURNS A NEWER ONE. Reads go out in issue order and each
   * carries the cookie the browser held when it was SENT, so a read that settles after a
   * newer one was applied (`seq`) describes an earlier moment. It may agree with what is
   * held; anything else it says is `superseded` — no change is reported and no capability
   * withdrawn on the strength of that moment. Nor does it overwrite a newer read's fields.
   *
   * A CACHED CAPABILITY IS NOT PERPETUAL PROOF. A NEWER read that no longer publishes an
   * owner withdraws it for the rest of the lifecycle: the server that answers now may
   * not be the one that enforced it before.
   */
  observe(ticket: ReadTicket, session: AdminSessionResponse): Observation {
    if (!this.isCurrent(ticket.lifecycle)) return 'stale';
    const held = this._session();
    const reading = readCommandOwner(session);

    if (held === null) {
      this.install(ticket, session, reading.kind === 'owner' ? reading.owner : null);
      return 'adopted';
    }
    const superseded = ticket.seq <= this.appliedSeq;
    if (session.username !== held.username) return superseded ? 'superseded' : 'actor-changed';

    const owner = this._owner();
    if (owner === null) {
      // This lifecycle never had an owner to compare. The account matches and that is
      // all that can be said: nothing is confirmed, and writes stay disabled.
      this.refresh(ticket, session);
      return 'unbound';
    }
    if (reading.kind !== 'owner') {
      if (superseded) return 'superseded';
      this._owner.set(null);
      this._binding.set('unsupported');
      // The newest read applied, even though it withdrew rather than confirmed.
      this.refresh(ticket, session);
      return 'unbound';
    }
    const change = compareOwners(owner, reading.owner);
    if (change !== 'same') return superseded ? 'superseded' : change;
    this.refresh(ticket, session);
    return 'same';
  }

  /**
   * Begin a lifecycle's session from a post-verify read the caller has already
   * CORRELATED with the verify response. `owner` is the verified one, or null when the
   * verify published none — the lifecycle is then unsupported, whatever the read says,
   * because nothing ties that read's owner to the sign-in that just happened.
   *
   * False, adopting nothing, when the lifecycle moved on or a session is already held.
   */
  adoptVerified(ticket: ReadTicket, session: AdminSessionResponse, owner: CommandOwner | null): boolean {
    if (!this.isCurrent(ticket.lifecycle) || this._session() !== null) return false;
    this.install(ticket, session, owner);
    return true;
  }

  /**
   * Adopt a `session/` response as if it had just been read. Specs and first reads;
   * production read paths take a ticket BEFORE the read and call `observe` with it.
   */
  adopt(session: AdminSessionResponse): Observation {
    return this.observe(this.issueTicket(), session);
  }

  /**
   * Record a fresh elevation without a full session re-read.
   *
   * `elevate/` returns `elevated_at` but not `server_time`, so the clock anchor is
   * deliberately left alone here — a stale anchor is a small error, a wrong one is
   * not.
   *
   * D10: only for the lifecycle the elevation was ATTEMPTED in, and never backwards —
   * elevation time only moves forward within a session, so an older answer landing after
   * a newer read cannot make the session look less recently elevated than it is.
   */
  markElevated(elevatedAt: string, lifecycle: number): void {
    if (!this.isCurrent(lifecycle)) return;
    this._session.update((current) =>
      current ? { ...current, elevated_at: laterElevation(current.elevated_at, elevatedAt) } : current,
    );
  }

  /**
   * END THIS DOCUMENT'S SESSION: signed out, expired, revoked, replaced by a new sign-in,
   * or a session boundary crossed. The generation moves FIRST, then state is cleared,
   * then `ended$` fires — so by the time anything reacts, every answer for the old
   * lifecycle is already stale.
   */
  end(): void {
    const ended = this._lifecycle();
    this._lifecycle.set(ended + 1);
    this._session.set(null);
    this._anchor.set(null);
    this._owner.set(null);
    this._binding.set('unknown');
    this._ended.next(ended);
  }

  private install(ticket: ReadTicket, session: AdminSessionResponse, owner: CommandOwner | null): void {
    this._session.set(session);
    this.anchorClock(session.server_time);
    this._owner.set(owner);
    this._binding.set(owner ? 'supported' : 'unsupported');
    this.appliedSeq = Math.max(this.appliedSeq, ticket.seq);
  }

  /**
   * Adopt a same-owner read's fields — only if it is newer than the last one adopted.
   * Elevation keeps the later of the two times: a read issued before an `elevate/` can
   * still be the newest READ when it lands after that elevation was recorded.
   */
  private refresh(ticket: ReadTicket, session: AdminSessionResponse): void {
    if (ticket.seq <= this.appliedSeq) return;
    this.appliedSeq = ticket.seq;
    const elevatedAt = laterElevation(this._session()?.elevated_at ?? null, session.elevated_at);
    this._session.set({ ...session, elevated_at: elevatedAt });
    this.anchorClock(session.server_time);
  }

  private anchorClock(serverTime: string): void {
    const serverMs = Date.parse(serverTime);
    if (Number.isNaN(serverMs)) return;
    this._anchor.set({ serverMs, monotonicMs: performance.now() });
  }
}

/** The later of two elevation times. An unreadable or absent one never wins. */
function laterElevation(held: string | null, incoming: string | null): string | null {
  if (incoming === null) return held;
  if (held === null) return incoming;
  const a = Date.parse(held);
  const b = Date.parse(incoming);
  if (Number.isNaN(b)) return held;
  if (Number.isNaN(a)) return incoming;
  return b >= a ? incoming : held;
}
