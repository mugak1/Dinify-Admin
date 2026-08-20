import { Injectable } from '@angular/core';
import { delay, Observable, of, throwError } from 'rxjs';

import { REQUEST_ID_HEADER } from '../core/api/api.constants';
import { AdminAuthApi } from '../core/auth/admin-auth.api';
import {
  AdminElevateResponse,
  AdminLoginResponse,
  AdminSessionResponse,
  AdminVerifyResponse,
  SecondFactorMethod,
} from '../core/auth/session.model';

/**
 * A build marker.
 *
 * `scripts/check-mock-isolation.mjs` fails the build if this literal appears anywhere
 * in a production bundle. It is emitted through `console.warn` below so a minifier
 * cannot drop it as dead weight — a marker that can be optimised away proves nothing.
 */
export const MOCK_AUTH_BUILD_MARKER = 'DINIFY_ADMIN_MOCK_AUTH_PRESENT';

/** Kept across a reload so a review session survives refreshing the page. */
const STORAGE_KEY = 'dinify-admin.mock-session';

/**
 * THE OUTAGE LEVER. Set it in the console and reload:
 *
 *   sessionStorage.setItem('dinify-admin.mock-unavailable', '1')     // no answer at all
 *   sessionStorage.setItem('dinify-admin.mock-unavailable', '502')   // answers, badly
 *   sessionStorage.removeItem('dinify-admin.mock-unavailable')       // back to normal
 *
 * '1' gives status 0 — the dead-network case, with no request id because the request
 * never reached a server. '502' gives an Apache error page WITH an `X-Request-ID`, so
 * the "quote this when reporting it" path is reviewable too. Both are the third
 * bootstrap outcome, and without this lever that outcome would be unreachable in the
 * only mode anyone can review before 0C ships a deploy.
 */
const UNAVAILABLE_KEY = 'dinify-admin.mock-unavailable';

/** Stands in for what Apache serves when the admin WSGI app is not there. */
const BAD_GATEWAY_BODY = '<!DOCTYPE HTML><html><head><title>502 Proxy Error</title></head></html>';

/** Latency, so pending states are actually visible when reviewing. */
const LATENCY_MS = 320;

/**
 * The mock transport — HOW THE FOUNDER REVIEWS THIS WORK.
 *
 * `npm start` must render the complete shell, all five destinations and the
 * primitives gallery with NO backend running: it is the only way the visual direction
 * gets reviewed before 0C ships a deploy, and it is how the §16 brand-red decision
 * will actually be made.
 *
 * It implements ONLY the five-route `AdminAuthApi`. Everything above it —
 * `AdminAuthService`, the login component, the interceptors, the elevation queue —
 * is the same code in both modes, so what gets reviewed is the real flow rather than
 * a lookalike.
 *
 * ── LEVERS FOR REVIEWING THE UNHAPPY PATHS ────────────────────────────────────────
 *
 *   any username + any password        → normal sign-in
 *   username containing "locked"       → BREAK-GLASS: `recovery_code_required: true`,
 *                                        and verifying then reports `lockout_cleared`
 *   username containing "low"          → 2 recovery codes remaining, so the
 *                                        low-codes warning is exercised
 *   empty username or password         → the uniform 401 failure body
 *   code `000000` (verify or elevate)  → the uniform verification failure
 *   sessionStorage `dinify-admin.mock-unavailable`
 *     '1'                              → EVERY route answers as a dead network
 *     '502'                            → EVERY route answers 502, with a request id
 *
 * The failure bodies are shaped EXACTLY as the server shapes them —
 * `{status, message}` for these endpoints, not `{detail}` — so the error extractor
 * and the classifier are exercised honestly rather than against a convenient fiction.
 */
@Injectable()
export class MockAdminAuthApi implements AdminAuthApi {
  private pendingRecoveryOnly = false;
  private pendingLowCodes = false;

  constructor() {
    console.warn(
      `[dinify-admin] ${MOCK_AUTH_BUILD_MARKER} — mock authentication is active; no backend is being contacted.`,
    );
  }

  login(username: string, password: string): Observable<AdminLoginResponse> {
    const outage = this.outage<AdminLoginResponse>();
    if (outage) return outage;
    if (!username.trim() || !password) {
      return this.fail(401, 'Invalid credentials.');
    }
    this.pendingRecoveryOnly = username.toLowerCase().includes('locked');
    this.pendingLowCodes = username.toLowerCase().includes('low');

    return this.ok<AdminLoginResponse>({
      second_factor_required: true,
      recovery_code_required: this.pendingRecoveryOnly,
    });
  }

