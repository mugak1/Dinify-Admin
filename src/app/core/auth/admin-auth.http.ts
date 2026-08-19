import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { apiUrl, AUTH_ROUTES } from '../api/api.constants';
import { SUPPRESS_DEFECT_REPORT } from '../api/http-context';
import { AdminAuthApi } from './admin-auth.api';
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

  logout(): Observable<void> {
    // No CSRF token required: the route is AllowAny with `authentication_classes = []`,
    // so no authenticator runs and nothing enforces the double-submit check. It is
    // also idempotent and always 200s, including with no session at all.
    return this.http
      .post<Envelope<unknown>>(apiUrl(AUTH_ROUTES.logout), {}, { context: ownedByCaller() })
      .pipe(map(() => undefined));
  }

  readSession(): Observable<AdminSessionResponse> {
    return this.http
      .get<Envelope<AdminSessionResponse>>(apiUrl(AUTH_ROUTES.session), {
        context: ownedByCaller(),
      })
      .pipe(map((response) => response.data));
  }

  elevate(method: SecondFactorMethod, code: string): Observable<AdminElevateResponse> {
    return this.http
      .post<Envelope<AdminElevateResponse>>(
        apiUrl(AUTH_ROUTES.elevate),
        { method, code },
        { context: ownedByCaller() },
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
