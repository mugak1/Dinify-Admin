import {
  HttpErrorResponse,
  HttpEvent,
  HttpEventType,
  HttpInterceptorFn,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  catchError,
  defer,
  EMPTY,
  mergeMap,
  MonoTypeOperatorFunction,
  Observable,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

import { ADMIN_AUTH } from '../auth/admin-auth.api';
import {
  COMMAND_OWNER_HEADER,
  CommandNotRunError,
  CommandOwner,
  CommandOutcomeUnknownError,
  CommandResultWithheldError,
  compareOwners,
  formatCommandOwner,
  readOwnerRefusal,
  SessionEndedReadError,
} from '../auth/command-owner';
import { ElevationService } from '../auth/elevation.service';
import { boundaryKindFor, SessionBoundary } from '../auth/session-boundary.service';
import { SessionContinuityService } from '../auth/session-continuity.service';
import { isAdminSessionResponse } from '../auth/session.model';
import { SessionStore } from '../auth/session.store';
import {
  apiUrl,
  AUTH_ROUTES,
  CSRF_FAILURE_DETAIL_PREFIX,
  ELEVATION_REQUIRED_DETAIL,
  isAdminApiUrl,
  SAFE_METHODS,
} from './api.constants';
import { DefectService } from './defect.service';
import { extractDetail, extractErrorMessage } from './error-message';
import {
  COMMAND_OWNER,
  CSRF_RETRIED,
  ELEVATION_REPLAYED,
  LIFECYCLE,
  SIGN_OUT_TEARDOWN,
  SUPPRESS_DEFECT_REPORT,
} from './http-context';
import { AdminServiceStatus } from './service-status';
import { classifyTransportFailure, extractRequestId } from './transport-failure';

/**
 * Statuses that are an application OUTCOME rather than a defect. The screen that made
 * the request renders these; a global banner would be a second, worse copy.
 */
const EXPECTED_CLIENT_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);

