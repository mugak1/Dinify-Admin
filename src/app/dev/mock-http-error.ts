import { REQUEST_ID_HEADER } from '../core/api/api.constants';

/**
 * The shape a mocked failure arrives in. DEVELOPMENT ONLY.
 *
 * Shaped enough like `HttpErrorResponse` for `extractErrorMessage` and
 * `classifyTransportFailure` to read it, without pretending to be one — nothing in
 * mock mode goes near `HttpClient`, so NO INTERCEPTOR RUNS. That is the whole point:
 * anything in this application that branches on the SHAPE of an error must duck-type,
 * or the branch is dead code in the one mode this work is reviewed in before a deploy.
 *
 * Shared by both mock transports so there is exactly one answer to "what does a
 * mocked failure look like", and so a fix to one is a fix to both.
 */
export class MockHttpError extends Error {
  /**
   * Only present when the mocked failure actually reached a server. Shaped enough like
   * `HttpHeaders` for `extractRequestId` to read it, so the "quote this when reporting
   * it" path is reviewable too.
   */
  readonly headers?: { get(name: string): string | null };

  constructor(
    readonly status: number,
    readonly error: unknown,
    requestId?: string,
  ) {
    super(`Mock HTTP ${status}`);
    this.name = 'MockHttpError';
    if (requestId) {
      this.headers = { get: (name: string) => (name === REQUEST_ID_HEADER ? requestId : null) };
    }
  }
}
