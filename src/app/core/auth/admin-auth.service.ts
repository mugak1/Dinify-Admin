import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ADMIN_AUTH } from './admin-auth.api';
import { AdminLoginResponse, AdminVerifyResponse, SecondFactorMethod } from './session.model';
import { SessionStore } from './session.store';

/**
 * Orchestration above the five-route transport: bootstrap, sign in, sign out.
 *
 * Deliberately NOT the thing behind the `ADMIN_AUTH` token. The token is the
 * transport; this is the logic. Swapping in the mock therefore exercises every line
 * below unchanged, which is what makes `npm start` a faithful review of the real flow
 * rather than a separate code path that merely looks similar.
 */
@Injectable({ providedIn: 'root' })
export class AdminAuthService {
  private readonly api = inject(ADMIN_AUTH);
  private readonly store = inject(SessionStore);
  private readonly router = inject(Router);

  /** True once the bootstrap read has settled, either way. */
  readonly bootstrapped = signal(false);

  /**
   * THE BOOTSTRAP READ — `GET /auth/session/` before the shell renders.
   *
   * ORDERING IS LOAD-BEARING, for a reason that is not obvious from the call site:
   * `session/` is one of only TWO places the server issues the CSRF cookie (the other
   * is `verify/`). Running it before anything else guarantees the cookie exists
   * before any unsafe request can be attempted, so the first write of a restored
   * session does not have to discover its absence through a 403 and recover.
   *
   * It ENSURES rather than rotates — `get_token` reuses an existing secret — so
   * calling it from a second tab cannot invalidate the token the first tab holds.
   *
   * Never rejects. A 401 simply means "signed out": the store stays empty and the
   * auth guard routes to /login.
   */
  async bootstrap(): Promise<void> {
    try {
      const session = await firstValueFrom(this.api.readSession());
      this.store.adopt(session);
    } catch {
      this.store.clear();
    } finally {
      this.bootstrapped.set(true);
    }
  }

  /** Step 1. A 200 means the password was accepted, NOT that a session exists. */
  login(username: string, password: string): Promise<AdminLoginResponse> {
    return firstValueFrom(this.api.login(username, password));
  }

  /**
   * Step 2. On success the server has minted the session cookie and ROTATED the CSRF
   * cookie; the session is then read so the store holds an identity and a clock
   * anchor, and so the rest of the application never has to synthesise either.
   */
  async verify(method: SecondFactorMethod, code: string): Promise<AdminVerifyResponse> {
    const result = await firstValueFrom(this.api.verify(method, code));
    const session = await firstValueFrom(this.api.readSession());
    this.store.adopt(session);
    return result;
  }

  /**
   * Sign out. Idempotent server-side, and CLIENT STATE IS CLEARED REGARDLESS of the
   * response — a failed revoke must not leave the operator looking at a portal they
   * believe they have left.
   *
   * The CSRF cookie is deliberately NOT cleared. It is inert without a session, and
   * `verify/` rotates it on the next sign-in, so clearing it here would only add a
   * second place that touches CSRF state. See CLAUDE.md.
   */
  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.api.logout());
    } catch {
      // Deliberately swallowed — see above.
    }
    this.store.clear();
    await this.router.navigate(['/login'], { replaceUrl: true });
  }
}
