import { Injectable, signal } from '@angular/core';

/**
 * IS THE ADMIN CONTROL PLANE ANSWERING? — one signal, read by three surfaces.
 *
 * This is deliberately NOT `DefectService`. A defect is a MESSAGE about something that
 * already happened and stays until dismissed; this is a LIVE STATE that must clear
 * itself the moment the service answers again, and it drives routing (see
 * `authGuard`), which no message should.
 *
 * ── WHY IT CARRIES NO TIMESTAMP ───────────────────────────────────────────────────
 *
 * "Unreachable since 14:02" would need a clock, and the only clock this application
 * trusts is `SessionStore.serverNowMs()` — anchored on the last `server_time` the
 * SERVER stated. There is no fresh anchor precisely when the service is unreachable,
 * and `Date.now()` is exactly the guess the rest of this codebase refuses to make.
 * So the state says what it knows: it is unavailable, and here is the request id.
 */
@Injectable({ providedIn: 'root' })
export class AdminServiceStatus {
  private readonly _unavailable = signal(false);
  private readonly _requestId = signal<string | null>(null);

  /** True when the last attempt got no usable answer. Never means "signed out". */
  readonly unavailable = this._unavailable.asReadonly();

  /** The `X-Request-ID` of the most recent failed attempt, when it had one. */
  readonly requestId = this._requestId.asReadonly();

  /**
   * Record that an attempt got no usable answer.
   *
   * The request id is set UNCONDITIONALLY, including to null. It belongs to the most
   * recent attempt, and a request that never reached the server has none — holding a
   * stale id from an earlier failure would point the report at the wrong log line,
   * which is worse than pointing at nothing.
   */
  reportUnavailable(requestId: string | null): void {
    this._unavailable.set(true);
    this._requestId.set(requestId);
  }

  /**
   * Any answer at all proves the service is reachable — including a 401. Being told
   * "no" is being told something.
   */
  markReachable(): void {
    this._unavailable.set(false);
    this._requestId.set(null);
  }
}
