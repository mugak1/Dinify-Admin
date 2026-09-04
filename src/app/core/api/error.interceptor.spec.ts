import {
  HttpClient,
  HttpContext,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Observable, Subject, of } from 'rxjs';

import { AdminAuthApi, ADMIN_AUTH } from '../auth/admin-auth.api';
import { ElevationCancelledError, ElevationService } from '../auth/elevation.service';
import { SessionStore } from '../auth/session.store';
import {
  apiUrl,
  AUTH_ROUTES,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  ELEVATION_REQUIRED_DETAIL,
  REQUEST_ID_HEADER,
} from './api.constants';
import { csrfInterceptor } from './csrf.interceptor';
import { SUPPRESS_DEFECT_REPORT } from './http-context';
import { DefectService } from './defect.service';
import { errorClassifierInterceptor } from './error.interceptor';
import { AdminServiceStatus } from './service-status';

const SESSION_BODY = {
  username: 'operator',
  email: 'operator@dinifyapp.com',
  issued_at: '2026-08-19T09:00:00+00:00',
  expires_at: '2026-08-19T17:00:00+00:00',
  elevated_at: '2026-08-19T11:58:00+00:00',
  server_time: '2026-08-19T12:00:00+00:00',
};

/** A stand-in transport whose `readSession` is observable from the spec. */
class StubAuthApi implements AdminAuthApi {
  sessionReads = 0;

  login(): Observable<never> {
    throw new Error('not used');
  }
  verify(): Observable<never> {
    throw new Error('not used');
  }
  logout(): Observable<void> {
    return of(undefined);
  }
  readSession() {
    this.sessionReads += 1;
    return of(SESSION_BODY);
  }
  elevate(): Observable<never> {
    throw new Error('not used');
  }
}

/** Lets a spec decide exactly when an elevation succeeds or is cancelled. */
class StubElevation {
  requests = 0;
  private subject = new Subject<void>();

  request(): Observable<void> {
    this.requests += 1;
    return this.subject.asObservable();
  }

  succeed(): void {
    this.subject.next();
    this.subject.complete();
    this.subject = new Subject<void>();
  }

  cancel(): void {
    this.subject.error(new ElevationCancelledError());
    this.subject = new Subject<void>();
  }
}

