import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';

import { AdminServiceStatus } from '../api/service-status';
import { NoticeService } from '../notices/notice.service';
import { MockAdminAuthApi } from '../../dev/mock-admin-auth';
import { AdminAuthApi, ADMIN_AUTH } from './admin-auth.api';
import { AdminAuthService, PostVerifyReadError } from './admin-auth.service';
import {
  AdminElevateResponse,
  AdminLoginResponse,
  AdminSessionResponse,
  AdminVerifyResponse,
} from './session.model';
import { SessionStore } from './session.store';

const SESSION: AdminSessionResponse = {
  username: 'operator',
  email: 'operator@dinifyapp.com',
  issued_at: '2026-08-19T09:00:00+00:00',
  expires_at: '2026-08-19T17:00:00+00:00',
  elevated_at: '2026-08-19T11:58:00+00:00',
  server_time: '2026-08-19T12:00:00+00:00',
};

const VERIFIED: AdminVerifyResponse = {
  username: 'operator',
  expires_at: '2026-08-19T17:00:00+00:00',
  used_recovery_code: false,
  lockout_cleared: false,
  recovery_codes_remaining: 8,
};

/** Not an `HttpErrorResponse` — deliberately, and see `classifyTransportFailure`. */
class WireError extends Error {
  constructor(
    readonly status: number,
    readonly error: unknown = null,
    readonly headers?: { get(name: string): string | null },
  ) {
    super(`HTTP ${status}`);
  }
}

class StubApi implements AdminAuthApi {
  sessionReads = 0;
  /** Queued answers for successive `readSession()` calls; the last one repeats. */
  sessionAnswers: (() => Observable<AdminSessionResponse>)[] = [() => of(SESSION)];
  verifyAnswer: () => Observable<AdminVerifyResponse> = () => of(VERIFIED);

