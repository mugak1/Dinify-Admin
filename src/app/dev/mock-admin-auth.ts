import { Injectable } from '@angular/core';
import { delay, Observable, of, throwError } from 'rxjs';

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
    sessionStorage.removeItem(STORAGE_KEY);
    return this.ok<void>(undefined);
  }

  readSession(): Observable<AdminSessionResponse> {
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
    if (code === '000000' || !code.trim()) {
      return this.fail(403, 'Invalid or expired verification.');
    }
    return this.ok<AdminElevateResponse>({
      elevated_at: this.iso(0),
      used_recovery_code: _method === 'recovery',
      recovery_codes_remaining: this.pendingLowCodes ? 2 : 8,
    });
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
  constructor(
    readonly status: number,
    readonly error: unknown,
  ) {
    super(`Mock HTTP ${status}`);
    this.name = 'MockHttpError';
  }
}