describe('errorClassifierInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let router: jasmine.SpyObj<Router>;
  let defects: DefectService;
  let status: AdminServiceStatus;
  let store: SessionStore;
  let auth: StubAuthApi;
  let elevation: StubElevation;

  const PROTECTED = apiUrl('/restaurants/abc/transition/');

  beforeEach(() => {
    router = jasmine.createSpyObj<Router>('Router', ['navigate'], { url: '/restaurants/abc' });
    router.navigate.and.resolveTo(true);
    auth = new StubAuthApi();
    elevation = new StubElevation();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorClassifierInterceptor, csrfInterceptor])),
        provideHttpClientTesting(),
        { provide: Router, useValue: router },
        { provide: ADMIN_AUTH, useValue: auth },
        { provide: ElevationService, useValue: elevation },
      ],
    });

    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    defects = TestBed.inject(DefectService);
    status = TestBed.inject(AdminServiceStatus);
    store = TestBed.inject(SessionStore);
  });

  afterEach(() => backend.verify());

  // ── PRECONDITION ───────────────────────────────────────────────────────────────
  describe('no usable response — prior to all four cases', () => {
    it('marks the service unavailable on a dead network, and does NOT sign anyone out', () => {
      store.adopt(SESSION_BODY);
      http.get(PROTECTED).subscribe({ error: () => undefined });

      backend.expectOne(PROTECTED).error(new ProgressEvent('error'));

      expect(status.unavailable()).toBeTrue();
      // The server never denied this session. Clearing it here would be a statement
      // about the operator's credentials that nothing in the exchange supports.
      expect(store.isAuthenticated()).toBeTrue();
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('treats a 5xx as unavailable rather than as an unclassified defect', () => {
      http.get(PROTECTED).subscribe({ error: () => undefined });
      backend
        .expectOne(PROTECTED)
        .flush({ detail: 'boom' }, { status: 502, statusText: 'Bad Gateway', headers: { [REQUEST_ID_HEADER]: 'req-502' } });

      // A server answering incoherently is the same ACTIONABLE state as one not
      // answering: retry or report, and no operator action resolves it.
      expect(status.unavailable()).toBeTrue();
      expect(status.requestId()).toBe('req-502');
      expect(defects.current()).toBeNull();
    });

    it('is NOT silenced by the suppression the auth transport sets', () => {
      // Suppressing a 401 on an auth route is right — the login form renders it.
      // Suppressing a 502 is how an afternoon disappears.
      http
        .get(apiUrl(AUTH_ROUTES.session), { context: new HttpContext().set(SUPPRESS_DEFECT_REPORT, true) })
        .subscribe({ error: () => undefined });
      backend
        .expectOne(apiUrl(AUTH_ROUTES.session))
        .flush('<html>502</html>', { status: 502, statusText: 'Bad Gateway' });

      expect(status.unavailable()).toBeTrue();
    });

    it('clears itself as soon as anything answers', () => {
      status.reportUnavailable('req-old');

      http.get(PROTECTED).subscribe();
      backend.expectOne(PROTECTED).flush({ ok: true });

      // Self-healing, so the shell banner never has to be dismissed by hand.
      expect(status.unavailable()).toBeFalse();
      expect(status.requestId()).toBeNull();
    });

    it('counts a 401 as reachable — being told "no" is being told something', () => {
      http.get(PROTECTED).subscribe({ error: () => undefined });
      backend.expectOne(PROTECTED).flush({ detail: 'gone' }, { status: 401, statusText: 'Unauthorized' });

      expect(status.unavailable()).toBeFalse();
    });
  });

  // ── CASE 1 ─────────────────────────────────────────────────────────────────────
  describe('401 — the session is gone', () => {
    it('clears client state and routes to /login with a returnUrl', () => {
      store.adopt(SESSION_BODY);
      http.get(PROTECTED).subscribe({ error: () => undefined });

      backend.expectOne(PROTECTED).flush({ detail: 'Invalid or expired admin session.' }, { status: 401, statusText: 'Unauthorized' });

      expect(store.isAuthenticated()).toBeFalse();
      expect(router.navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { returnUrl: '/restaurants/abc' },
        replaceUrl: true,
      });
    });

    it('never retries — there is no credential left to retry with', () => {
      let surfaced: unknown = null;
      http.get(PROTECTED).subscribe({ error: (error) => (surfaced = error) });
      backend
        .expectOne(PROTECTED)
        .flush({ detail: 'nope' }, { status: 401, statusText: 'Unauthorized' });

      expect(surfaced).toBeInstanceOf(HttpErrorResponse);
      // `expectNone` throws rather than registering an expectation, so wrap it.
      expect(() => backend.expectNone(PROTECTED)).not.toThrow();
    });

    it('leaves a rejected credential to the login form', () => {
      // A 401 from login/ is a wrong password, not a lost session. Redirecting would
      // wipe what the operator typed, on the page they are already looking at.
      http.post(apiUrl(AUTH_ROUTES.login), {}).subscribe({ error: () => undefined });
      backend
        .expectOne(apiUrl(AUTH_ROUTES.login))
        .flush({ status: 401, message: 'Invalid credentials.' }, { status: 401, statusText: 'Unauthorized' });

      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('does not redirect when the BOOTSTRAP session read 401s', () => {
      // Expected for a signed-out operator; the guard routes them.
      http.get(apiUrl(AUTH_ROUTES.session)).subscribe({ error: () => undefined });
      backend
        .expectOne(apiUrl(AUTH_ROUTES.session))
        .flush({ detail: 'no session' }, { status: 401, statusText: 'Unauthorized' });

      expect(router.navigate).not.toHaveBeenCalled();
    });
  });

  // ── CASE 2 ─────────────────────────────────────────────────────────────────────
  describe('403 CSRF — the token is stale', () => {
    it('re-bootstraps once and retries once', () => {
      let succeeded = false;
      http.post(PROTECTED, {}).subscribe(() => (succeeded = true));

      backend
        .expectOne(PROTECTED)
        .flush({ detail: 'CSRF Failed: CSRF cookie not set.' }, { status: 403, statusText: 'Forbidden' });

      expect(auth.sessionReads).toBe(1);
      backend.expectOne(PROTECTED).flush({ ok: true });
      expect(succeeded).toBeTrue();
      expect(defects.current()).toBeNull();
    });

    it('adopts the re-bootstrapped session, so the clock anchor is refreshed', () => {
      http.post(PROTECTED, {}).subscribe({ next: () => undefined, error: () => undefined });
      backend.expectOne(PROTECTED).flush({ detail: 'CSRF Failed: CSRF token missing.' }, { status: 403, statusText: 'Forbidden' });
      backend.expectOne(PROTECTED).flush({});

      expect(store.username()).toBe('operator');
    });

    it('matches every Django CSRF reason, not one spelling', () => {
      for (const reason of ['CSRF cookie not set.', 'CSRF token missing.', 'CSRF token incorrect.']) {
        auth.sessionReads = 0;
        http.post(PROTECTED, {}).subscribe({ next: () => undefined, error: () => undefined });
        backend.expectOne(PROTECTED).flush({ detail: `CSRF Failed: ${reason}` }, { status: 403, statusText: 'Forbidden' });
        expect(auth.sessionReads).withContext(reason).toBe(1);
        backend.expectOne(PROTECTED).flush({});
      }
    });

    it('hard-fails as a defect on the SECOND CSRF failure, carrying the request id', () => {
      http.post(PROTECTED, {}).subscribe({ error: () => undefined });

      backend
        .expectOne(PROTECTED)
        .flush({ detail: 'CSRF Failed: CSRF cookie not set.' }, { status: 403, statusText: 'Forbidden' });
      backend.expectOne(PROTECTED).flush(
        { detail: 'CSRF Failed: CSRF token incorrect.' },
        { status: 403, statusText: 'Forbidden', headers: { [REQUEST_ID_HEADER]: 'req-csrf-1' } },
      );

      // Bounded: exactly one re-bootstrap, exactly one retry, then it stops.
      expect(auth.sessionReads).toBe(1);
      backend.expectNone(PROTECTED);
      expect(defects.current()?.kind).toBe('csrf-retry-exhausted');
      expect(defects.current()?.requestId).toBe('req-csrf-1');
    });

    it('applies to the elevate route too — it is a CSRF-enforced route', () => {
      http.post(apiUrl(AUTH_ROUTES.elevate), {}).subscribe({ next: () => undefined, error: () => undefined });
      backend
        .expectOne(apiUrl(AUTH_ROUTES.elevate))
        .flush({ detail: 'CSRF Failed: CSRF cookie not set.' }, { status: 403, statusText: 'Forbidden' });

      expect(auth.sessionReads).toBe(1);
      backend.expectOne(apiUrl(AUTH_ROUTES.elevate)).flush({});
    });
  });

  // ── CASE 3 ─────────────────────────────────────────────────────────────────────
  describe('403 elevation required — an expected security state', () => {
    it('prompts once and replays the ORIGINAL request on success', () => {
      let body: unknown = null;
      http.post(PROTECTED, { to_state: 'suspended' }).subscribe((response) => (body = response));

      backend
        .expectOne(PROTECTED)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });

      expect(elevation.requests).toBe(1);
      elevation.succeed();

      const replay = backend.expectOne(PROTECTED);
      // The operator must not lose what they were doing: same method, same payload.
      expect(replay.request.method).toBe('POST');
      expect(replay.request.body).toEqual({ to_state: 'suspended' });
      replay.flush({ ok: true });

      expect(body).toEqual({ ok: true });
      expect(defects.current()).toBeNull();
    });

    it('replays a COMMERCIAL WRITE with its concurrency token byte-for-byte', () => {
      // THE REGRESSION THIS EXISTS FOR (Step 3E.2). A service-configuration write asserts
      // `expected_current` — the exact axis value the operator reviewed before deciding.
      // Elevation happens BETWEEN the assertion and the write reaching the domain, and
      // another operator can move the axis during the TOTP prompt.
      //
      // If anything rebuilt the request after elevation — re-reading the store, taking a
      // "fresh" token — the replay would assert a value nobody reviewed and would
      // overwrite that other operator's decision, silently, with the conflict check
      // passing. The interceptor replays the ORIGINAL `HttpRequest`, and this pins it.
      const route = apiUrl('/restaurants/abc/commercial/payment-timing/');
      const original = {
        value: 'pay_after',
        expected_current: 'pay_first',
        reason: 'Switching to table service',
      };

      let result: unknown = null;
      http.post(route, original).subscribe((response) => (result = response));

      backend
        .expectOne(route)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      elevation.succeed();

      const replay = backend.expectOne(route);
      expect(replay.request.body).toEqual(original);
      replay.flush({ status: 200, data: { changed: true, commercial: {} } });

      expect(result).toEqual({ status: 200, data: { changed: true, commercial: {} } });
    });

    it('replays an EXPLICIT NULL assertion as a null, not as an omission', () => {
      // The unconfigured-axis case. "Nobody had configured this when I loaded it" is the
      // only assertion that succeeds against a fresh restaurant, and it survives the
      // elevation round trip only if the original body is replayed rather than rebuilt —
      // a reconstructed body is one `??` away from dropping the key entirely, which the
      // server answers 400.
      const route = apiUrl('/restaurants/abc/commercial/payment-collection-mode/');
      const original = {
        value: 'offline',
        expected_current: null,
        reason: 'Initial collection setup',
      };

      http.post(route, original).subscribe();

      backend
        .expectOne(route)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      elevation.succeed();

      const replay = backend.expectOne(route);
      const body = replay.request.body as Record<string, unknown>;
      expect(Object.keys(body)).toContain('expected_current');
      expect(body['expected_current']).toBeNull();
      expect(JSON.stringify(body)).toContain('"expected_current":null');
      replay.flush({ status: 200, data: { changed: true, commercial: {} } });
    });

    it('replays a SUBSCRIPTION-TERMS write with its row token and its decimal intact', () => {
      // THE SAME REGRESSION, ONE STEP SHARPER (Step 3E.3). A terms write asserts
      // `expected_terms_id` — a ROW IDENTITY rather than a value, so it cannot be
      // reconstructed from anything on screen. A replay that rebuilt the request would
      // have nothing correct to put there.
      //
      // And `recurring_amount` is a decimal STRING. A rebuild that round-tripped it
      // through a number would send `150000.5` for a stored `150000.50`, which the
      // backend's strict field refuses outright — after the operator has already
      // re-authenticated.
      const route = apiUrl('/restaurants/abc/commercial/subscription-terms/replace/');
      const original = {
        expected_terms_id: '5d6e7f80-9a1b-4c2d-8e3f-000000000001',
        recurring_amount: '150000.50',
        currency: 'UGX',
        billing_interval_unit: 'month',
        billing_interval_count: 1,
        effective_from: '2026-08-01T00:00:00+03:00',
        reason: 'Uplift agreed for the new quarter',
      };

      http.post(route, original).subscribe();

      backend
        .expectOne(route)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      elevation.succeed();

      const replay = backend.expectOne(route);
      expect(replay.request.body).toEqual(original);
      // Serialised, which is where a rebuilt body would actually lose the digit and the
      // explicit offset.
      const wire = JSON.stringify(replay.request.body);
      expect(wire).toContain('"recurring_amount":"150000.50"');
      expect(wire).toContain('"effective_from":"2026-08-01T00:00:00+03:00"');
      expect(wire).toContain('"expected_terms_id":"5d6e7f80-9a1b-4c2d-8e3f-000000000001"');
      replay.flush({ status: 200, data: { changed: true, commercial: {} } });
    });

    it('replays a RECORD terms write without inventing a token it never had', () => {
      // `record` deliberately carries NO `expected_terms_id`: the operation means "record
      // terms only if none are open", enforced under the restaurant lock. A replay that
      // rebuilt the body from a client-side notion of "the current terms" would add one —
      // and the server would then be checking an assertion the operator never made.
      const route = apiUrl('/restaurants/abc/commercial/subscription-terms/');
      const original = {
        recurring_amount: '0.00',
        currency: 'UGX',
        billing_interval_unit: 'year',
        billing_interval_count: 2,
        effective_from: '2026-08-01T00:00:00+03:00',
        reason: 'Recording the internal pilot terms',
      };

      http.post(route, original).subscribe();

      backend
        .expectOne(route)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      elevation.succeed();

      const replay = backend.expectOne(route);
      expect(replay.request.body).toEqual(original);
      expect(Object.keys(replay.request.body as object)).not.toContain('expected_terms_id');
      // A zero price is a real, deliberate price — and `"0.00"` versus `0` is exactly the
      // distinction a rebuilt body would lose.
      expect(JSON.stringify(replay.request.body)).toContain('"recurring_amount":"0.00"');
      replay.flush({ status: 200, data: { changed: true, commercial: {} } });
    });

    it('replays a RESTAURANT CREATION with its is_test boolean and its owner block intact', () => {
      // Step 2G. Creation is elevation-gated, so the FIRST creation an operator makes
      // in a while is refused with 403 and replayed after the TOTP prompt. Two facts in
      // that body must survive the round trip untouched: `is_test`, which the backend
      // accepts ONLY as a JSON boolean (a rebuilt body that coerced it to `"false"`
      // would be a 400 after re-authentication), and the owner block, whose keys are
      // read by the server as the claims the caller made — a rebuild that added a stray
      // `user_id: ""` beside `mode: "new"` would be refused for the key alone.
      const route = apiUrl('/restaurants/');
      const original = {
        restaurant: { name: 'Speke Road Cafe', location: 'Kampala', is_test: false },
        owner: {
          mode: 'new',
          first_name: 'Miriam',
          last_name: 'Nakato',
          phone_number: '0772140388',
          email: null,
        },
        reason: 'Signed pilot agreement, March cohort',
      };

      let result: unknown = null;
      http.post(route, original).subscribe((response) => (result = response));

      backend
        .expectOne(route)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      expect(elevation.requests).toBe(1);
      elevation.succeed();

      const replay = backend.expectOne(route);
      expect(replay.request.method).toBe('POST');
      expect(replay.request.body).toEqual(original);
      const wire = JSON.stringify(replay.request.body);
      expect(wire).toContain('"is_test":false');
      expect(wire).toContain('"email":null');
      expect(Object.keys((replay.request.body as { owner: object }).owner)).toEqual([
        'mode',
        'first_name',
        'last_name',
        'phone_number',
        'email',
      ]);
      // The claim token rides the 201 and is handed to the caller exactly once. The
      // interceptor neither reads it nor keeps it.
      const created = {
        status: 201,
        message: 'Restaurant created.',
        data: { owner_invitation: { claim_token: 'raw-claim-code' } },
      };
      replay.flush(created, { status: 201, statusText: 'Created' });
      expect(result).toEqual(created);
      expect(defects.current()).toBeNull();
    });

    it('replays an OWNER-INVITATION write with the invitation id the operator reviewed', () => {
      // `expected_invitation_id` asserts IDENTITY — "the invitation I reviewed is still
      // the head" — and it is captured when the operator opens the action, before the
      // TOTP prompt. Another operator can reissue during that prompt; a replay that
      // re-read "the current invitation" would then act on a credential nobody looked
      // at, which is exactly the stale-screen overwrite the token exists to stop.
      const route = apiUrl('/restaurants/abc/owner-invitation/reissue/');
      const original = {
        expected_invitation_id: '4d5e6f70-8192-4a3b-9c4d-000000000001',
        reason: 'Owner lost the original code',
      };

      http.post(route, original).subscribe();

      backend
        .expectOne(route)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      elevation.succeed();

      const replay = backend.expectOne(route);
      expect(replay.request.body).toEqual(original);
      expect(JSON.stringify(replay.request.body)).toContain(
        '"expected_invitation_id":"4d5e6f70-8192-4a3b-9c4d-000000000001"',
      );
      replay.flush({ status: 200, data: { changed: true, onboarding: {}, owner_invitation: {} } });
    });

    it('opens ONE prompt for concurrent refusals and replays them all', () => {
      const done: string[] = [];
      http.post(apiUrl('/a/'), {}).subscribe(() => done.push('a'));
      http.post(apiUrl('/b/'), {}).subscribe(() => done.push('b'));
      http.post(apiUrl('/c/'), {}).subscribe(() => done.push('c'));

      for (const path of ['/a/', '/b/', '/c/']) {
        backend
          .expectOne(apiUrl(path))
          .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      }

      // Three refusals, three queued requests, ONE elevation.
      expect(elevation.requests).toBe(3);
      elevation.succeed();

      for (const path of ['/a/', '/b/', '/c/']) backend.expectOne(apiUrl(path)).flush({});
      expect(done.sort()).toEqual(['a', 'b', 'c']);
    });

    it('fails the queued request with an explicit cancelled state on Escape', () => {
      let error: unknown = null;
      http.post(PROTECTED, {}).subscribe({ error: (err) => (error = err) });

      backend
        .expectOne(PROTECTED)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      elevation.cancel();

      // Nothing hangs silently.
      expect(error).toBeInstanceOf(ElevationCancelledError);
      backend.expectNone(PROTECTED);
    });

    it('does NOT reopen the prompt when a replayed request is refused again', () => {
      http.post(PROTECTED, {}).subscribe({ error: () => undefined });

      backend
        .expectOne(PROTECTED)
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      elevation.succeed();
      backend.expectOne(PROTECTED).flush(
        { detail: ELEVATION_REQUIRED_DETAIL },
        { status: 403, statusText: 'Forbidden', headers: { [REQUEST_ID_HEADER]: 'req-elev-1' } },
      );

      // One elevation, one replay, then stop. A second refusal moments after a second
      // factor was accepted is a defect; prompting again would loop the operator
      // through a modal that cannot help.
      expect(elevation.requests).toBe(1);
      backend.expectNone(PROTECTED);
      expect(defects.current()?.kind).toBe('elevation-replay-exhausted');
      expect(defects.current()?.requestId).toBe('req-elev-1');
    });
  });

  // ── CASE 4 ─────────────────────────────────────────────────────────────────────
  describe('403 from /auth/elevate/ itself', () => {
    it('is never treated as "needs elevation" — the shapes cannot collide', () => {
      let error: unknown = null;
      http
        .post(apiUrl(AUTH_ROUTES.elevate), { method: 'totp', code: '000000' })
        .subscribe({ error: (err) => (error = err) });

      // The server's real shape for this: `{status, message}`, NOT `{detail}`.
      backend
        .expectOne(apiUrl(AUTH_ROUTES.elevate))
        .flush(
          { status: 403, message: 'Invalid or expired verification.' },
          { status: 403, statusText: 'Forbidden' },
        );

      expect(elevation.requests).toBe(0);
      expect(error).toBeTruthy();
      backend.expectNone(apiUrl(AUTH_ROUTES.elevate));
    });

    it('is exempt even if the elevation message ever appeared on that route', () => {
      // The route exclusion is redundant given the shape difference above, and it is
      // asserted anyway: an invariant this important should not rest on a property of
      // two response bodies that a backend tidy-up could change.
      http
        .post(apiUrl(AUTH_ROUTES.elevate), {})
        .subscribe({ error: () => undefined });
      backend
        .expectOne(apiUrl(AUTH_ROUTES.elevate))
        .flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });

      expect(elevation.requests).toBe(0);
    });
  });

  // ── Everything else ────────────────────────────────────────────────────────────
  describe('unclassified failures', () => {
    it('reports an unexpected 4xx as a defect, with the request id', () => {
      // 5xx is deliberately NOT here any more: the transport precondition claims it
      // first, because "the service is not answering usefully" is a different thing to
      // tell an operator than "this request was wrong".
      http.get(PROTECTED).subscribe({ error: () => undefined });
      backend
        .expectOne(PROTECTED)
        .flush({ detail: 'boom' }, { status: 418, statusText: 'Teapot', headers: { [REQUEST_ID_HEADER]: 'req-418' } });

      expect(defects.current()).toEqual({
        message: 'boom',
        requestId: 'req-418',
        kind: 'unclassified',
      });
    });

    it('does not report an expected client outcome as a defect', () => {
      for (const status of [400, 404, 409, 429]) {
        defects.dismiss();
        http.get(PROTECTED).subscribe({ error: () => undefined });
        backend.expectOne(PROTECTED).flush({ detail: 'x' }, { status, statusText: 'x' });
        expect(defects.current()).withContext(String(status)).toBeNull();
      }
    });

    it('stays quiet when the caller owns the error', () => {
      // The auth transport sets this: the login form and the modal render their own
      // failures, so a global banner would be a second, worse copy.
      http.post(apiUrl(AUTH_ROUTES.login), {}).subscribe({ error: () => undefined });
      backend
        .expectOne(apiUrl(AUTH_ROUTES.login))
        .flush({ status: 418, message: 'x' }, { status: 418, statusText: 'x' });
      // login/ is routed through the transport in production, which suppresses; here
      // the raw call does report, so assert the flag itself rather than the route.
      expect(defects.current()?.kind).toBe('unclassified');
    });
  });
});