/**
 * THE ERROR CLASSIFIER — one place, four cases, and they are genuinely different
 * things rather than four shades of "an error happened".
 *
 *   1. 401 — THE SESSION IS GONE. Absolute 8-hour expiry, the 30-minute idle timeout,
 *      or revocation. Client state is cleared and the operator is routed to
 *      /login?returnUrl=. NEVER retried: there is no credential left to retry with.
 *
 *   2. 403 carrying the CSRF message — THE TOKEN IS STALE: the cookie is missing, or
 *      a sign-in in another tab rotated the secret. Re-read GET /auth/session/ ONCE
 *      (which ENSURES rather than rotates, so it cannot invalidate anyone else's),
 *      retry ONCE, then hard-fail as a defect. Not an infinite retry. D10: the retry is
 *      allowed only when that read names the owner the command was issued under — a
 *      repaired CSRF pair says nothing about which session the command belongs to.
 *
 *   3. 403 carrying the ELEVATION message — AN EXPECTED SECURITY STATE, not an error.
 *      Open one re-elevation modal, POST /auth/elevate/, and REPLAY THE ORIGINAL
 *      REQUEST on success so the operator does not lose what they were doing.
 *
 *   4. 403 from /auth/elevate/ ITSELF — the re-elevation ATTEMPT failing. Surfaced
 *      inside the modal by `ElevationService`; never treated as "needs elevation".
 *
 * Everything else surfaces.
 *
 * ── THE PRECONDITION ABOVE ALL FOUR ───────────────────────────────────────────────
 *
 * "Did we get a usable response at all" is PRIOR to "what did the server say", so it
 * is not a fifth case — it is a precondition, and it runs first. None of the four can
 * apply when the answer is no response: a request that never reached the server did
 * not fail authentication, was not refused for a stale CSRF token, and did not need
 * re-elevation. Reading a 5xx or a dead socket as one of those would be inventing a
 * server statement that was never made.
 *
 * It reports through `AdminServiceStatus` rather than `DefectService`, and
 * `SUPPRESS_DEFECT_REPORT` DELIBERATELY DOES NOT APPLY TO IT. Suppressing a 401 on an
 * auth route is right — the login form renders it. Suppressing a 502 is how an
 * afternoon disappears: the operator is told they are signed out by an application
 * that never got an answer.
 *
 * One consequence worth stating: 5xx and status 0 no longer reach the defect tail
 * below, because this claims them first. What remains there is the unexpected 4xx.
 *
 * ── HOW CASES 2, 3 AND 4 ARE KEPT APART ───────────────────────────────────────────
 *
 * MATCH ONLY AGAINST `detail`. There is no custom DRF exception handler on the admin
 * plane, so two body shapes coexist: everything DRF raises is `{"detail": ...}` and
 * every hand-written endpoint denial is `{"status": ..., "message": ...}`. Cases 2
 * and 3 are both `detail`; case 4 — `{"status": 403, "message": "Invalid or expired
 * verification."}` — is `message`, so it CANNOT collide with either.
 *
 * The elevate route is ALSO excluded from case 3 explicitly. That exclusion is
 * redundant given the shape difference above, and it is here on purpose: an invariant
 * this important should be stated in the code rather than left to emerge from a
 * property of two response bodies that a backend tidy-up could change.
 *
 * The elevate route is deliberately NOT excluded from case 2 — it is a
 * CSRF-ENFORCED route and can legitimately be refused for a stale token.
 *
 * ── WHY THE HANDLER RE-ENTERS ITSELF ──────────────────────────────────────────────
 *
 * A recovery is only bounded if the SECOND failure is classified too. `catchError`
 * catches from its source, not from what its handler returns, so a replayed request
 * that fails again would otherwise sail straight past this function and reach the
 * caller unclassified — the exhausted-retry defects would never be reported and the
 * bound would exist only in the comments. So `classify` calls itself on the replayed
 * request, and terminates because the replay carries a context flag that forces the
 * exhausted branch. One elevation, one replay; one re-bootstrap, one retry.
 *
 * ── D10: WHO A COMMAND BELONGS TO ─────────────────────────────────────────────────
 *
 * ISSUANCE. On first entry every request captures the local LIFECYCLE, and every
 * guarded write — an unsafe admin request other than login/, verify/ and logout/ —
 * also captures the COMMAND OWNER and carries it as `X-Admin-Command-Owner`. Both are
 * fixed there: a retry or a replay re-enters `dispatch`, never this function, and
 * carries the same header, method, URL and body. A guarded write with no owner to name
 * is NOT SENT — an unnamed command is exactly the one the server cannot refuse. A
 * document holding no session sends no admin read other than `session/` either: a
 * screen still asking after its session ended would be reading under whatever cookie
 * the browser holds by then.
 *
 * THE SERVER'S REFUSAL is read exactly (`readOwnerRefusal`) and never enters the CSRF
 * or elevation recoveries: a different administrator, or a new session of the same one,
 * crosses the session boundary and the command is reported as not run. An ordinary 409
 * is an ordinary 409.
 *
 * AN ANSWER FOR AN ENDED LIFECYCLE DRIVES NOTHING. It adopts, clears, navigates,
 * prompts, reports and replays nothing; the command it answers is told only what is
 * true — refused before execution, reported complete but withheld, or unknown — and is
 * never re-sent. Once this document holds a successor session, such an answer reaches
 * no consumer at all.
 *
 * THE ONE TEARDOWN EXCEPTION is the named sign-out: see `SIGN_OUT_TEARDOWN`.
 */
