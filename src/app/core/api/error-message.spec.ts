import { HttpErrorResponse } from '@angular/common/http';

import { ELEVATION_REQUIRED_DETAIL } from './api.constants';
import { extractDetail, extractErrorMessage, extractNestedFieldErrors } from './error-message';

function httpError(status: number, body: unknown): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: body });
}

/**
 * The admin plane has no custom DRF exception handler, so two body shapes coexist and
 * a reader that knows only one of them shows a blank error for half the failures in
 * the system.
 */
describe('extractErrorMessage', () => {
  it('reads the DRF `detail` shape', () => {
    expect(extractErrorMessage(httpError(401, { detail: 'Invalid or expired admin session.' }))).toBe(
      'Invalid or expired admin session.',
    );
  });

  it('reads the hand-written `{status, message}` shape', () => {
    expect(extractErrorMessage(httpError(401, { status: 401, message: 'Invalid credentials.' }))).toBe(
      'Invalid credentials.',
    );
  });

  it('prefers `detail` when a body somehow carries both', () => {
    expect(
      extractErrorMessage(httpError(403, { detail: 'from detail', status: 403, message: 'from message' })),
    ).toBe('from detail');
  });

  it('flattens the lifecycle service\'s field-error shape', () => {
    const body = {
      status: 400,
      message: 'This transition was refused.',
      errors: { to_state: 'A restaurant cannot move from live to live.' },
    };
    // `message` wins — it is the sentence written for a human.
    expect(extractErrorMessage(httpError(400, body))).toBe('This transition was refused.');
  });

  it('falls back to field errors when there is no message', () => {
    const body = { errors: { to_state: 'Not ready to go live.', blockers: ['readiness_not_configured'] } };
    expect(extractErrorMessage(httpError(400, body))).toBe(
      'Not ready to go live. readiness_not_configured',
    );
  });

  it('reads a plain-text body but refuses an HTML one', () => {
    expect(extractErrorMessage(httpError(502, 'upstream unavailable'))).toBe('upstream unavailable');
    // An Apache error page is worse than the fallback.
    expect(extractErrorMessage(httpError(502, '<html><body>502</body></html>'))).toBe(
      'Something went wrong.',
    );
  });

  it('falls back for a null, empty or unrecognised body', () => {
    expect(extractErrorMessage(httpError(500, null))).toBe('Something went wrong.');
    expect(extractErrorMessage(httpError(500, {}))).toBe('Something went wrong.');
    expect(extractErrorMessage(httpError(500, { unexpected: true }), 'custom')).toBe('custom');
  });

  it('handles a non-HTTP error without throwing', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('Something went wrong.');
    expect(extractErrorMessage(undefined)).toBe('Something went wrong.');
  });
});

/**
 * `extractNestedFieldErrors` reads the creation endpoint's NESTED field errors — DRF
 * nests them the way the request was nested (`{"owner": {"phone_number": [...]}}`) —
 * and flattens them to the dotted paths the creation form addresses its controls by.
 * The flat `extractFieldErrors` stays as it is for every flat-body endpoint.
 */
describe('extractNestedFieldErrors', () => {
  it('flattens a nested owner error to its dotted path', () => {
    const body = {
      status: 400,
      message: 'The restaurant could not be created.',
      errors: { owner: { phone_number: ['Cannot canonicalise phone number (7 digits).'] } },
    };
    expect(extractNestedFieldErrors(httpError(400, body))).toEqual({
      'owner.phone_number': ['Cannot canonicalise phone number (7 digits).'],
    });
  });

  it('keeps top-level fields at their own name, beside the nested ones', () => {
    const body = {
      errors: {
        restaurant: { name: ['This field may not be blank.'], is_test: ['Send true or false.'] },
        owner: { mode: ['"both" is not a valid choice.'] },
        reason: ['Please state a reason of at least 10 characters.'],
        __all__: ['Something about the whole request.'],
      },
    };
    expect(extractNestedFieldErrors(httpError(400, body))).toEqual({
      'restaurant.name': ['This field may not be blank.'],
      'restaurant.is_test': ['Send true or false.'],
      'owner.mode': ['"both" is not a valid choice.'],
      reason: ['Please state a reason of at least 10 characters.'],
      __all__: ['Something about the whole request.'],
    });
  });

  it('coerces a lone string to a one-message list, as the flat reader does', () => {
    const body = { errors: { owner: { user_id: 'Enter a valid UUID.' } } };
    expect(extractNestedFieldErrors(httpError(400, body))).toEqual({
      'owner.user_id': ['Enter a valid UUID.'],
    });
  });

  it('returns nothing for a body with no field errors, or no body at all', () => {
    expect(extractNestedFieldErrors(httpError(409, { status: 409, message: 'Conflict.' }))).toEqual({});
    expect(extractNestedFieldErrors(httpError(500, null))).toEqual({});
    expect(extractNestedFieldErrors(new Error('boom'))).toEqual({});
    expect(extractNestedFieldErrors(undefined)).toEqual({});
  });
});

/**
 * `extractDetail` is deliberately narrower than `extractErrorMessage`, and the
 * classifier uses IT. That separation is what makes the three 403s impossible to
 * confuse rather than merely unlikely to be confused.
 */
describe('extractDetail', () => {
  it('returns the `detail` string when present', () => {
    expect(extractDetail(httpError(403, { detail: ELEVATION_REQUIRED_DETAIL }))).toBe(
      ELEVATION_REQUIRED_DETAIL,
    );
  });

  it('returns null for the `{status, message}` shape, so a message can never be classified', () => {
    // This is the elevate/ bad-code 403. If it read as a `detail`, a wrong TOTP code
    // would be classified as "this action needs elevation" and loop the operator.
    expect(
      extractDetail(httpError(403, { status: 403, message: 'Invalid or expired verification.' })),
    ).toBeNull();
  });

  it('returns null for a non-string detail', () => {
    expect(extractDetail(httpError(400, { detail: { nested: true } }))).toBeNull();
    expect(extractDetail(httpError(400, { detail: ['a', 'b'] }))).toBeNull();
  });
});
