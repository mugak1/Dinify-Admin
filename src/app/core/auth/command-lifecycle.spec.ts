/**
 * D10 — THE COMMAND LIFECYCLE, END TO END IN THE CLIENT.
 *
 * Every spec here runs the REAL interceptors (classifier, CSRF), the REAL auth,
 * elevation, boundary and continuity services, the REAL transports and the REAL
 * consumer screens (creation, Readiness, Overview) against a MODELLED ADMIN PLANE — the
 * `Plane` class below, kept inline and synthetic. It is not the backend. It models the
 * behaviour backend B1 (`platform_admin_app/command_owner.py`, merged 7845b1c) and the
 * Stage A measurements established, and nothing more:
 *
 *   - a request is authenticated by the session cookie it carried at SEND time (401);
 *   - an unsafe request naming an owner is refused, BEFORE CSRF, elevation and the
 *     handler, unless it names the session that authenticated it (400 / 409, with B1's
 *     exact bodies); a request naming none is the legacy contract and is not checked;
 *   - `session/` RE-EMITS the CSRF value the request carried (Django `get_token`), so a
 *     read answered late writes an OLDER token back into the jar;
 *   - `logout/`: an absent header is legacy; a malformed one is 400; a well-formed one
 *     with no live session is a quiet 200 that touches no cookie; a live different
 *     session is 409; the named one is revoked;
 *   - `verify/` mints an elevated session and rotates CSRF; `elevate/` evaluates the
 *     factor against the cookie's principal.
 *
 * `hold(req)` has the server ACT now and the answer delivered later; `hold(req, false)`
 * has the request still on its way (the server acts on release, with the cookies it was
 * sent with). Resume events are SYNTHETIC (`window.dispatchEvent`); they prove what the
 * application does when one arrives, not how a real browser fires them.
 *
 * Local Backend/browser evidence against the merged B1 lives outside this suite.
 */
