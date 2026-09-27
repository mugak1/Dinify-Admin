import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import { CommandOwner, IssuedUnder } from './command-owner';
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

  /**
   * Needs no CSRF. D10: ALWAYS NAMED — `owner` is the session this sign-out means to
   * end, captured before the local lifecycle ended, and a server that binds commands
   * refuses (409) to end a different one. There is deliberately no unnamed form: when
   * the owner is unknown, no sign-out request is sent at all.
   */
  logout(owner: CommandOwner): Observable<void>;

  /** The bootstrap read. ENSURES the CSRF cookie exists. */
  readSession(): Observable<AdminSessionResponse>;

  /**
   * Step-up re-authentication on a live session. D10: `issued` is the owner and the
   * lifecycle the PROMPT was opened under, so the factor is evaluated for that session
   * or not at all — the server refuses a changed owner before it looks at the code.
   */
  elevate(
    method: SecondFactorMethod,
    code: string,
    issued: IssuedUnder,
  ): Observable<AdminElevateResponse>;
}

export const ADMIN_AUTH = new InjectionToken<AdminAuthApi>('ADMIN_AUTH');