export const errorClassifierInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const store = inject(SessionStore);
  const elevation = inject(ElevationService);
  const defects = inject(DefectService);
  const status = inject(AdminServiceStatus);
  const auth = inject(ADMIN_AUTH);
  const boundary = inject(SessionBoundary);
  const continuity = inject(SessionContinuityService);

  // ── THE NAMED SIGN-OUT ─────────────────────────────────────────────────────────
  // Sent after its lifecycle ended, on purpose, naming the owner captured before that.
  // Without one it is not sent at all. Its answer goes straight back to the sign-out
  // that asked, and drives nothing else: no adoption, no navigation, no boundary, no
  // outage report, no retry.
  if (isRoute(req, AUTH_ROUTES.logout)) {
    const owner = req.context.get(COMMAND_OWNER);
    if (!req.context.get(SIGN_OUT_TEARDOWN) || owner === null) {
      return throwError(() => new CommandNotRunError('owner-unknown', false));
    }
    return next(req.clone({ setHeaders: { [COMMAND_OWNER_HEADER]: formatCommandOwner(owner) } }));
  }

  // ── ISSUANCE ───────────────────────────────────────────────────────────────────
  // A document holding no session reads nothing but `session/` itself. The only way
  // to be here with a screen still asking is a lifecycle that just ENDED — a sign-out,
  // a denial, a boundary — and a read sent now would go out under whatever cookie the
  // browser holds by then, which may be someone else's.
  if (isSignedInRead(req) && !store.isAuthenticated()) {
    return throwError(() => new SessionEndedReadError());
  }
  const lifecycle = req.context.get(LIFECYCLE) ?? store.lifecycle();
  let issued = req.clone({ context: req.context.set(LIFECYCLE, lifecycle) });
  if (isGuardedWrite(req)) {
    const admitted = admitOwner(store, lifecycle, req.context.get(COMMAND_OWNER));
    if (admitted instanceof CommandNotRunError) return throwError(() => admitted);
    issued = issued.clone({
      setHeaders: { [COMMAND_OWNER_HEADER]: formatCommandOwner(admitted) },
      context: issued.context.set(COMMAND_OWNER, admitted),
    });
  }

  // login/ and verify/ come BEFORE a session: they belong to no lifecycle and are never
  // fenced by one, so a document can always sign in. `AdminAuthService.verify` fences
  // what it does with the answer.
  const current = (request: HttpRequest<unknown>): boolean =>
    isPreSession(request) || store.isCurrent(request.context.get(LIFECYCLE));

  /**
   * An answer that arrived after its lifecycle ended. What it may truthfully say
   * depends on what the server said — and on nothing else, since no body, claim code or
   * projection from it is delivered.
   */
  const late = (
    request: HttpRequest<unknown>,
    answer: HttpResponse<unknown> | HttpErrorResponse,
  ): Observable<never> => {
    // A successor session is held here: nothing from the old one crosses into it.
    if (store.isAuthenticated()) return EMPTY;
    if (isSafe(request)) return throwError(() => new SessionEndedReadError());
    const requestId = extractRequestId(answer);
    if (answer instanceof HttpResponse) {
      return throwError(() =>
        isContractSuccess(answer)
          ? new CommandResultWithheldError(requestId)
          : new CommandOutcomeUnknownError(requestId),
      );
    }
    if (isPreHandlerRefusal(answer)) {
      return throwError(() => new CommandNotRunError('session-ended', true));
    }
    return throwError(() => new CommandOutcomeUnknownError(requestId));
  };

  /** Re-checked before EVERY send: the first, the CSRF retry and the elevation replay. */
  const dispatch = (request: HttpRequest<unknown>): Observable<HttpEvent<unknown>> =>
    defer(() => {
      if (!current(request)) {
        return throwError(() =>
          isSafe(request)
            ? new SessionEndedReadError()
            : new CommandNotRunError('session-ended', false),
        );
      }
      return next(request).pipe(
        mergeMap((event) =>
          event instanceof HttpResponse && !current(request) ? late(request, event) : of(event),
        ),
        reachableOnResponse(status),
        catchError((error: unknown) => classify(request, error)),
      );
    });

  const classify = (
    request: HttpRequest<unknown>,
    error: unknown,
  ): Observable<HttpEvent<unknown>> => {
    if (!(error instanceof HttpErrorResponse)) return throwError(() => error);

    // --- D10: AN ANSWER FOR AN ENDED LIFECYCLE --------------------------------------
    // Above everything, the transport precondition included. An old 401 must not sign
    // out a later session; an old refusal must not prompt or cross a boundary; an old
    // outage must not raise a banner about a session that is gone.
    if (!current(request)) return late(request, error);

    const detail = extractDetail(error);
    const requestId = extractRequestId(error);

    // --- PRECONDITION: DID WE GET A USABLE RESPONSE AT ALL? ------------------------
    // Above the four cases, not among them. See the class comment.
    if (classifyTransportFailure(error) === 'unavailable') {
      status.reportUnavailable(requestId);
      return throwError(() => error);
    }

    // --- D10: THE SERVER'S OWNER PRECONDITION ---------------------------------------
    // Refused before CSRF, permissions, the factor and the handler, so nothing ran and
    // this is the one outcome that may say so. Only a request that NAMED an owner can
    // be refused for it; anything else carrying these codes is not this contract.
    const refusal = request.context.get(COMMAND_OWNER) ? readOwnerRefusal(error) : null;
    if (refusal === 'actor-changed' || refusal === 'session-changed') {
      status.markReachable();
      boundary.cross(boundaryKindFor(refusal));
      return throwError(() => new CommandNotRunError(refusal, true));
    }
    if (refusal === 'owner-malformed') {
      // This client formatted a header its own server cannot read. Nothing ran, and it
      // is a defect worth a report.
      status.markReachable();
      if (!request.context.get(SUPPRESS_DEFECT_REPORT)) {
        defects.report({
          message:
            'A command could not be tied to its admin session, so it was not run. That is a defect worth reporting.',
          requestId,
          kind: 'unclassified',
        });
      }
      return throwError(() => new CommandNotRunError('owner-malformed', true));
    }

    // --- CASE 1 --------------------------------------------------------------------
    if (error.status === 401) {
      // A 401 from login/ or verify/ is a REJECTED CREDENTIAL, not a lost session. The
      // form renders the server's message; redirecting to the page the operator is
      // already looking at would wipe what they typed for no reason.
      if (isRoute(request, AUTH_ROUTES.login) || isRoute(request, AUTH_ROUTES.verify)) {
        return throwError(() => error);
      }

      // A GENUINE CURRENT-SESSION DENIAL ends the lifecycle — when there is a session to
      // end. A signed-out document has none, and nothing it issued is outstanding.
      const wasAuthenticated = store.isAuthenticated();
      if (wasAuthenticated) store.end();

      // The bootstrap read is expected to 401 for a signed-out operator; the guard
      // routes them. Navigating from here as well would race the first navigation.
      if (wasAuthenticated || !isRoute(request, AUTH_ROUTES.session)) {
        void router.navigate(['/login'], {
          queryParams: { returnUrl: router.url },
          replaceUrl: true,
        });
      }
      return throwError(() => error);
    }

    // --- CASE 2 --------------------------------------------------------------------
    if (error.status === 403 && detail?.startsWith(CSRF_FAILURE_DETAIL_PREFIX)) {
      if (request.context.get(CSRF_RETRIED)) {
        defects.report({
          message:
            'A security token could not be refreshed. Reload the page; if this keeps ' +
            'happening it is a defect worth reporting.',
          requestId,
          kind: 'csrf-retry-exhausted',
        });
        return throwError(() => error);
      }

      const retried = request.clone({ context: request.context.set(CSRF_RETRIED, true) });
      const ticket = store.issueTicket();
      const epoch = continuity.epoch();
      // THE COMMAND WAS REFUSED BY CSRF, BEFORE ANY HANDLER, and is not retried unless
      // the read below proves continuity — so whatever happens to that read, this command
      // did not run, and that is the only thing it is told. The READ is its own request,
      // issued in this command's lifecycle and classified by its own dispatch: a 401
      // there has already ended the lifecycle and routed to sign-in, no usable answer has
      // already raised the outage state, and an answer for an ended lifecycle has already
      // been discarded. None of those is this command's outcome. (With a successor held,
      // the read reaches nobody and neither does this command.)
      const notRun = (): CommandNotRunError =>
        new CommandNotRunError(current(request) ? 'continuity-unconfirmed' : 'session-ended', true);
      return auth.readSession().pipe(
        catchError(() => throwError(notRun)),
        switchMap((session) => {
          if (!isAdminSessionResponse(session)) {
            // A 200 that is not a session is no usable answer — the state the bootstrap
            // and the resume check report for it — and still no proof of continuity.
            if (current(request)) status.reportUnavailable(null);
            return throwError(notRun);
          }
          // ONE bounded retry, and only across PROVEN continuity: the read must name the
          // owner the command was issued under. The command was refused by CSRF, before
          // any handler, so every other answer here is "not run".
          const observed = continuity.apply(ticket, epoch, session);
          switch (observed) {
            case 'same':
              return dispatch(retried);
            case 'actor-changed':
            case 'session-changed':
              return throwError(() => new CommandNotRunError(observed, true));
            case 'unbound':
              return throwError(() => new CommandNotRunError('binding-unsupported', true));
            case 'superseded':
              // A newer read already settled: this one describes an earlier moment and
              // proves nothing about now. Not a boundary, and not a retry.
              return throwError(() => new CommandNotRunError('continuity-unconfirmed', true));
            default:
              return throwError(() => new CommandNotRunError('session-ended', true));
          }
        }),
      );
    }

    // --- CASE 3 --------------------------------------------------------------------
    if (
      error.status === 403 &&
      detail === ELEVATION_REQUIRED_DETAIL &&
      !isRoute(request, AUTH_ROUTES.elevate)
    ) {
      if (request.context.get(ELEVATION_REPLAYED)) {
        // A second factor was accepted moments ago and the server still refuses.
        // Prompting again would loop the operator through a modal that cannot help.
        defects.report({
          message:
            'This action was refused even after re-authenticating. That is a defect — ' +
            'nothing was changed.',
          requestId,
          kind: 'elevation-replay-exhausted',
        });
        return throwError(() => error);
      }

      const replayed = request.clone({
        context: request.context.set(ELEVATION_REPLAYED, true),
      });
      // The prompt is bound to THIS command's owner and lifecycle, and the replay is
      // re-checked before it is sent — a prompt settled after its lifecycle ended
      // releases nothing.
      return elevation
        .request('action-required', {
          owner: request.context.get(COMMAND_OWNER),
          lifecycle: request.context.get(LIFECYCLE) ?? store.lifecycle(),
        })
        .pipe(switchMap(() => dispatch(replayed)));
    }

    // --- CASE 4 --------------------------------------------------------------------
    // Stated rather than left to fall through. `ElevationService.submit` owns this
    // one; the modal stays open and shows the server's message.
    if (error.status === 403 && isRoute(request, AUTH_ROUTES.elevate)) {
      return throwError(() => error);
    }

    // --- Everything else surfaces --------------------------------------------------
    if (!request.context.get(SUPPRESS_DEFECT_REPORT) && isDefect(error.status)) {
      defects.report({ message: extractErrorMessage(error), requestId, kind: 'unclassified' });
    }
    return throwError(() => error);
  };

  return dispatch(issued);
};

