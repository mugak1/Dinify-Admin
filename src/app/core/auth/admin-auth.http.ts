import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { apiUrl, AUTH_ROUTES } from '../api/api.constants';
import {
  COMMAND_OWNER,
  LIFECYCLE,
  SIGN_OUT_TEARDOWN,
  SUPPRESS_DEFECT_REPORT,
} from '../api/http-context';
import { AdminAuthApi } from './admin-auth.api';
import { CommandOwner, IssuedUnder } from './command-owner';
import {
  AdminElevateResponse,
  AdminLoginResponse,
  AdminSessionResponse,
  AdminVerifyResponse,
  SecondFactorMethod,
} from './session.model';

/** The admin plane wraps every success as `{status, message, data}`. */
interface Envelope<T> {
  readonly status: number;
  readonly message: string;
  readonly data: T;
}

/**
 * The real transport. Five routes; no other endpoint is reachable from this repo.
 *
 * Every call is same-origin and relative, so cookies ride automatically and
 * `withCredentials` is deliberately absent — see `Environment.apiBase`.
 */
@Injectable()
export class AdminAuthHttp implements AdminAuthApi {
  private readonly http = inject(HttpClient);

  login(username: string, password: string): Observable<AdminLoginResponse> {
    return this.http
      .post<Envelope<AdminLoginResponse>>(
        apiUrl(AUTH_ROUTES.login),
        { username, password },
        { context: ownedByCaller() },
      )
      .pipe(map((response) => response.data));
  }

  verify(method: SecondFactorMethod, code: string): Observable<AdminVerifyResponse> {
    // `method` is always sent explicitly and has no default — see SecondFactorMethod.
    return this.http
      .post<Envelope<AdminVerifyResponse>>(
        apiUrl(AUTH_ROUTES.verify),
        { method, code },
        { context: ownedByCaller() },
      )
      .pipe(map((response) => response.data));
  }

  logout(owner: CommandOwner): Observable<void> {
    // No CSRF token required: the route is AllowAny with `authentication_classes = []`,
    // so no authenticator runs and nothing enforces the double-submit check.
    //
    // D10: it names the session it means to end. The error classifier attaches the
    // header from `COMMAND_OWNER` and lets this ONE request out after its lifecycle
    // ended (`SIGN_OUT_TEARDOWN`); a stale tab's sign-out is refused (409) rather than
    // ending whoever signed in since.
    return this.http
      .post<Envelope<unknown>>(apiUrl(AUTH_ROUTES.logout), {}, {
        context: ownedByCaller().set(COMMAND_OWNER, owner).set(SIGN_OUT_TEARDOWN, true),
      })
      .pipe(map(() => undefined));
  }

  readSession(): Observable<AdminSessionResponse> {
    return this.http
      .get<Envelope<AdminSessionResponse>>(apiUrl(AUTH_ROUTES.session), {
        context: ownedByCaller(),
      })
      .pipe(map((response) => response.data));
  }

  elevate(
    method: SecondFactorMethod,
    code: string,
    issued: IssuedUnder,
  ): Observable<AdminElevateResponse> {
    // D10: the owner and lifecycle of the PROMPT, not whatever is current when the
    // operator presses Enter. The classifier refuses to send it for an ended lifecycle.
    return this.http
      .post<Envelope<AdminElevateResponse>>(
        apiUrl(AUTH_ROUTES.elevate),
        { method, code },
        {
          context: ownedByCaller()
            .set(COMMAND_OWNER, issued.owner)
            .set(LIFECYCLE, issued.lifecycle),
        },
      )
      .pipe(map((response) => response.data));
  }
}

/**
 * Every auth call renders its own failure — in the login form, or inside the
 * re-elevation modal — so none of them should also raise a global defect banner.
 */
function ownedByCaller(): HttpContext {
  return new HttpContext().set(SUPPRESS_DEFECT_REPORT, true);
}