  verify(method: SecondFactorMethod, code: string): Observable<AdminVerifyResponse> {
    const outage = this.outage<AdminVerifyResponse>();
    if (outage) return outage;
    if (code === '000000' || !code.trim()) {
      return this.fail(401, 'Invalid or expired verification.');
    }
    // A recovery-only challenge refuses TOTP as an ordinary bad code — same body,
    // no hint. Mirrored here so the break-glass branch is reviewable end to end.
    if (this.pendingRecoveryOnly && method !== 'recovery') {
      return this.fail(401, 'Invalid or expired verification.');
    }

    sessionStorage.setItem(STORAGE_KEY, '1');
    const result: AdminVerifyResponse = {
      username: 'operator',
      expires_at: this.iso(8 * 60 * 60 * 1000),
      used_recovery_code: method === 'recovery',
      lockout_cleared: this.pendingRecoveryOnly,
      recovery_codes_remaining: this.pendingLowCodes ? 2 : 8,
    };
    this.pendingRecoveryOnly = false;
    return this.ok(result);
  }

  logout(): Observable<void> {
    // No outage branch: `logout/` cannot fail, and client state is cleared regardless
    // of the response, so a mock that failed here would be modelling nothing.
    sessionStorage.removeItem(STORAGE_KEY);
    return this.ok<void>(undefined);
  }

  readSession(): Observable<AdminSessionResponse> {
    const outage = this.outage<AdminSessionResponse>();
    if (outage) return outage;
    if (sessionStorage.getItem(STORAGE_KEY) !== '1') {
      // DRF shape: an unauthenticated read is `{detail}`, not `{status, message}`.
      return throwError(
        () =>
          new MockHttpError(401, { detail: 'Authentication credentials were not provided.' }),
      ).pipe(delay(LATENCY_MS));
    }
    return this.ok<AdminSessionResponse>({
      username: 'operator',
      email: 'operator@dinifyapp.com',
      issued_at: this.iso(-30 * 60 * 1000),
      expires_at: this.iso(7.5 * 60 * 60 * 1000),
      // Signed in a moment ago, so elevation is fresh. Set this to null to review the
      // re-elevation prompt against a stale session.
      elevated_at: this.iso(-60 * 1000),
      server_time: this.iso(0),
    });
  }

  elevate(_method: SecondFactorMethod, code: string): Observable<AdminElevateResponse> {
    const outage = this.outage<AdminElevateResponse>();
    if (outage) return outage;
    if (code === '000000' || !code.trim()) {
      return this.fail(403, 'Invalid or expired verification.');
    }
    return this.ok<AdminElevateResponse>({
      elevated_at: this.iso(0),
      used_recovery_code: _method === 'recovery',
      recovery_codes_remaining: this.pendingLowCodes ? 2 : 8,
    });
  }

  /** The outage lever, if it is set. See `UNAVAILABLE_KEY`. */
  private outage<T>(): Observable<T> | null {
    const lever = sessionStorage.getItem(UNAVAILABLE_KEY);
    if (!lever) return null;

    const error =
      lever === '502'
        ? new MockHttpError(502, BAD_GATEWAY_BODY, 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
        : // Status 0 is what Angular reports for a request that never got an answer.
          // No body and no request id, because there was no response to carry either.
          new MockHttpError(0, null);

    return throwError(() => error).pipe(delay(LATENCY_MS));
  }

  private ok<T>(value: T): Observable<T> {
    return of(value).pipe(delay(LATENCY_MS));
  }

  private fail<T>(status: number, message: string): Observable<T> {
    return throwError(() => new MockHttpError(status, { status, message })).pipe(
      delay(LATENCY_MS),
    );
  }

  /** The mock's own clock is the browser's — the real one comes from the server. */
  private iso(offsetMs: number): string {
    return new Date(Date.now() + offsetMs).toISOString();
  }
}

/**
 * Shaped enough like `HttpErrorResponse` for `extractErrorMessage` to read it, without
 * pretending to be one — nothing in mock mode goes near `HttpClient`.
 */
class MockHttpError extends Error {
  /**
   * Only present when the mocked failure actually reached a server. Shaped enough like
   * `HttpHeaders` for `extractRequestId` to read it — which is the point: THIS IS NOT
   * AN `HttpErrorResponse`, so anything branching on the shape of an error has to
   * duck-type or it will be dead code in mock mode. See `classifyTransportFailure`.
   */
  readonly headers?: { get(name: string): string | null };

  constructor(
    readonly status: number,
    readonly error: unknown,
    requestId?: string,
  ) {
    super(`Mock HTTP ${status}`);
    this.name = 'MockHttpError';
    if (requestId) {
      this.headers = { get: (name: string) => (name === REQUEST_ID_HEADER ? requestId : null) };
    }
  }
}