/**
 * D10. The owner a guarded write names, or why it is not sent. A command issued by an
 * ended lifecycle, a document with no session, or a session whose owner is unknown is
 * refused here — `sent: false` — rather than sent unnamed. `supplied` is an owner the
 * caller captured earlier (an elevation attempt); it must still be this lifecycle's.
 */
function admitOwner(
  store: SessionStore,
  lifecycle: number,
  supplied: CommandOwner | null,
): CommandOwner | CommandNotRunError {
  if (!store.isCurrent(lifecycle)) return new CommandNotRunError('session-ended', false);
  if (!store.isAuthenticated()) return new CommandNotRunError('no-session', false);
  const held = store.owner();
  if (store.binding() !== 'supported' || held === null) {
    return new CommandNotRunError('binding-unsupported', false);
  }
  if (supplied !== null && compareOwners(supplied, held) !== 'same') {
    return new CommandNotRunError('session-ended', false);
  }
  return held;
}

function isSafe(request: HttpRequest<unknown>): boolean {
  return SAFE_METHODS.includes(request.method.toUpperCase());
}

/**
 * D10. The requests that must name their owner: unsafe, on this admin API, and
 * authenticated by the session. login/ and verify/ come before a session exists and
 * stay open to a document that holds none; logout/ has its own rule above.
 */
