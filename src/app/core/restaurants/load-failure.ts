import { AdminServiceStatus } from '../api/service-status';
import { extractErrorMessage } from '../api/error-message';
import { classifyTransportFailure, extractRequestId } from '../api/transport-failure';

/**
 * A read that failed, in the terms a screen has to render it in.
 *
 * ── WHY THIS IS NOT JUST `catch (e) { rows = [] }` ────────────────────────────────
 *
 * LOADING, FAILED and EMPTY are three different facts and must never look alike. An
 * empty directory says "the portfolio contains nothing matching" — a real answer an
 * operator will act on. A failed one says nothing at all. Collapsing the second into
 * the first is the same class of defect as a dead backend presenting as "Invalid
 * credentials.": a confident statement about something the application does not know.
 *
 * ── AND WHY IT REPORTS TO `AdminServiceStatus` ITSELF ─────────────────────────────
 *
 * `errorClassifierInterceptor` already raises the outage state for a 5xx or a dead
 * socket — but ONLY on the real transport. MOCK MODE NEVER TOUCHES `HttpClient`, so no
 * interceptor runs there and the outage banner would never appear for a mocked
 * failure. This is the same reason `AdminAuthService.bootstrap()` and
 * `ElevationService.submit()` classify directly, and it is why the shared
 * `classifyTransportFailure` is used rather than a second implementation: an
 * `instanceof HttpErrorResponse` check here would be dead code in the one mode this
 * work gets reviewed in before a deploy.
 *
 * Reporting twice on the real path is harmless — `reportUnavailable` sets a signal,
 * and setting it to what it already holds notifies nothing.
 */
export type LoadFailureKind =
  /** No usable answer: status 0, any 5xx. The outage state is raised alongside. */
  | 'unavailable'
  /** The server answered 404. For a detail read this is a real, renderable outcome. */
  | 'not-found'
  /** The server answered something else — a 400, a 403, a parse failure. */
  | 'other';

export interface LoadFailure {
  readonly kind: LoadFailureKind;
  /** The server's own words where it had any, via the one shared extractor. */
  readonly message: string;
  /** `X-Request-ID` — the correlation key into `AdminAuditLog`. Null when absent. */
  readonly requestId: string | null;
}

/**
 * Classify a failed restaurant read and, when it means the plane is unreachable, say
 * so through the service-status signal the shell's outage banner already watches.
 *
 * `status` is passed in rather than injected so this stays a pure function of its
 * arguments and can be tested without a TestBed.
 */
export function toLoadFailure(
  error: unknown,
  status: AdminServiceStatus,
  fallback = 'This could not be loaded.',
): LoadFailure {
  const requestId = extractRequestId(error);
  const transport = classifyTransportFailure(error);

  if (transport === 'unavailable') {
    status.reportUnavailable(requestId);
    return {
      kind: 'unavailable',
      message: 'The admin service is not answering.',
      requestId,
    };
  }

  // The server spoke, so it is reachable — being told "no" is being told something.
  status.markReachable();

  return {
    kind: readStatus(error) === 404 ? 'not-found' : 'other',
    message: extractErrorMessage(error, fallback),
    requestId,
  };
}

/** Duck-typed, for the same reason `classifyTransportFailure` is. */
function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)['status'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
