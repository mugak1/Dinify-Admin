import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';

import { ELEVATION_MAX_AGE_MS } from '../api/api.constants';
import { AdminSessionResponse } from './session.model';

/** How often the derived time signals recompute. Cheap; nothing else depends on it. */
const TICK_MS = 15_000;

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

  /** Adopt a session/ response: identity, expiry, elevation and the clock anchor. */
  adopt(session: AdminSessionResponse): void {
    this._session.set(session);
    this.anchorClock(session.server_time);
  }

  /**
   * Record a fresh elevation without a full session re-read.
   *
   * `elevate/` returns `elevated_at` but not `server_time`, so the clock anchor is
   * deliberately left alone here — a stale anchor is a small error, a wrong one is
   * not.
   */
  markElevated(elevatedAt: string): void {
    this._session.update((current) => (current ? { ...current, elevated_at: elevatedAt } : current));
  }

  /** Signed out, session expired, or revoked. */
  clear(): void {
    this._session.set(null);
    this._anchor.set(null);
  }

  private anchorClock(serverTime: string): void {
    const serverMs = Date.parse(serverTime);
    if (Number.isNaN(serverMs)) return;
    this._anchor.set({ serverMs, monotonicMs: performance.now() });
  }
}