function isGuardedWrite(request: HttpRequest<unknown>): boolean {
  if (isSafe(request) || !isAdminApiUrl(request.url)) return false;
  return !(isPreSession(request) || isRoute(request, AUTH_ROUTES.logout));
}

/** D10. A safe admin request that only a signed-in document makes. */
function isSignedInRead(request: HttpRequest<unknown>): boolean {
  return (
    isSafe(request) && isAdminApiUrl(request.url) && !isRoute(request, AUTH_ROUTES.session)
  );
}

function isPreSession(request: HttpRequest<unknown>): boolean {
  return isRoute(request, AUTH_ROUTES.login) || isRoute(request, AUTH_ROUTES.verify);
}

/**
 * A success the admin plane STATED, not merely a 2xx: `{status: <the same 2xx>,
 * data: {...}}`, the envelope every admin write returns. Anything less is inconclusive.
 */
function isContractSuccess(response: HttpResponse<unknown>): boolean {
  if (response.status < 200 || response.status >= 300) return false;
  const body = response.body;
  if (typeof body !== 'object' || body === null) return false;
  const envelope = body as Record<string, unknown>;
  const data = envelope['data'];
  return (
    envelope['status'] === response.status &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data)
  );
}

/**
 * Refused before any handler could run: authentication, the owner precondition, CSRF
 * or step-up. The only failures a late answer may report as "not run".
 */
