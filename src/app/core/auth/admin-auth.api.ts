import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import {
  AdminElevateResponse,
  AdminLoginResponse,
  AdminSessionResponse,
  AdminVerifyResponse,
  SecondFactorMethod,
} from './session.model';

/**
 * The five admin authentication routes, and nothing else.
 *
 * This is the ONLY seam in the application that talks to a server, which is what
 * makes `npm start` render the entire shell with no backend running: the mock in
 * `src/app/dev` implements this interface, everything above it is identical in both
 * modes, and the visual direction can therefore be reviewed before 0C ships a deploy.
 */
export interface AdminAuthApi {
  /** Step 1. 200 means the password was accepted — no session exists yet. */
  login(username: string, password: string): Observable<AdminLoginResponse>;

  /** Step 2. Mints the session and ROTATES the CSRF cookie. */
  verify(method: SecondFactorMethod, code: string): Observable<AdminVerifyResponse>;

  /** Idempotent, needs no CSRF, always succeeds. */
  logout(): Observable<void>;

  /** The bootstrap read. ENSURES the CSRF cookie exists. */
  readSession(): Observable<AdminSessionResponse>;

  /** Step-up re-authentication on a live session. */
  elevate(method: SecondFactorMethod, code: string): Observable<AdminElevateResponse>;
}

export const ADMIN_AUTH = new InjectionToken<AdminAuthApi>('ADMIN_AUTH');
