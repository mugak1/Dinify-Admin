import { REQUEST_ID_HEADER } from './api.constants';

/**
 * DID WE GET A USABLE RESPONSE AT ALL? — the question that comes BEFORE "what did the
 * server say".
 *
 * ── WHY THIS IS A SEPARATE, PURE FUNCTION ─────────────────────────────────────────
 *
 * Two callers need the same answer and only one of them sits behind `HttpClient`:
 *
 *   - `errorClassifierInterceptor`, as a PRECONDITION above its four cases. None of
 *     401 / elevation / CSRF can apply when the answer is "no response", so the
 *     transport question is prior to all of them rather than a fifth sibling.
 *   - `AdminAuthService.bootstrap()`, directly — because MOCK MODE NEVER TOUCHES
 *     `HttpClient`, so no interceptor runs there and a failure would otherwise reach
 *     nobody. Mock mode is how this work gets reviewed; a feature that is dead there
 *     is a feature nobody sees before the deploy.
 *
 * Keeping it out of the classifier also keeps it available to step 1: unavailability
 * is a TRANSPORT concern, not an authentication one. A directory that rebuilds this
 * inline will eventually render "no restaurants" for a backend that is simply down.
 *
 * ── IT DUCK-TYPES `status`, AND MUST ──────────────────────────────────────────────
 *
 * NEVER `instanceof HttpErrorResponse`. `MockAdminAuthApi` throws `MockHttpError`,
 * which extends `Error` and carries `status` — an instanceof check would make every
 * branch below dead code in the one mode anyone can review it in. The same applies to
 * anything else in this repo that ever branches on the SHAPE of an error.
 */
export type TransportFailure =
  /** No response, or one that cannot be believed: status 0, 5xx, or an unusable 2xx. */
  | 'unavailable'
  /** The server answered and refused the credential: 401. */
  | 'denied'
  /** The server answered something this function has no opinion about. */
  | 'other';

/**
 * A 2xx whose body is not the thing it claimed to be.
 *
 * A service that answers 200 with something that is not a session is in the SAME
 * ACTIONABLE STATE as one that does not answer: the operator cannot proceed, and
 * retrying or reporting it are the only moves. Treating it as "signed out" — which is
 * what a bare catch does — is a confident false statement about their credentials.
 */
export class IncoherentResponseError extends Error {
  readonly incoherent = true;

  constructor(readonly requestId: string | null = null) {
    super('The admin service answered with something that is not a session.');
    this.name = 'IncoherentResponseError';
  }
}

/** Classify what a failed request tells us about the service, not about the operator. */
export function classifyTransportFailure(error: unknown): TransportFailure {
  if (isRecord(error) && error['incoherent'] === true) return 'unavailable';

  const status = readStatus(error);

  // No status at all: a programming error, a cancelled subscription, an
  // `ElevationCancelledError`. Nothing here licenses a claim about the service.
  if (status === null) return 'other';

  // 0 is Angular's status for a request that never got an answer — DNS, TLS,
  // connection refused, the proxy, a dropped network.
  if (status === 0) return 'unavailable';

  // 5xx: Apache is up and the admin WSGI app is not, or it raised. The server spoke,
  // but not usefully, and no operator action can resolve it from this side.
  if (status >= 500) return 'unavailable';

  // A 2xx that reached an error path at all means the BODY failed to parse. Angular
  // keeps the original status and reports a parse failure as an error response.
  if (status >= 200 && status < 300) return 'unavailable';

  // 401 is the one refusal this application acts on globally: the session is gone, or
  // the credential was wrong. Which of the two is the caller's business, not ours.
  if (status === 401) return 'denied';

  return 'other';
}

/**
 * The `X-Request-ID` a failure carries, or null.
 *
 * `X-Request-ID` is the only header the admin plane adds (`platform_admin_app/
 * middleware.py`), a server-generated uuid4, and the correlation key into the
 * append-only `AdminAuditLog`. A failure the operator can see is worth far more with
 * it than without.
 *
 * Duck-typed for the same reason as `classifyTransportFailure`, and it reads a plain
 * `requestId` property as well so an error this application raised itself (see
 * `IncoherentResponseError`) can carry one too.
 */
export function extractRequestId(error: unknown): string | null {
  if (!isRecord(error)) return null;

  const headers = error['headers'];
  if (isRecord(headers) && typeof headers['get'] === 'function') {
    const value = (headers as { get(name: string): string | null }).get(REQUEST_ID_HEADER);
    if (typeof value === 'string' && value) return value;
  }

  const direct = error['requestId'];
  return typeof direct === 'string' && direct ? direct : null;
}

function readStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const status = error['status'];
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

/** Deliberately permissive: an `Error` SUBCLASS carrying `status` must pass. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