function isPreHandlerRefusal(error: HttpErrorResponse): boolean {
  if (error.status === 401) return true;
  if (readOwnerRefusal(error) !== null) return true;
  const detail = extractDetail(error);
  return (
    error.status === 403 &&
    detail !== null &&
    (detail.startsWith(CSRF_FAILURE_DETAIL_PREFIX) || detail === ELEVATION_REQUIRED_DETAIL)
  );
}

/**
 * Any response at all clears an unavailable state — which is what makes the shell's
 * outage banner self-healing rather than something the operator has to dismiss and
 * then wonder about. Setting a signal to the value it already holds notifies nothing,
 * so this costs nothing on the ordinary path.
 */
function reachableOnResponse(
  status: AdminServiceStatus,
): MonoTypeOperatorFunction<HttpEvent<unknown>> {
  return tap((event) => {
    if (event.type === HttpEventType.Response) status.markReachable();
  });
}

/** Compare a request URL to a known auth route, ignoring any query string. */
function isRoute(request: HttpRequest<unknown>, route: string): boolean {
  const path = request.url.split('?')[0].split('#')[0];
  return path === apiUrl(route);
}

function isDefect(status: number): boolean {
  // A dead network is a defect by any measure, and returning false for it was a real
  // hole: nothing reported it whether or not suppression was lifted. The transport
  // precondition now claims status 0 before it can reach here, so this is a backstop
  // — if that precondition is ever narrowed, a dead network must not quietly become a
  // non-defect a second time.
  if (status === 0) return true;
  if (status >= 500) return true;
  if (status >= 400) return !EXPECTED_CLIENT_STATUSES.has(status);
  return false;
}