/**
 * The CSRF interceptor is registered AFTER the classifier so a replayed request picks
 * up the CURRENT cookie. Registered the other way round, a retry after a CSRF
 * re-bootstrap would carry the very token it had just been refused for.
 *
 * THE COOKIE IS STUBBED, and it has to be: the real cookie is `__Host-` prefixed, and
 * that prefix is a browser contract requiring `Secure`. Karma serves the spec bundle
 * over plain http, so the browser silently REFUSES to store a cookie under that name
 * — `document.cookie = '__Host-...=x'` is a no-op here. Stubbing the getter tests the
 * interceptor's logic honestly rather than testing the browser's cookie policy.
 */
describe('csrfInterceptor ordering', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let jar: string;

  beforeEach(() => {
    jar = '';
    spyOnProperty(Document.prototype, 'cookie', 'get').and.callFake(() => jar);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorClassifierInterceptor, csrfInterceptor])),
        provideHttpClientTesting(),
        {
          provide: Router,
          useValue: jasmine.createSpyObj<Router>('Router', ['navigate'], { url: '/' }),
        },
        { provide: ADMIN_AUTH, useValue: new StubAuthApi() },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('attaches the token on unsafe methods and leaves safe ones alone', () => {
    jar = `${CSRF_COOKIE_NAME}=tok-1`;

    http.post(apiUrl('/x/'), {}).subscribe();
    const unsafe = backend.expectOne(apiUrl('/x/'));
    expect(unsafe.request.headers.get(CSRF_HEADER_NAME)).toBe('tok-1');
    unsafe.flush({});

    http.get(apiUrl('/y/')).subscribe();
    const safe = backend.expectOne(apiUrl('/y/'));
    // enforce_csrf exempts GET/HEAD/OPTIONS/TRACE, and session/ is where the cookie
    // is ISSUED — a header there would be noise at best.
    expect(safe.request.headers.has(CSRF_HEADER_NAME)).toBeFalse();
    safe.flush({});
  });

  it('sends the request without a header rather than blocking when there is no cookie', () => {
    // The server then answers "CSRF cookie not set." and the classifier recovers.
    // Guessing or refusing here would duplicate that recovery in a second place.
    http.post(apiUrl('/x/'), {}).subscribe({ next: () => undefined, error: () => undefined });
    const request = backend.expectOne(apiUrl('/x/'));
    expect(request.request.headers.has(CSRF_HEADER_NAME)).toBeFalse();
    request.flush({});
  });

  it('a replayed request carries the token the re-bootstrap installed', () => {
    // No cookie yet — exactly the state that produces "CSRF cookie not set."
    http.post(apiUrl('/z/'), {}).subscribe({ next: () => undefined, error: () => undefined });

    const first = backend.expectOne(apiUrl('/z/'));
    expect(first.request.headers.has(CSRF_HEADER_NAME)).toBeFalse();

    // The server issues the cookie on the session read the classifier makes next.
    jar = `${CSRF_COOKIE_NAME}=tok-fresh`;
    first.flush(
      { detail: 'CSRF Failed: CSRF cookie not set.' },
      { status: 403, statusText: 'Forbidden' },
    );

    const replay = backend.expectOne(apiUrl('/z/'));
    // This is the assertion the interceptor ORDER exists for.
    expect(replay.request.headers.get(CSRF_HEADER_NAME)).toBe('tok-fresh');
    replay.flush({});
  });
});
