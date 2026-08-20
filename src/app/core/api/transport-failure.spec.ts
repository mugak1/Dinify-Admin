import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';

import { REQUEST_ID_HEADER } from './api.constants';
import {
  classifyTransportFailure,
  extractRequestId,
  IncoherentResponseError,
} from './transport-failure';

/** Exactly the shape `MockAdminAuthApi` throws: an Error SUBCLASS carrying `status`. */
class MockLikeError extends Error {
  constructor(
    readonly status: number,
    readonly error: unknown = null,
  ) {
    super(`Mock HTTP ${status}`);
  }
}

describe('classifyTransportFailure', () => {
  it('calls a request that never got an answer unavailable', () => {
    // Angular reports status 0 for DNS, TLS, connection refused, a dropped network.
    expect(classifyTransportFailure(new HttpErrorResponse({ status: 0 }))).toBe('unavailable');
  });

  it('calls every 5xx unavailable', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyTransportFailure(new HttpErrorResponse({ status })))
        .withContext(String(status))
        .toBe('unavailable');
    }
  });

  it('calls a 2xx that reached an error path unavailable', () => {
    // Angular keeps the original status and reports a parse failure as an error, so a
    // 200 arriving HERE means the body could not be believed.
    expect(classifyTransportFailure(new HttpErrorResponse({ status: 200 }))).toBe('unavailable');
  });

  it('calls a body that is not a session unavailable', () => {
    // A service answering 200 with something that is not a session is in the same
    // actionable state as one not answering.
    expect(classifyTransportFailure(new IncoherentResponseError())).toBe('unavailable');
  });

  it('calls 401 denied, and nothing else', () => {
    expect(classifyTransportFailure(new HttpErrorResponse({ status: 401 }))).toBe('denied');
    for (const status of [400, 403, 404, 409, 422, 429]) {
      expect(classifyTransportFailure(new HttpErrorResponse({ status })))
        .withContext(String(status))
        .toBe('other');
    }
  });

  it('claims nothing about a failure with no status', () => {
    // A programming error or a cancelled subscription licenses no statement about the
    // service. Guessing here would put an outage banner in front of a TypeError.
    expect(classifyTransportFailure(new Error('boom'))).toBe('other');
    expect(classifyTransportFailure(null)).toBe('other');
    expect(classifyTransportFailure('nope')).toBe('other');
    expect(classifyTransportFailure({ status: 'five hundred' })).toBe('other');
  });

  it('DUCK-TYPES, so mock-mode failures classify exactly like real ones', () => {
    // THE RULE: never `instanceof HttpErrorResponse`. `MockAdminAuthApi` throws an
    // Error subclass, and an instanceof check would make every branch above dead code
    // in the one mode this work gets reviewed in before the deploy exists.
    expect(classifyTransportFailure(new MockLikeError(0))).toBe('unavailable');
    expect(classifyTransportFailure(new MockLikeError(502))).toBe('unavailable');
    expect(classifyTransportFailure(new MockLikeError(401))).toBe('denied');
    expect(classifyTransportFailure(new MockLikeError(403))).toBe('other');
  });
});

describe('extractRequestId', () => {
  it('reads the one header the admin plane adds', () => {
    const error = new HttpErrorResponse({
      status: 502,
      headers: new HttpHeaders({ [REQUEST_ID_HEADER]: 'req-1' }),
    });
    expect(extractRequestId(error)).toBe('req-1');
  });

  it('reads a headers-shaped stand-in, for the same duck-typing reason', () => {
    const error = {
      status: 502,
      headers: { get: (name: string) => (name === REQUEST_ID_HEADER ? 'req-mock' : null) },
    };
    expect(extractRequestId(error)).toBe('req-mock');
  });

  it('reads a plain requestId property, so an error raised here can carry one', () => {
    expect(extractRequestId(new IncoherentResponseError('req-2'))).toBe('req-2');
  });

  it('is null when there is nothing to quote', () => {
    // A request that never reached the server has no id, and inventing one would point
    // a bug report at a log line that does not exist.
    expect(extractRequestId(new HttpErrorResponse({ status: 0 }))).toBeNull();
    expect(extractRequestId(new Error('boom'))).toBeNull();
    expect(extractRequestId(undefined)).toBeNull();
  });
});
