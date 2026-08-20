import {
  HttpErrorResponse,
  HttpEvent,
  HttpEventType,
  HttpHandlerFn,
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { MonoTypeOperatorFunction, Observable, catchError, switchMap, tap, throwError } from 'rxjs';

import { ADMIN_AUTH } from '../auth/admin-auth.api';
import { ElevationService } from '../auth/elevation.service';
import { SessionStore } from '../auth/session.store';
import {
  apiUrl,
  AUTH_ROUTES,
  CSRF_FAILURE_DETAIL_PREFIX,
  ELEVATION_REQUIRED_DETAIL,
} from './api.constants';
import { DefectService } from './defect.service';
import { extractDetail, extractErrorMessage } from './error-message';
import { CSRF_RETRIED, ELEVATION_REPLAYED, SUPPRESS_DEFECT_REPORT } from './http-context';
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
 *   2. 403 carrying the CSRF message — THE TOKEN IS STALE. `verify/` ROTATES the CSRF
 *      secret, so another tab signing in invalidates this one's. Re-bootstrap ONCE
 *      with GET /auth/session/ (which ENSURES rather than rotates, so it cannot
 *      invalidate anyone else's), retry ONCE, then hard-fail as a defect. Not an
 *      infinite retry.
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
 */
export const errorClassifierInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const store = inject(SessionStore);
  const elevation = inject(ElevationService);
  const defects = inject(DefectService);
  const status = inject(AdminServiceStatus);
  const auth = inject(ADMIN_AUTH);

  const classify = (
    request: HttpRequest<unknown>,
    error: unknown,
  ): Observable<HttpEvent<unknown>> => {
    if (!(error instanceof HttpErrorResponse)) return throwError(() => error);

    const detail = extractDetail(error);
    const requestId = extractRequestId(error);

    // --- PRECONDITION: DID WE GET A USABLE RESPONSE AT ALL? ------------------------
    // Above the four cases, not among them. See the class comment.
    if (classifyTransportFailure(error) === 'unavailable') {
      status.reportUnavailable(requestId);
      return throwError(() => error);
    }

    // --- CASE 1 --------------------------------------------------------------------
    if (error.status === 401) {
      // A 401 from login/ or verify/ is a REJECTED CREDENTIAL, not a lost session. The
      // form renders the server's message; redirecting to the page the operator is
      // already looking at would wipe what they typed for no reason.
      if (isRoute(request, AUTH_ROUTES.login) || isRoute(request, AUTH_ROUTES.verify)) {
        return throwError(() => error);
      }

      const wasAuthenticated = store.isAuthenticated();
      store.clear();

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
      return auth.readSession().pipe(
        tap((session) => store.adopt(session)),
        switchMap(() => replay(retried, next, classify, status)),
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
      return elevation.request().pipe(switchMap(() => replay(replayed, next, classify, status)));
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

  return next(req).pipe(
    reachableOnResponse(status),
    catchError((error: unknown) => classify(req, error)),
  );
};

/** Re-issue a request and classify ITS failure too, so every recovery stays bounded. */
function replay(
  request: HttpRequest<unknown>,
  next: HttpHandlerFn,
  classify: (request: HttpRequest<unknown>, error: unknown) => Observable<HttpEvent<unknown>>,
  status: AdminServiceStatus,
): Observable<HttpEvent<unknown>> {
  return next(request).pipe(
    reachableOnResponse(status),
    catchError((error: unknown) => classify(request, error)),
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