import { HttpErrorResponse, HttpInterceptorFn, HttpRequest, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { fakeAsync, flush, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { MockAdminAuthApi } from '../../dev/mock-admin-auth';
import {
  apiUrl,
  AUTH_ROUTES,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  ELEVATION_REQUIRED_DETAIL,
  RESTAURANT_ROUTES,
} from '../api/api.constants';
import { csrfInterceptor } from '../api/csrf.interceptor';
import { errorClassifierInterceptor } from '../api/error.interceptor';
import { AdminServiceStatus } from '../api/service-status';
import { NoticeService } from '../notices/notice.service';
import { RESTAURANT_API, RestaurantApi } from '../restaurants/restaurant.api';
import { RestaurantHttp } from '../restaurants/restaurant.http';
import { RestaurantWorkspaceStore } from '../restaurants/restaurant-workspace.store';
import { RestaurantCreatePage } from '../../features/restaurant-create.page';
import { RestaurantDetailPage } from '../../features/restaurant-detail.page';
import { RestaurantReadinessTab } from '../../features/restaurant-readiness.tab';
import { RestaurantOverviewTab } from '../../features/restaurant-tabs.pages';
import { ADMIN_AUTH } from './admin-auth.api';
import { AdminAuthHttp } from './admin-auth.http';
import { AdminAuthService, PostVerifyCorrelationError } from './admin-auth.service';
import {
  CommandNotRunError,
  CommandOutcomeUnknownError,
  CommandResultWithheldError,
  readCommandOwner,
  readOwnerRefusal,
} from './command-owner';
import { ElevationCancelledError, ElevationService } from './elevation.service';
import { DOCUMENT_REPLACE } from './session-boundary.service';
import { SessionContinuityService } from './session-continuity.service';
import { SessionStore } from './session.store';

// ── THE MODELLED PLANE (synthetic; see the header) ──────────────────────────────────

interface Principal {
  readonly id: string;
  readonly username: string;
  readonly code: string;
  readonly recovery: string[];
}
const alice = (): Principal => ({
  id: 'aaaaaaaa-0000-4000-8000-00000000000a',
  username: 'alice.synthetic',
  code: '111111',
  recovery: ['alice-rc-1', 'alice-rc-2'],
});
const bob = (): Principal => ({
  id: 'bbbbbbbb-0000-4000-8000-00000000000b',
  username: 'bob.synthetic',
  code: '222222',
  recovery: ['bob-rc-1'],
});

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CREATED_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const HEAD_ID = '4d5e6f70-8192-4a3b-9c4d-000000000001';
const NEW_HEAD_ID = '4d5e6f70-8192-4a3b-9c4d-000000000002';
/** Synthetic, shaped like `token_urlsafe(48)`. Not a real credential. */
const TOKEN = 'SPECsyntheticCLAIMcode000000000000000000000000000000000000000000z';
const REASON = 'Synthetic reason, long enough to pass';
const OWNER_HEADER = 'X-Admin-Command-Owner';

/** B1's exact refusal bodies. */
const REFUSED = {
  malformed: {
    detail: 'The command-owner precondition could not be read. The command was not run.',
    code: 'admin_command_owner_malformed',
  },
  actor: {
    detail: 'This browser is now signed in as a different administrator. The command was not run.',
    code: 'admin_command_actor_changed',
  },
  session: {
    detail:
      'This browser has started a new admin session since the command was issued. The command was not run.',
    code: 'admin_command_session_changed',
  },
} as const;

interface ServerSession {
  readonly id: string;
  readonly principal: Principal;
  elevated: boolean;
  revoked: boolean;
}
interface Executed {
  readonly url: string;
  readonly body: unknown;
  readonly principal: string;
  readonly session: string;
}
interface Prepared {
  readonly body: unknown;
  readonly status: number;
  readonly csrfEcho?: string | null;
}

let sessionCounter = 0;
const newSessionId = () => `00000000-0000-4000-8000-${String(++sessionCounter).padStart(12, '0')}`;

class Plane {
  /** false models a server that predates B1: it publishes no owner and checks none. */
  binding = true;
  readonly sessions = new Map<string, ServerSession>();
  readonly executed: Executed[] = [];
  readonly factors: string[] = [];
  /** Every non-GET request as sent: path and the owner header it carried. */
  readonly unsafe: { url: string; owner: string | null; body: unknown }[] = [];
  sessionReads = 0;
  detailReads = 0;
  netSession: string | null = null;
  netCsrf: string | null = null;
  jsCsrf: string | null = null;
  headId = HEAD_ID;
  headStatus: 'pending' | 'cancelled' = 'pending';
  /** The next handler answer, if a spec needs one other than success. */
  nextWrite: Prepared | null = null;
  private challenge: Principal | null = null;
  private readonly principals = [alice(), bob()];
  private readonly prepared = new Map<TestRequest, Prepared>();

  principal(username: string): Principal {
    return this.principals.find((p) => p.username === username)!;
  }

  /** A sign-in in ANOTHER TAB of this browser: mint an elevated session, rotate CSRF. */
  signIn(username: string, opts: { elevated?: boolean } = {}): string {
    const id = newSessionId();
    this.sessions.set(id, { id, principal: this.principal(username), elevated: opts.elevated ?? true, revoked: false });
    this.netSession = id;
    this.netCsrf = `csrf-${id.slice(-4)}`;
    this.jsCsrf = this.netCsrf;
    return id;
  }

  /** A sign-out in another tab: the session is revoked and its cookie cleared. */
  signOutElsewhere(): void {
    const live = this.netSession ? this.sessions.get(this.netSession) : undefined;
    if (live) live.revoked = true;
    this.netSession = null;
  }

  answer(req: TestRequest): void {
    this.deliver(req, this.process(req));
  }
  hold(req: TestRequest, processNow = true): void {
    if (processNow) this.prepared.set(req, this.process(req));
  }
  release(req: TestRequest): void {
    this.deliver(req, this.prepared.get(req) ?? this.process(req));
  }

  private deliver(req: TestRequest, p: Prepared): void {
    if (p.csrfEcho !== undefined) {
      // The browser applies the response's Set-Cookie when it RECEIVES it.
      this.netCsrf = p.csrfEcho;
      this.jsCsrf = p.csrfEcho;
    }
    req.flush(p.body as object, { status: p.status, statusText: String(p.status) });
  }

  private process(req: TestRequest): Prepared {
    const r = req.request;
    const url = r.urlWithParams;
    const method = r.method.toUpperCase();
    const sid = r.headers.get('X-Spec-Session') || null;
    const cookieCsrf = r.headers.get('X-Spec-Cookie-Csrf') || null;
    const unsafe = method !== 'GET';
    const ok = (body: unknown, status = 200): Prepared => ({ body, status });
    const fail = (status: number, body: unknown): Prepared => ({ body, status });
    if (unsafe) this.unsafe.push({ url, owner: r.headers.get(OWNER_HEADER), body: r.body });

    if (url === apiUrl(AUTH_ROUTES.login)) {
      this.challenge = this.principal((r.body as { username: string }).username) ?? null;
      return ok({ status: 200, message: 'ok', data: { second_factor_required: true, recovery_code_required: false } });
    }
    if (url === apiUrl(AUTH_ROUTES.verify)) {
      const c = this.challenge;
      const code = (r.body as { code: string }).code;
      if (!c || code !== c.code) return fail(401, { status: 401, message: 'Invalid or expired verification.' });
      const id = this.signIn(c.username);
      return ok({
        status: 200,
        message: 'Signed in.',
        data: {
          username: c.username,
          expires_at: '2026-09-27T20:00:00+00:00',
          used_recovery_code: false,
          lockout_cleared: false,
          recovery_codes_remaining: 9,
          ...(this.binding ? { command_owner: { version: 1, actor: c.id, session: id } } : {}),
        },
      });
    }

    const session = sid ? this.sessions.get(sid) : undefined;
    const live = session && !session.revoked ? session : undefined;

    if (url === apiUrl(AUTH_ROUTES.logout)) {
      const raw = this.binding ? r.headers.get(OWNER_HEADER) : null;
      if (raw !== null) {
        const named = parseOwner(raw);
        if (!named) return fail(400, REFUSED.malformed);
        // Well-formed, and no live session: nothing to end, and no cookie is touched.
        if (!live) return ok({ status: 200, message: 'Signed out.' });
        const refusal = refusalFor(named, live);
        if (refusal) return fail(409, refusal);
      }
      if (live) live.revoked = true;
      if (this.netSession === sid) this.netSession = null;
      return ok({ status: 200, message: 'Signed out.' });
    }

    if (!live) return fail(401, { detail: 'Invalid or expired admin session.' });

    if (unsafe && this.binding) {
      const raw = r.headers.get(OWNER_HEADER);
      if (raw !== null) {
        const named = parseOwner(raw);
        if (!named) return fail(400, REFUSED.malformed);
        const refusal = refusalFor(named, live);
        if (refusal) return fail(409, refusal);
      }
    }
    if (unsafe && (!cookieCsrf || r.headers.get(CSRF_HEADER_NAME) !== cookieCsrf)) {
      return fail(403, { detail: 'CSRF Failed: CSRF token incorrect.' });
    }

    if (url === apiUrl(AUTH_ROUTES.session)) {
      this.sessionReads += 1;
      return {
        ...ok({
          status: 200,
          message: 'ok',
          data: {
            username: live.principal.username,
            email: `${live.principal.username}@example.invalid`,
            issued_at: '2026-09-27T08:00:00+00:00',
            expires_at: '2026-09-27T20:00:00+00:00',
            elevated_at: live.elevated ? '2026-09-27T09:59:00+00:00' : null,
            server_time: '2026-09-27T10:00:00+00:00',
            ...(this.binding ? { command_owner: { version: 1, actor: live.principal.id, session: live.id } } : {}),
          },
        }),
        csrfEcho: cookieCsrf ?? `csrf-${live.id.slice(-4)}-ensured`,
      };
    }
    if (url === apiUrl(AUTH_ROUTES.elevate)) {
      const p = live.principal;
      const code = (r.body as { code: string }).code;
      if (code !== p.code) {
        this.factors.push(`${p.username}: refused`);
        return fail(403, { status: 403, message: 'Invalid or expired verification.' });
      }
      live.elevated = true;
      this.factors.push(`${p.username}: accepted`);
      return ok({ status: 200, message: 'Elevated.', data: { elevated_at: '2026-09-27T10:00:01+00:00', used_recovery_code: false, recovery_codes_remaining: 9 } });
    }
    if (!unsafe) {
      if (url === apiUrl(RESTAURANT_ROUTES.detail(ID))) {
        this.detailReads += 1;
        return ok({ status: 200, data: this.detail(ID) });
      }
      return fail(404, { status: 404 });
    }

    if (!live.elevated) return fail(403, { detail: ELEVATION_REQUIRED_DETAIL });
    if (this.nextWrite) {
      const next = this.nextWrite;
      this.nextWrite = null;
      return next;
    }
    this.executed.push({ url, body: r.body, principal: live.principal.username, session: live.id });
    if (url.endsWith('/owner-invitation/reissue/')) {
      this.headId = NEW_HEAD_ID;
      return ok({
        status: 200,
        data: {
          changed: true,
          onboarding: onboarding(NEW_HEAD_ID, 'pending'),
          owner_invitation: { id: NEW_HEAD_ID, issued_at: '2026-09-27T10:00:00+03:00', expires_at: '2026-10-04T10:00:00+03:00', claim_token: TOKEN },
        },
      });
    }
    if (url.endsWith('/owner-invitation/cancel/')) {
      this.headStatus = 'cancelled';
      return ok({ status: 200, data: { changed: true, onboarding: onboarding(this.headId, 'cancelled') } });
    }
    if (url === apiUrl(RESTAURANT_ROUTES.create)) {
      return ok(
        {
          status: 201,
          message: 'Restaurant created.',
          data: {
            restaurant: this.detail(CREATED_ID),
            owner_account: { id: '00000000-0000-4000-8000-000000000009', created: true },
            owner_invitation: { id: HEAD_ID, issued_at: '2026-09-27T10:00:00+03:00', expires_at: '2026-10-04T10:00:00+03:00', claim_token: TOKEN },
          },
        },
        201,
      );
    }
    return ok({ status: 200, data: { changed: true, commercial: commercial('pay_after') } });
  }

  private detail(id: string) {
    return {
      id,
      name: 'Synthetic Kitchen',
      location: 'Nowhere',
      status: 'onboarding',
      is_test: true,
      readiness: { state: 'not_ready', blocker_count: 1, blockers: ['readiness_not_configured'] },
      commercial: commercial('pay_first'),
      payment_mode: null,
      payment_mode_configured: false,
      subscription: { source: 'legacy_restaurant_fields', has_commercial_subscription: false, legacy_validity_flag: true, legacy_expiry_at: null, preferred_method: null },
      last_activity_at: null,
      needs_attention: true,
      allowed_transitions: ['offboarded'],
      created_at: '2026-09-20T08:00:00+03:00',
      owner: { id: '00000000-0000-4000-8000-000000000009', name: 'Synthetic Owner', email: 'owner@example.invalid', phone_number: '256700000000', is_active: true, claim_tracked: true, claim_status: 'not_established' },
      onboarding: onboarding(this.headId, this.headStatus),
      support: { open_issue_count: 0 },
      operations: { table_count: 0, usable_table_count: 0, dining_area_count: 0, latest_order: null },
      recent_activity: [],
    };
  }
}

function parseOwner(raw: string): { actor: string; session: string } | null {
  const m = /^1;([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12});([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(raw);
  return m ? { actor: m[1], session: m[2] } : null;
}
function refusalFor(named: { actor: string; session: string }, live: ServerSession) {
  if (named.actor !== live.principal.id) return REFUSED.actor;
  if (named.session !== live.id) return REFUSED.session;
  return null;
}
function commercial(timing: 'pay_first' | 'pay_after') {
  return {
    payment_timing: { configured: true, value: timing, set_at: '2026-09-27T10:00:00+03:00' },
    payment_collection_mode: { configured: false, value: null, set_at: null },
    subscription_terms: { configured: false, current: null },
  };
}
function onboarding(id: string, status: 'pending' | 'cancelled') {
  return {
    tracked: true,
    source: 'admin_created',
    recorded_at: '2026-09-20T09:00:00+03:00',
    owner_relationship: { status: 'consistent' },
    owner_control: { status: 'not_established', evidence: null, evidence_at: null },
    invitation: { status, id, issued_at: '2026-09-20T10:00:00+03:00', expires_at: '2026-10-27T10:00:00+03:00' },
  };
}

/** The browser attaching the cookie jar at SEND time. Last in the chain. */
function cookieJar(plane: () => Plane): HttpInterceptorFn {
  return (req: HttpRequest<unknown>, next) =>
    next(req.clone({ setHeaders: { 'X-Spec-Session': plane().netSession ?? '', 'X-Spec-Cookie-Csrf': plane().netCsrf ?? '' } }));
}

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class Blank {}

type Disposition = 'answer' | 'hold' | 'defer';

// ── THE SUITE ───────────────────────────────────────────────────────────────────────

describe('D10 command lifecycle — real client over a MODELLED plane', () => {
  let plane: Plane;
  let http: HttpTestingController;
  let auth: AdminAuthService;
  let store: SessionStore;
  let elevation: ElevationService;
  let notices: NoticeService;
  let status: AdminServiceStatus;
  let rest: RestaurantApi;
  let router: Router;
  let continuity: SessionContinuityService;
  let replaced: string[];
  let stopResume: () => void;

  beforeEach(() => {
    plane = new Plane();
    replaced = [];
    spyOnProperty(Document.prototype, 'cookie', 'get').and.callFake(() =>
      plane.jsCsrf ? `${CSRF_COOKIE_NAME}=${plane.jsCsrf}` : '',
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'login', component: Blank },
            { path: 'restaurants/new', component: RestaurantCreatePage },
            {
              path: 'restaurants/:id',
              component: RestaurantDetailPage,
              providers: [RestaurantWorkspaceStore],
              children: [
                { path: '', component: RestaurantOverviewTab },
                { path: 'readiness', component: RestaurantReadinessTab },
              ],
            },
            { path: '**', component: Blank },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([errorClassifierInterceptor, csrfInterceptor, cookieJar(() => plane)])),
        provideHttpClientTesting(),
        { provide: ADMIN_AUTH, useClass: AdminAuthHttp },
        { provide: RESTAURANT_API, useClass: RestaurantHttp },
        // A boundary replaces the document; recorded here, never performed.
        { provide: DOCUMENT_REPLACE, useValue: (url: string) => replaced.push(url) },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AdminAuthService);
    store = TestBed.inject(SessionStore);
    elevation = TestBed.inject(ElevationService);
    notices = TestBed.inject(NoticeService);
    status = TestBed.inject(AdminServiceStatus);
    rest = TestBed.inject(RESTAURANT_API);
    router = TestBed.inject(Router);
    continuity = TestBed.inject(SessionContinuityService);
    stopResume = continuity.start(); // what ShellComponent does
  });

  afterEach(() => stopResume());

  /** Run the network until quiet; `decide` may hold some requests. */
  function drain(decide: (r: TestRequest) => Disposition = () => 'answer'): TestRequest[] {
    const held: TestRequest[] = [];
    for (let round = 0; round < 50; round += 1) {
      tick();
      const open = http.match(() => true).filter((r) => !held.includes(r));
      if (open.length === 0) break;
      for (const r of open) {
        const d = decide(r);
        if (d === 'answer') plane.answer(r);
        else {
          plane.hold(r, d === 'hold');
          held.push(r);
        }
      }
    }
    tick();
    return held;
  }
  function once(match: (r: TestRequest) => boolean, d: Disposition) {
    let used = false;
    return (r: TestRequest): Disposition => {
      if (!used && match(r)) {
        used = true;
        return d;
      }
      return 'answer';
    };
  }
  const isRoute = (route: string) => (r: TestRequest) => r.request.url === apiUrl(route);
  const isWrite = (r: TestRequest) =>
    r.request.method === 'POST' && (r.request.url.includes('/commercial/') || r.request.url.includes('/owner-invitation/') || r.request.url === apiUrl(RESTAURANT_ROUTES.create));
  const isDetailRead = (r: TestRequest) => r.request.method === 'GET' && r.request.url.endsWith(`/restaurants/${ID}/`);
  const ownerOf = (username: string, session: string) => `1;${plane.principal(username).id};${session}`;
  const writes = () => plane.unsafe.filter((u) => u.url.includes('/commercial/') || u.url.includes('/owner-invitation/') || u.url === apiUrl(RESTAURANT_ROUTES.create));

  function bootstrapAs(username: string, elevated: boolean): string {
    const id = plane.signIn(username, { elevated });
    void auth.bootstrap();
    drain();
    expect(store.username()).toBe(username);
    return id;
  }
  function signInHere(username: string): void {
    void auth.login(username, 'synthetic-password');
    drain();
    void auth.verify('totp', plane.principal(username).code).catch(() => undefined);
    drain();
  }
  interface Outcome {
    next: number;
    error: unknown;
  }
  function issueWrite(value: 'pay_first' | 'pay_after' = 'pay_after', expected: 'pay_first' | null = 'pay_first'): Outcome {
    const o: Outcome = { next: 0, error: null };
    rest.setPaymentTiming(ID, { value, expected_current: expected, reason: REASON }).subscribe({
      next: () => (o.next += 1),
      error: (e: unknown) => (o.error = e),
    });
    return o;
  }
  const notRun = (e: unknown) => e as CommandNotRunError;

  // ── ORDINARY OPERATION ─────────────────────────────────────────────────────────────

  describe('an unchanged owner', () => {
    it('one prompt, one factor, one replay — the SAME owner, method, URL and body on every send', fakeAsync(() => {
      const s1 = bootstrapAs('alice.synthetic', false);
      const write = issueWrite('pay_after', null);
      drain();
      elevation.submit('111111');
      drain();

      expect(write.next).toBe(1);
      expect(plane.executed.map((e) => [e.principal, e.session])).toEqual([['alice.synthetic', s1]]);
      const sent = plane.unsafe;
      expect(sent.map((u) => u.owner)).toEqual([ownerOf('alice.synthetic', s1), ownerOf('alice.synthetic', s1), ownerOf('alice.synthetic', s1)]);
      const [first, , replay] = sent;
      expect(replay.url).toBe(first.url);
      expect(JSON.stringify(replay.body)).toBe(JSON.stringify(first.body));
      expect(JSON.stringify(replay.body)).toContain('"expected_current":null');
      expect(replaced).toEqual([]);
    }));

    it('same session, renewed CSRF: one read proves continuity, one retry, executed once', fakeAsync(() => {
      const s1 = bootstrapAs('alice.synthetic', true);
      const reads = plane.sessionReads;
      plane.netCsrf = null;
      plane.jsCsrf = null;
      const write = issueWrite();
      drain();

      expect(plane.sessionReads).toBe(reads + 1);
      expect(write.next).toBe(1);
      expect(plane.executed.length).toBe(1);
      expect(writes().map((u) => u.owner)).toEqual([ownerOf('alice.synthetic', s1), ownerOf('alice.synthetic', s1)]);
    }));

    it('bounds the two recoveries TOGETHER: one CSRF retry, one elevation replay, one owner', fakeAsync(() => {
      const s1 = bootstrapAs('alice.synthetic', false);
      const reads = plane.sessionReads;
      plane.netCsrf = null;
      plane.jsCsrf = null;
      const write = issueWrite();
      drain();
      elevation.submit('111111');
      drain();

      expect(write.next).toBe(1);
      expect(plane.sessionReads).toBe(reads + 1);
      expect(plane.executed.length).toBe(1);
      // The write, its CSRF retry, the elevation, and the one replay.
      expect(plane.unsafe.map((u) => u.owner)).toEqual(Array(4).fill(ownerOf('alice.synthetic', s1)));
    }));

    it('CONTROL — a cancelled prompt runs nothing, and says so as a cancellation', fakeAsync(() => {
      bootstrapAs('alice.synthetic', false);
      const write = issueWrite();
      drain();
      elevation.cancel();
      drain();
      expect(write.error).toEqual(jasmine.any(ElevationCancelledError));
      expect(plane.executed).toEqual([]);
    }));

    it('CONTROL — an ordinary 409 is an ordinary conflict: no boundary, still signed in', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      plane.nextWrite = { status: 409, body: { status: 409, message: 'The value changed.', code: 'stale_service_configuration' } };
      const write = issueWrite();
      drain();
      expect(write.error).toBeInstanceOf(HttpErrorResponse);
      expect((write.error as HttpErrorResponse).status).toBe(409);
      expect(replaced).toEqual([]);
      expect(store.isAuthenticated()).toBeTrue();
    }));
  });

  // ── THE DEFECT: A COMMAND REPLAYED UNDER A NEWLY ADOPTED PRINCIPAL ──────────────────

  // ── THE CSRF RECOVERY READ ITSELF FAILS (Codex review of #37) ──────────────────────
  describe('a CSRF refusal whose recovery read fails', () => {
    function csrfRefusedWrite(): { write: Outcome; read: TestRequest } {
      bootstrapAs('alice.synthetic', true);
      plane.netCsrf = null;
      plane.jsCsrf = null;
      const write = issueWrite();
      const [read] = drain(once(isRoute(AUTH_ROUTES.session), 'defer'));
      expect(writes().length).withContext('refused by CSRF, and not yet retried').toBe(1);
      return { write, read };
    }

    it('no usable answer: the command is NOT RUN, the outage is reported, nothing is re-sent', fakeAsync(() => {
      const { write, read } = csrfRefusedWrite();
      read.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
      drain();

      expect(write.error).toEqual(jasmine.any(CommandNotRunError));
      expect(notRun(write.error).reason).toBe('continuity-unconfirmed');
      expect(notRun(write.error).sent).toBeTrue();
      expect(status.unavailable()).withContext("the read's own outage report stands").toBeTrue();
      expect(store.username()).toBe('alice.synthetic');
      expect(writes().length).toBe(1);
      expect(plane.executed).toEqual([]);
      expect(replaced).toEqual([]);
    }));

    it('refused 401: the session ended, the command is NOT RUN, and sign-in follows', fakeAsync(() => {
      const { write, read } = csrfRefusedWrite();
      plane.signOutElsewhere();
      plane.release(read);
      drain();

      expect(notRun(write.error).reason).toBe('session-ended');
      expect(notRun(write.error).sent).toBeTrue();
      expect(store.isAuthenticated()).toBeFalse();
      expect(router.url).toContain('/login');
      expect(writes().length).toBe(1);
      expect(plane.executed).toEqual([]);
    }));
  });

  describe('a different principal', () => {
    it('the delayed CSRF echo no longer carries Alice’s write as Bob — refused, nothing runs, one boundary', fakeAsync(() => {
      const sA = bootstrapAs('alice.synthetic', true);
      void auth.bootstrap();
      const [held] = drain(once(isRoute(AUTH_ROUTES.session), 'hold'));
      plane.signIn('bob.synthetic'); // another tab
      plane.release(held); // the late read puts Alice's CSRF value back beside Bob's cookie
      drain();
      expect(store.username()).toBe('alice.synthetic');

      const write = issueWrite();
      drain();

      expect(writes().map((u) => u.owner)).toEqual([ownerOf('alice.synthetic', sA)]);
      expect(plane.executed).toEqual([]);
      expect(notRun(write.error).reason).toBe('actor-changed');
      expect(notRun(write.error).sent).toBeTrue();
      expect(replaced).toEqual(['/login?session=changed']);
      expect(store.isAuthenticated()).toBeFalse();
    }));

    it('a NEW SESSION of the same administrator is refused too — never renewed like a CSRF token', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      plane.signOutElsewhere();
      plane.signIn('alice.synthetic');
      const write = issueWrite();
      drain();

      expect(plane.executed).toEqual([]);
      expect(notRun(write.error).reason).toBe('session-changed');
      expect(replaced).toEqual(['/login?session=renewed']);
    }));

    it('a prompt opened under s1 is refused before the factor is looked at under s2', fakeAsync(() => {
      bootstrapAs('alice.synthetic', false);
      const write = issueWrite();
      drain();
      plane.signOutElsewhere();
      plane.signIn('alice.synthetic', { elevated: false });
      elevation.submit('111111');
      drain();

      expect(plane.factors).withContext('no factor evaluated, none consumed').toEqual([]);
      expect(plane.executed).toEqual([]);
      expect(write.error).toEqual(jasmine.any(CommandNotRunError));
      expect(replaced).toEqual(['/login?session=renewed']);
      expect(elevation.isOpen()).toBeFalse();
    }));

    it('a CSRF recovery read naming someone else is not adopted and nothing is retried', fakeAsync(() => {
      const sA = bootstrapAs('alice.synthetic', true);
      plane.netCsrf = null;
      plane.jsCsrf = null;
      const write = issueWrite();
      const [held403] = drain(once(isWrite, 'hold'));
      plane.signIn('bob.synthetic');
      plane.release(held403);
      drain();

      expect(writes().map((u) => u.owner)).withContext('exactly one send: no retry').toEqual([ownerOf('alice.synthetic', sA)]);
      expect(plane.executed).toEqual([]);
      expect(notRun(write.error).reason).toBe('actor-changed');
      expect(replaced).toEqual(['/login?session=changed']);
    }));

    it('the post-verify read naming another owner is not adopted, publishes nothing, and is not retried', fakeAsync(() => {
      void auth.login('bob.synthetic', 'synthetic-password');
      drain();
      let failure: unknown = null;
      void auth.verify('totp', '222222').catch((e: unknown) => (failure = e));
      const [heldVerify] = drain(once(isRoute(AUTH_ROUTES.verify), 'hold'));
      plane.release(heldVerify);
      plane.signIn('alice.synthetic'); // another tab, before the read goes out
      const reads = plane.sessionReads;
      drain();

      expect(failure).toEqual(jasmine.any(PostVerifyCorrelationError));
      expect(store.isAuthenticated()).toBeFalse();
      expect(notices.notice()).toBeNull();
      expect(plane.sessionReads - reads).withContext('correlation is not retried').toBe(1);
    }));
  });

  // ── LIFECYCLE: SIGN-OUT, LATE ANSWERS, ELEVATION ATTEMPTS ───────────────────────────

  describe('the lifecycle', () => {
    it('sign-out ends it AT INTENT: the queued write is not run, and the old elevate/ success settles nothing under Bob', fakeAsync(() => {
      const sA = bootstrapAs('alice.synthetic', false);
      const write = issueWrite();
      drain();
      elevation.submit('111111');
      const [heldElevate] = drain(once(isRoute(AUTH_ROUTES.elevate), 'hold'));

      void auth.signOut();
      tick();
      expect(notRun(write.error).reason).withContext('drained before any answer').toBe('session-ended');
      expect(elevation.isOpen()).toBeFalse();
      drain();
      expect(plane.unsafe.find((u) => u.url === apiUrl(AUTH_ROUTES.logout))?.owner).toBe(ownerOf('alice.synthetic', sA));

      signInHere('bob.synthetic');
      const bobElevatedAt = store.session()?.elevated_at;
      plane.release(heldElevate);
      drain();

      expect(plane.executed).toEqual([]);
      expect(store.username()).toBe('bob.synthetic');
      expect(store.session()?.elevated_at).toBe(bobElevatedAt);
      expect(notices.notice()).withContext('Alice’s recovery facts never reach Bob').toBeNull();
      expect(replaced).toEqual([]);
    }));

    it('an old elevate/ 401 after the new sign-in does NOT sign Bob out', fakeAsync(() => {
      bootstrapAs('alice.synthetic', false);
      issueWrite();
      drain();
      elevation.submit('111111');
      const [deferred] = drain(once(isRoute(AUTH_ROUTES.elevate), 'defer'));
      void auth.signOut();
      drain();
      signInHere('bob.synthetic');
      void router.navigateByUrl('/home');
      tick();

      plane.release(deferred); // processed now, with Alice's revoked cookie: 401
      drain();
      expect(store.username()).toBe('bob.synthetic');
      expect(router.url).toBe('/home');
      expect(plane.executed).toEqual([]);
    }));

    it('an old failure after the new sign-in raises no outage for Bob', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      let failed: unknown = null;
      rest.detail(ID).subscribe({ error: (e: unknown) => (failed = e) });
      const [held] = drain(once(isDetailRead, 'hold'));
      void auth.signOut();
      drain();
      signInHere('bob.synthetic');
      held.flush('<html>502</html>', { status: 502, statusText: 'Bad Gateway' });
      drain();

      expect(failed).withContext('nothing crosses into the successor').toBeNull();
      expect(status.unavailable()).toBeFalse();
      expect(store.username()).toBe('bob.synthetic');
    }));

    it('an old read’s 401 does not clear or navigate the later session', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      rest.detail(ID).subscribe({ error: () => undefined });
      const [deferred] = drain(once(isDetailRead, 'defer'));
      void auth.signOut();
      drain();
      signInHere('bob.synthetic');
      void router.navigateByUrl('/home');
      tick();

      plane.release(deferred);
      drain();
      expect(store.username()).toBe('bob.synthetic');
      expect(router.url).toBe('/home');
    }));

    it('a late BOOTSTRAP read after sign-out and a new sign-in adopts nothing', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      void auth.bootstrap();
      const [held] = drain(once(isRoute(AUTH_ROUTES.session), 'hold'));
      void auth.signOut();
      drain();
      signInHere('bob.synthetic');
      plane.release(held);
      drain();

      expect(store.username()).toBe('bob.synthetic');
      expect(replaced).toEqual([]);
    }));

    it('a CSRF recovery read that lands after sign-out adopts nothing and sends nothing', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      plane.netCsrf = null;
      plane.jsCsrf = null;
      const write = issueWrite();
      const [heldRead] = drain((r) => (isRoute(AUTH_ROUTES.session)(r) ? 'hold' : 'answer'));
      void auth.signOut();
      drain();
      plane.release(heldRead);
      drain();

      expect(store.isAuthenticated()).toBeFalse();
      expect(plane.executed).toEqual([]);
      expect(notRun(write.error).reason).toBe('session-ended');
      expect(writes().length).withContext('the write, once').toBe(1);
    }));

    it('Cancel, then a NEW prompt: the OLD elevate/ success does not settle it; the second write runs after ITS factor', fakeAsync(() => {
      bootstrapAs('alice.synthetic', false);
      const first = issueWrite('pay_after');
      drain();
      elevation.submit('111111');
      const [deferred] = drain(once(isRoute(AUTH_ROUTES.elevate), 'defer'));
      elevation.cancel();
      tick();
      const second = issueWrite('pay_first');
      drain();
      expect(elevation.isOpen()).toBeTrue();

      plane.release(deferred);
      drain();
      expect(elevation.isOpen()).withContext('the new prompt is untouched').toBeTrue();
      expect(second.next).toBe(0);
      expect(first.error).toEqual(jasmine.any(ElevationCancelledError));

      elevation.submit('111111');
      drain();
      expect(second.next).toBe(1);
      expect(plane.executed.map((e) => (e.body as { value: string }).value)).toEqual(['pay_first']);
    }));

    it('Cancel, then a NEW prompt: the OLD refusal does not appear in it', fakeAsync(() => {
      bootstrapAs('alice.synthetic', false);
      issueWrite();
      drain();
      elevation.submit('999999');
      const [deferred] = drain(once(isRoute(AUTH_ROUTES.elevate), 'defer'));
      elevation.cancel();
      tick();
      issueWrite('pay_first');
      drain();
      plane.release(deferred);
      drain();
      expect(elevation.isOpen()).toBeTrue();
      expect(elevation.error()).toBeNull();
    }));

    it('a pre-handler refusal landing after sign-out is NOT RUN — never a prompt, never a defect', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      const write = issueWrite();
      tick();
      const [req] = http.match((q) => q.url.includes('/commercial/'));
      void auth.signOut();
      tick();
      req.flush({ detail: ELEVATION_REQUIRED_DETAIL }, { status: 403, statusText: 'Forbidden' });
      drain();
      expect(notRun(write.error).reason).toBe('session-ended');
      expect(elevation.isOpen()).toBeFalse();
    }));
  });

  // ── SIGN-OUT ───────────────────────────────────────────────────────────────────────

  describe('sign-out', () => {
    it('ends the NAMED session and reports that the server ended it', fakeAsync(() => {
      const sA = bootstrapAs('alice.synthetic', true);
      void auth.signOut();
      drain();
      expect(plane.sessions.get(sA)?.revoked).toBeTrue();
      expect(auth.remoteSignOut()).toBe('ended');
      expect(router.url).toBe('/login');
    }));

    it('a stale tab’s sign-out names Alice and does NOT end Bob; this tab is still signed out, and says the server half is unconfirmed', fakeAsync(() => {
      const sA = bootstrapAs('alice.synthetic', true);
      const sB = plane.signIn('bob.synthetic'); // another tab
      void auth.signOut();
      drain();

      expect(plane.unsafe.map((u) => u.owner)).toEqual([ownerOf('alice.synthetic', sA)]);
      expect(plane.sessions.get(sB)?.revoked).toBeFalse();
      expect(store.isAuthenticated()).toBeFalse();
      expect(auth.remoteSignOut()).toBe('unconfirmed');
      expect(replaced).toEqual([]);
    }));

    it('with no live session left, the named sign-out is a quiet success that touches no cookie', fakeAsync(() => {
      bootstrapAs('alice.synthetic', true);
      plane.signOutElsewhere();
      const csrf = plane.netCsrf;
      void auth.signOut();
      drain();
      expect(auth.remoteSignOut()).toBe('ended');
      expect(plane.netCsrf).toBe(csrf);
    }));
  });

  // ── A SERVER THAT CANNOT NAME AN OWNER ─────────────────────────────────────────────

  describe('a server that publishes no owner (capability unsupported)', () => {
    beforeEach(() => (plane.binding = false));

    it('signs in, reads, and sends NO guarded write — and says why', fakeAsync(() => {
      signInHere('alice.synthetic');
      expect(store.isAuthenticated()).withContext('login/ and verify/ need no owner').toBeTrue();
      expect(store.binding()).toBe('unsupported');

      let read: unknown = null;
      rest.detail(ID).subscribe((d) => (read = d));
      const write = issueWrite();
      drain();

      expect(read).toBeTruthy();
      expect(writes()).withContext('nothing unsafe reached the wire').toEqual([]);
      expect(notRun(write.error).reason).toBe('binding-unsupported');
      expect(notRun(write.error).sent).toBeFalse();
      expect(continuity.sensitiveHidden()).toBeTrue();
    }));

    it('never downgrades a sign-out to an unnamed one: no request, signed out locally, server half unconfirmed', fakeAsync(() => {
      const sA = plane.signIn('alice.synthetic');
      void auth.bootstrap();
      drain();
      void auth.signOut();
      drain();
      expect(plane.unsafe.filter((u) => u.url === apiUrl(AUTH_ROUTES.logout))).toEqual([]);
      expect(plane.sessions.get(sA)?.revoked).toBeFalse();
      expect(store.isAuthenticated()).toBeFalse();
      expect(auth.remoteSignOut()).toBe('unconfirmed');
    }));

    it('a later read that stops publishing the owner withdraws the capability — a cached one is not proof', fakeAsync(() => {
      plane.binding = true;
      bootstrapAs('alice.synthetic', true);
      expect(store.binding()).toBe('supported');
      plane.binding = false;
      void auth.bootstrap();
      drain();
      expect(store.binding()).toBe('unsupported');
      const write = issueWrite();
      drain();
      expect(writes()).toEqual([]);
      expect(notRun(write.error).reason).toBe('binding-unsupported');
    }));
  });

  // ── OUTCOMES REPORTED TO CONSUMERS ─────────────────────────────────────────────────

  describe('a dispatched write whose session ended before its answer', () => {
    function heldWriteAcrossBoundary(): { outcome: Outcome; held: TestRequest } {
      bootstrapAs('alice.synthetic', true);
      const outcome = issueWrite();
      const [held] = drain(once(isWrite, 'hold'));
      expect(plane.executed.length).withContext('the server acted').toBe(1);
      plane.signIn('bob.synthetic');
      void auth.bootstrap();
      drain();
      expect(replaced).toEqual(['/login?session=changed']);
      return { outcome, held };
    }

    it('a STATED success is withheld — reported as completed, never delivered, never re-sent', fakeAsync(() => {
      const { outcome, held } = heldWriteAcrossBoundary();
      plane.release(held);
      drain();
      expect(outcome.next).toBe(0);
      expect(outcome.error).toEqual(jasmine.any(CommandResultWithheldError));
      expect(writes().length).toBe(1);
    }));

    it('a lost answer is UNKNOWN — never "not run", never re-sent', fakeAsync(() => {
      const { outcome, held } = heldWriteAcrossBoundary();
      held.flush('<html>502</html>', { status: 502, statusText: 'Bad Gateway' });
      drain();
      expect(outcome.error).toEqual(jasmine.any(CommandOutcomeUnknownError));
      expect(writes().length).toBe(1);
    }));

    it('a malformed 2xx is UNKNOWN too — a 2xx is not proof of execution', fakeAsync(() => {
      const { outcome, held } = heldWriteAcrossBoundary();
      held.flush({ ok: true });
      drain();
      expect(outcome.error).toEqual(jasmine.any(CommandOutcomeUnknownError));
    }));
  });

  // ── THE CONSUMERS ──────────────────────────────────────────────────────────────────

  describe('real consumers', () => {
    let harness: RouterTestingHarness;
    const el = () => harness.routeDebugElement?.nativeElement as HTMLElement;
    const text = () => el().textContent ?? '';
    /** The actual input value — the only sanctioned place the plaintext may be. */
    const codeValue = () => el().querySelector<HTMLInputElement>('[data-claim-code]')?.value ?? null;
    function resume(): void {
      window.dispatchEvent(new Event('focus')); // SYNTHETIC
      tick();
      harness.detectChanges();
    }
    function sessionRead(): TestRequest {
      const open = http.match((q) => q.url === apiUrl(AUTH_ROUTES.session));
      expect(open.length).withContext('resume issues exactly one read').toBe(1);
      return open[0];
    }
    function tokenNowhere(): void {
      expect(codeValue()).toBeNull();
      expect(el().innerHTML).not.toContain(TOKEN);
      expect(text()).not.toContain(TOKEN);
    }

    describe('Readiness claim code', () => {
      const claimPanel = () => el().querySelector('section[aria-labelledby="owner-claim-heading"]')!;
      function act(label: 'Reissue claim code' | 'Cancel invitation', decide: (r: TestRequest) => Disposition = () => 'answer'): TestRequest[] {
        Array.from(claimPanel().querySelectorAll<HTMLButtonElement>('[data-claim-actions] button'))
          .find((b) => b.textContent?.trim() === label)!
          .click();
        harness.detectChanges();
        const box = claimPanel().querySelector<HTMLTextAreaElement>('[data-invitation-reason]')!;
        box.value = REASON;
        box.dispatchEvent(new Event('input'));
        harness.detectChanges();
        Array.from(claimPanel().querySelector('[data-invitation-editor]')!.querySelectorAll('button'))
          .find((b) => b.textContent?.trim() === label)!
          .click();
        const held = drain(decide);
        harness.detectChanges();
        return held;
      }
      async function openReadiness(): Promise<void> {
        harness = await RouterTestingHarness.create();
        await harness.navigateByUrl(`/restaurants/${ID}/readiness`, RestaurantDetailPage);
        drain();
        harness.detectChanges();
      }
      async function withVisibleClaim(): Promise<void> {
        bootstrapAs('alice.synthetic', true);
        await openReadiness();
        act('Reissue claim code');
        expect(codeValue()).toBe(TOKEN);
      }

      it('resume hides the code AT ONCE; the same owner confirms and the held code is shown again', fakeAsync(async () => {
        await withVisibleClaim();
        window.dispatchEvent(new Event('focus'));
        harness.detectChanges();
        expect(codeValue()).withContext('hidden before any answer').toBeNull();
        expect(el().querySelector('[data-claim-code-unconfirmed]')).toBeTruthy();
        drain();
        harness.detectChanges();
        expect(codeValue()).toBe(TOKEN);
        expect(replaced).toEqual([]);
        flush();
      }));

      it('resume under a different owner crosses the boundary, and the code never returns', fakeAsync(async () => {
        await withVisibleClaim();
        plane.signIn('bob.synthetic');
        resume();
        plane.answer(sessionRead());
        drain();
        harness.detectChanges();
        expect(replaced).toEqual(['/login?session=changed']);
        tokenNowhere();
        flush();
      }));

      it('a resume read that names NO owner leaves the code hidden for good', fakeAsync(async () => {
        await withVisibleClaim();
        plane.binding = false;
        resume();
        plane.answer(sessionRead());
        drain();
        harness.detectChanges();
        expect(store.binding()).toBe('unsupported');
        tokenNowhere();
        plane.binding = true;
        resume();
        drain();
        harness.detectChanges();
        expect(codeValue()).withContext('a later owner-bearing read does not reinstate it').toBeNull();
        flush();
      }));

      it('an UNAVAILABLE resume read keeps the operator signed in and the code hidden', fakeAsync(async () => {
        await withVisibleClaim();
        resume();
        sessionRead().error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
        tick();
        harness.detectChanges();
        expect(store.username()).toBe('alice.synthetic');
        expect(status.unavailable()).toBeTrue();
        expect(codeValue()).toBeNull();
        expect(el().querySelector('[data-claim-code-unconfirmed]')).toBeTruthy();
        expect(replaced).toEqual([]);
        flush();
      }));

      it('an ended session takes the code out of the DOM', fakeAsync(async () => {
        await withVisibleClaim();
        store.end();
        harness.detectChanges();
        tokenNowhere();
        flush();
      }));

      it('an INDETERMINATE mutation discards the code PERMANENTLY — no resume, read or unchanged id brings it back', fakeAsync(async () => {
        await withVisibleClaim();
        plane.nextWrite = { status: 502, body: '<html>502</html>' };
        act('Cancel invitation');
        expect(text()).toContain('it is not known whether the invitation was cancelled');
        tokenNowhere();

        resume();
        drain();
        harness.detectChanges();
        expect(continuity.state()).toBe('confirmed');
        expect(text()).toContain('The invitation on record was not cancelled.');
        tokenNowhere();
        flush();
      }));

      it('a reissue answer landing after the boundary is WITHHELD — the code is never rendered', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        await openReadiness();
        const [held] = act('Reissue claim code', once(isWrite, 'hold'));
        expect(plane.executed.map((e) => e.principal)).toEqual(['alice.synthetic']);
        plane.signIn('bob.synthetic');
        void auth.bootstrap();
        drain();
        expect(replaced).toEqual(['/login?session=changed']);

        plane.release(held);
        drain();
        harness.detectChanges();
        tokenNowhere();
        expect(text()).toContain('reported this command as completed');
        expect(writes().length).toBe(1);
        flush();
      }));

      it('a reissue whose answer is LOST after the boundary is unknown — never "nothing changed", never re-sent as Bob', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        await openReadiness();
        const [held] = act('Reissue claim code', once(isWrite, 'hold'));
        plane.signIn('bob.synthetic');
        void auth.bootstrap();
        drain();
        const detailReads = plane.detailReads;
        held.flush('bad gateway', { status: 502, statusText: 'Bad Gateway' });
        drain();
        harness.detectChanges();
        tokenNowhere();
        expect(text()).not.toContain('Nothing was changed');
        // The indeterminate branch re-reads the projection; with no session left in this
        // tab that read is refused before it is sent, rather than read as Bob.
        expect(plane.detailReads).toBe(detailReads);
        expect(text()).toContain('This read belonged to an admin session that has ended in this tab.');
        expect(writes().filter((u) => u.owner?.includes(plane.principal('bob.synthetic').id))).toEqual([]);
        expect(plane.executed.length).toBe(1);
        flush();
      }));

      it('a cancel refused by CSRF whose recovery read gets no answer is NOT RUN — no "not known", no indeterminate re-read', fakeAsync(async () => {
        await withVisibleClaim();
        const detailReads = plane.detailReads;
        plane.netCsrf = null;
        plane.jsCsrf = null;
        const [read] = act('Cancel invitation', once(isRoute(AUTH_ROUTES.session), 'defer'));
        read.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
        drain();
        harness.detectChanges();

        expect(text()).toContain('could not confirm that its admin session is still current');
        expect(text()).not.toContain('it is not known whether');
        expect(plane.detailReads).withContext('no indeterminate re-read').toBe(detailReads);
        expect(writes().length).withContext('the reissue, and this cancel sent once').toBe(2);
        expect(plane.executed.length).withContext('only the reissue ran').toBe(1);
        flush();
      }));

      it('a clipboard write that completes after the code was hidden publishes nothing', fakeAsync(async () => {
        await withVisibleClaim();
        let resolveWrite: () => void = () => undefined;
        const writesMade: string[] = [];
        const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (value: string) => {
              writesMade.push(value);
              return new Promise<void>((resolve) => (resolveWrite = resolve));
            },
          },
        });
        try {
          el().querySelector<HTMLButtonElement>('[data-claim-copy] button')!.click();
          flushMicrotasks();
          expect(writesMade).toEqual([TOKEN]);

          window.dispatchEvent(new Event('focus')); // hidden before the clipboard answers
          harness.detectChanges();
          expect(el().querySelector('[data-claim-copy]')).withContext('no copy control while hidden').toBeNull();
          resolveWrite();
          flushMicrotasks();
          drain();
          harness.detectChanges();
          expect(codeValue()).toBe(TOKEN);
          expect(text()).not.toContain('Copied to the clipboard.');
        } finally {
          if (original) Object.defineProperty(Navigator.prototype, 'clipboard', original);
          delete (navigator as unknown as Record<string, unknown>)['clipboard'];
        }
        flush();
      }));
    });

    describe('creation claim code', () => {
      function type(attribute: string, value: string): void {
        const input = el().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[${attribute}]`)!;
        input.value = value;
        input.dispatchEvent(new Event('input'));
        harness.detectChanges();
      }
      function choose(attribute: string): void {
        el().querySelector<HTMLInputElement>(`[${attribute}]`)!.click();
        harness.detectChanges();
      }
      async function create(decide: (r: TestRequest) => Disposition = () => 'answer'): Promise<TestRequest[]> {
        harness = await RouterTestingHarness.create();
        await harness.navigateByUrl('/restaurants/new', RestaurantCreatePage);
        harness.detectChanges();
        type('data-create-name', 'Speke Road Cafe');
        type('data-create-location', 'Kampala');
        choose('data-create-classification-real');
        choose('data-create-owner-new');
        type('data-create-first-name', 'Miriam');
        type('data-create-last-name', 'Nakato');
        type('data-create-phone', '0772140388');
        type('data-create-reason', REASON);
        el().querySelector<HTMLButtonElement>('[data-create-submit] button')!.click();
        const held = drain(decide);
        harness.detectChanges();
        return held;
      }

      it('shown once created; resume hides it; the same owner shows it again', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        await create();
        expect(codeValue()).toBe(TOKEN);
        window.dispatchEvent(new Event('focus'));
        harness.detectChanges();
        expect(codeValue()).toBeNull();
        drain();
        harness.detectChanges();
        expect(codeValue()).toBe(TOKEN);
        flush();
      }));

      it('an unavailable resume read hides it; a read naming no owner keeps it hidden; an ended session removes it', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        await create();
        resume();
        sessionRead().error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
        tick();
        harness.detectChanges();
        expect(codeValue()).toBeNull();

        plane.binding = false;
        resume();
        plane.answer(sessionRead());
        drain();
        harness.detectChanges();
        expect(codeValue()).toBeNull();

        store.end();
        harness.detectChanges();
        tokenNowhere();
        flush();
      }));

      it('a creation answered after the boundary is withheld: no code, and "completed" rather than "failed" or "not run"', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        const [held] = await create(once(isWrite, 'hold'));
        plane.signIn('bob.synthetic');
        void auth.bootstrap();
        drain();
        plane.release(held);
        drain();
        harness.detectChanges();
        tokenNowhere();
        expect(text()).toContain('reported this command as completed');
        expect(text()).not.toContain('not run');
        expect(writes().length).toBe(1);
        flush();
      }));

      it('a creation whose answer is lost after the boundary is "Outcome unknown", once', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        const [held] = await create(once(isWrite, 'hold'));
        plane.signIn('bob.synthetic');
        void auth.bootstrap();
        drain();
        held.flush('bad gateway', { status: 502, statusText: 'Bad Gateway' });
        drain();
        harness.detectChanges();
        tokenNowhere();
        expect(el().querySelector('[data-create-indeterminate]')).toBeTruthy();
        expect(writes().length).toBe(1);
        flush();
      }));
    });

    describe('commercial write (Overview)', () => {
      const panel = () => el().querySelector('[aria-labelledby="commercial-heading"]')!;
      async function saveTiming(decide: (r: TestRequest) => Disposition): Promise<TestRequest[]> {
        harness = await RouterTestingHarness.create();
        await harness.navigateByUrl(`/restaurants/${ID}`, RestaurantDetailPage);
        drain();
        harness.detectChanges();
        const dt = Array.from(panel().querySelectorAll('dt')).find((node) => node.textContent?.trim() === 'Payment timing')!;
        dt.nextElementSibling!.querySelector('button')!.click();
        harness.detectChanges();
        const editor = panel().querySelector('[data-commercial-editor]')!;
        editor.querySelector<HTMLInputElement>('input[value="pay_after"]')!.click();
        const box = editor.querySelector<HTMLTextAreaElement>('[data-commercial-reason]')!;
        box.value = REASON;
        box.dispatchEvent(new Event('input'));
        harness.detectChanges();
        Array.from(editor.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save change')!.click();
        const held = drain(decide);
        harness.detectChanges();
        return held;
      }

      it('withheld vs unknown: truthful copy, and exactly one send either way', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        const [held] = await saveTiming(once(isWrite, 'hold'));
        expect(writes()[0].body).toEqual(jasmine.objectContaining({ expected_current: 'pay_first' }));
        plane.signIn('bob.synthetic');
        void auth.bootstrap();
        drain();
        plane.release(held);
        drain();
        harness.detectChanges();
        expect(panel().textContent).toContain('reported this command as completed');
        expect(panel().textContent).not.toContain('Nothing was changed');
        expect(writes().length).toBe(1);
        flush();
      }));

      it('a save refused by CSRF whose recovery read gets no answer is NOT RUN — never "not known"', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        plane.netCsrf = null;
        plane.jsCsrf = null;
        const [read] = await saveTiming(once(isRoute(AUTH_ROUTES.session), 'defer'));
        read.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
        drain();
        harness.detectChanges();

        expect(panel().textContent).toContain('could not confirm that its admin session is still current');
        expect(panel().textContent).not.toContain('it is not known whether');
        expect(writes().length).toBe(1);
        expect(plane.executed).toEqual([]);
        flush();
      }));

      it('a lost commercial answer after the boundary takes the indeterminate branch and is never resent', fakeAsync(async () => {
        bootstrapAs('alice.synthetic', true);
        const [held] = await saveTiming(once(isWrite, 'hold'));
        plane.signIn('bob.synthetic');
        void auth.bootstrap();
        drain();
        held.flush('bad gateway', { status: 502, statusText: 'Bad Gateway' });
        drain();
        harness.detectChanges();
        expect(panel().textContent).toContain('it is not known whether this change was recorded');
        expect(writes().length).toBe(1);
        flush();
      }));
    });
  });

  it('reads command_owner strictly — absent, malformed and wrong-version never become an owner', () => {
    const good = { command_owner: { version: 1, actor: alice().id, session: '00000000-0000-4000-8000-000000000001' } };
    expect(readCommandOwner(good).kind).toBe('owner');
    expect(readCommandOwner({}).kind).toBe('absent');
    expect(readCommandOwner({ command_owner: { ...good.command_owner, version: 2 } }).kind).toBe('malformed');
    // The plane's refusal bodies are B1's, so the exact reader must accept them.
    expect(readOwnerRefusal({ status: 400, error: REFUSED.malformed })).toBe('owner-malformed');
  });
});

// ── THE DEVELOPMENT MOCK ─────────────────────────────────────────────────────────────

/**
 * `npm start` resolves `ADMIN_AUTH` to `MockAdminAuthApi`. It states the same owner
 * contract — a new session id per sign-in, the refusals B1 renders, applied where B1
 * applies them — with no lever. Production never contains it (`check:mock-isolation`).
 */
describe('D10 — the development mock states the real owner contract', () => {
  let auth: AdminAuthService;
  let store: SessionStore;
  let api: MockAdminAuthApi;
  let replaced: string[];

  beforeEach(() => {
    sessionStorage.removeItem('dinify-admin.mock-session');
    replaced = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ADMIN_AUTH, useClass: MockAdminAuthApi },
        { provide: DOCUMENT_REPLACE, useValue: (url: string) => replaced.push(url) },
      ],
    });
    auth = TestBed.inject(AdminAuthService);
    store = TestBed.inject(SessionStore);
    api = TestBed.inject(ADMIN_AUTH) as MockAdminAuthApi;
  });
  afterEach(() => sessionStorage.removeItem('dinify-admin.mock-session'));

  function signIn(): void {
    void auth.login('operator', 'password');
    tick(1000);
    void auth.verify('totp', '123456');
    tick(1000);
  }

  it('publishes an owner at sign-in, and a NEW session per sign-in', fakeAsync(() => {
    signIn();
    const first = store.owner();
    expect(store.binding()).toBe('supported');
    void auth.signOut();
    tick(1000);
    signIn();
    expect(store.owner()?.actor).toBe(first?.actor);
    expect(store.owner()?.session).not.toBe(first?.session);
  }));

  it('refuses a sign-out naming another session with B1’s body, and ends nothing', fakeAsync(() => {
    signIn();
    const owner = store.owner()!;
    let error: unknown = null;
    api.logout({ ...owner, session: '0d0d0d0d-0000-4000-8000-0000000000dd' }).subscribe({ error: (e: unknown) => (error = e) });
    tick(1000);
    expect(readOwnerRefusal(error)).toBe('session-changed');
    expect(sessionStorage.getItem('dinify-admin.mock-session')).toBe(owner.session);
  }));

  it('refuses an elevation opened under another session BEFORE looking at the code', fakeAsync(() => {
    signIn();
    const owner = store.owner()!;
    let error: unknown = null;
    api.elevate('totp', '000000', { owner: { ...owner, session: '0d0d0d0d-0000-4000-8000-0000000000dd' }, lifecycle: 0 })
      .subscribe({ error: (e: unknown) => (error = e) });
    tick(1000);
    expect(readOwnerRefusal(error)).toBe('session-changed');
  }));

  it('a bootstrap after another tab signed in again crosses the boundary', fakeAsync(() => {
    signIn();
    sessionStorage.setItem('dinify-admin.mock-session', '0d0d0d0d-0000-4000-8000-0000000000dd');
    void auth.bootstrap();
    tick(1000);
    expect(replaced).toEqual(['/login?session=renewed']);
  }));
});