  login(): Observable<AdminLoginResponse> {
    return of({ second_factor_required: true, recovery_code_required: false });
  }
  verify(): Observable<AdminVerifyResponse> {
    return this.verifyAnswer();
  }
  logout(): Observable<void> {
    return of(undefined);
  }
  readSession(): Observable<AdminSessionResponse> {
    const answer =
      this.sessionAnswers[Math.min(this.sessionReads, this.sessionAnswers.length - 1)];
    this.sessionReads += 1;
    return answer();
  }
  elevate(): Observable<AdminElevateResponse> {
    throw new Error('not used');
  }
}

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let api: StubApi;
  let store: SessionStore;
  let status: AdminServiceStatus;
  let notices: NoticeService;
  let router: jasmine.SpyObj<Router>;

  beforeEach(() => {
    api = new StubApi();
    router = jasmine.createSpyObj<Router>('Router', ['navigate']);
    router.navigate.and.resolveTo(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: ADMIN_AUTH, useValue: api },
        { provide: Router, useValue: router },
      ],
    });

    service = TestBed.inject(AdminAuthService);
    store = TestBed.inject(SessionStore);
    status = TestBed.inject(AdminServiceStatus);
    notices = TestBed.inject(NoticeService);
  });

  // ── THE THREE BOOTSTRAP OUTCOMES ───────────────────────────────────────────────
  describe('bootstrap', () => {
    it('200 — adopts the session and the server clock anchor', async () => {
      await service.bootstrap();

      expect(store.isAuthenticated()).toBeTrue();
      expect(store.username()).toBe('operator');
      expect(status.unavailable()).toBeFalse();
      expect(service.bootstrapped()).toBeTrue();
    });

    it('401 — SIGNED OUT: the store is cleared and the service counts as reachable', async () => {
      api.sessionAnswers = [() => throwError(() => new WireError(401, { detail: 'no session' }))];

      await service.bootstrap();

      expect(store.isAuthenticated()).toBeFalse();
      // The server answered. "Signed out" is a statement it actually made, and the
      // guard can route to a login form that will work.
      expect(status.unavailable()).toBeFalse();
    });

    it('no answer — UNAVAILABLE, and it does NOT sign the operator out', async () => {
      store.adopt(SESSION);
      api.sessionAnswers = [() => throwError(() => new WireError(0))];

      await service.bootstrap();

      expect(status.unavailable()).toBeTrue();
      // The server never denied this session. Clearing it would be a claim about the
      // operator's credentials that nothing in the exchange supports — and it is
      // exactly what the bare catch used to do.
      expect(store.isAuthenticated()).toBeTrue();
    });

    it('5xx — UNAVAILABLE, carrying the request id to quote', async () => {
      api.sessionAnswers = [
        () =>
          throwError(
            () =>
              new WireError(502, '<html>502</html>', {
                get: (name) => (name === 'X-Request-ID' ? 'req-502' : null),
              }),
          ),
      ];

      await service.bootstrap();

      expect(status.unavailable()).toBeTrue();
      expect(status.requestId()).toBe('req-502');
    });

    it('a 200 that is not a session — UNAVAILABLE, not signed out', async () => {
      // A service answering incoherently is the same actionable state as one not
      // answering. This used to surface as a TypeError inside the store, swallowed by
      // the bare catch and reported to the operator as "signed out".
      api.sessionAnswers = [() => of({ nonsense: true } as unknown as AdminSessionResponse)];

      await service.bootstrap();

      expect(status.unavailable()).toBeTrue();
      expect(store.isAuthenticated()).toBeFalse();
    });

    it('never rejects, whatever happens — a rejection here is a blank page', async () => {
      api.sessionAnswers = [
        () => {
          throw new Error('synchronous explosion');
        },
      ];

      await expectAsync(service.bootstrap()).toBeResolved();
      expect(service.bootstrapped()).toBeTrue();
    });

    it('recovers on a later attempt, so the retry button can actually work', async () => {
      api.sessionAnswers = [() => throwError(() => new WireError(0)), () => of(SESSION)];

      await service.bootstrap();
      expect(status.unavailable()).toBeTrue();

      await service.bootstrap();
      expect(status.unavailable()).toBeFalse();
      expect(store.isAuthenticated()).toBeTrue();
    });

    // THE REVIEW MODE AND THE TESTED PATH ARE THE SAME PATH. `npm start` resolves
    // `ADMIN_AUTH` to this exact class, so the outage a reviewer sees is the one
    // asserted here — including that its error is an `Error` subclass rather than an
    // `HttpErrorResponse`, which is what the duck-typing rule exists for.
    describe('against the development mock', () => {
      afterEach(() => sessionStorage.removeItem('dinify-admin.mock-unavailable'));

      function withMock(): AdminAuthService {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
          providers: [
            { provide: ADMIN_AUTH, useClass: MockAdminAuthApi },
            { provide: Router, useValue: router },
          ],
        });
        status = TestBed.inject(AdminServiceStatus);
        return TestBed.inject(AdminAuthService);
      }

      it("reports the mock's outage lever as unavailable", async () => {
        sessionStorage.setItem('dinify-admin.mock-unavailable', '1');

        await withMock().bootstrap();

        expect(status.unavailable()).toBeTrue();
        expect(status.requestId()).toBeNull();
      });

      it("surfaces the request id from the mock's 502 lever", async () => {
        sessionStorage.setItem('dinify-admin.mock-unavailable', '502');

        await withMock().bootstrap();

        expect(status.unavailable()).toBeTrue();
        expect(status.requestId()).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
      });
    });
  });

  // ── THE POST-VERIFY READ ───────────────────────────────────────────────────────
  describe('verify', () => {
    it('records the recovery-code facts where the operator will see them', async () => {
      api.verifyAnswer = () =>
        of({ ...VERIFIED, lockout_cleared: true, used_recovery_code: true, recovery_codes_remaining: 2 });

      await service.verify('recovery', 'code');

      // Not console.warn. The login component is destroyed by the navigation that
      // follows this, so the channel has to outlive it.
      expect(notices.notice()?.title).toBe('Recovery codes are running low');
    });

    it('RETRIES THE READ ONCE, and a transient failure is invisible to the operator', async () => {
      api.sessionAnswers = [() => throwError(() => new WireError(0)), () => of(SESSION)];

      await expectAsync(service.verify('totp', '123456')).toBeResolved();

      expect(api.sessionReads).toBe(2);
      expect(store.isAuthenticated()).toBeTrue();
      expect(status.unavailable()).toBeFalse();
    });

    it('does not tell the operator their factor was rejected when it was accepted', async () => {
      // THE SESSION COOKIE IS LIVE FOR EIGHT HOURS at this point. The old code rejected
      // with the read's error, which the login form rendered as "Invalid or expired
      // verification." — seconds after the server accepted that very code.
      api.sessionAnswers = [() => throwError(() => new WireError(0))];

      await expectAsync(service.verify('totp', '123456')).toBeRejectedWithError(
        PostVerifyReadError,
      );
      expect(api.sessionReads).toBe(2);
    });

    it('classifies the failure so the caller can route somewhere coherent', async () => {
      api.sessionAnswers = [
        () =>
          throwError(
            () => new WireError(503, null, { get: () => 'req-503' }),
          ),
      ];

      const error = await service.verify('totp', '123456').catch((raised: unknown) => raised);

      expect(error).toBeInstanceOf(PostVerifyReadError);
      expect((error as PostVerifyReadError).failure).toBe('unavailable');
      expect((error as PostVerifyReadError).requestId).toBe('req-503');
      // Reported, so the unavailable view can render the outage the caller routes to.
      expect(status.unavailable()).toBeTrue();
    });

    it('distinguishes a service that answered from one that did not', async () => {
      api.sessionAnswers = [() => throwError(() => new WireError(401))];

      const error = await service.verify('totp', '123456').catch((raised: unknown) => raised);

      expect((error as PostVerifyReadError).failure).toBe('denied');
      expect(status.unavailable()).toBeFalse();
    });
  });

  describe('signOut', () => {
    it('clears the session AND the notices, which belong to one session', async () => {
      await service.bootstrap();
      notices.record({ usedRecoveryCode: true, recoveryCodesRemaining: 1 });

      await service.signOut();

      expect(store.isAuthenticated()).toBeFalse();
      // A recovery-code count must not greet the next operator to sign in here.
      expect(notices.notice()).toBeNull();
      expect(router.navigate).toHaveBeenCalledWith(['/login'], { replaceUrl: true });
    });
  });
});
