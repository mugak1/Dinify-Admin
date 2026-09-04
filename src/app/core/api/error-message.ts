import { HttpErrorResponse } from '@angular/common/http';

/**
 * THE error-message extractor. Every error path in this application uses it.
 *
 * WHY IT EXISTS. The admin plane has no custom DRF `EXCEPTION_HANDLER` — verified by
 * grep across the backend during recon — so two response shapes coexist and neither
 * is going away on its own:
 *
 *   {"detail": "..."}                        everything DRF raises: authentication
 *                                            failures, permission denials, throttles
 *   {"status": 401, "message": "..."}        every hand-written endpoint denial in
 *                                            platform_admin_app/endpoints/auth.py
 *
 * A screen that reads only one of them shows a blank error for half the failures in
 * the system. Without a shared function every screen from step 1 onward reinvents
 * this, and they diverge.
 *
 * TODO(backend): a follow-up PR should normalise the envelope and add stable
 * machine-readable error codes. When it lands, this collapses to reading one field,
 * and the prose match strings in api.constants.ts stop being load-bearing.
 */

/** Read the human-readable message out of any admin-plane error response. */
export function extractErrorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  return readMessage(unwrap(error)) ?? fallback;
}

/**
 * Get to the response BODY, whatever is carrying it.
 *
 * Order matters. An error object with an `error` property is unwrapped BEFORE the
 * plain-`Error` check, because the development mock throws an `Error` subclass that
 * carries the server-shaped body on `.error` — checking `instanceof Error` first
 * would surface its internal `"Mock HTTP 401"` message instead of the
 * `"Invalid credentials."` the operator is supposed to read.
 *
 * A plain `Error` yields NOTHING, deliberately. Its `message` is an internal
 * programming detail — a TypeError from a bad property access is not a sentence to
 * put in front of an operator, and the generic fallback is more honest.
 */
function unwrap(error: unknown): unknown {
  if (error instanceof HttpErrorResponse) return error.error;
  if (isRecord(error) && 'error' in error) return error['error'];
  if (error instanceof Error) return null;
  return error;
}

/**
 * The DRF `detail` field alone, or null.
 *
 * The error CLASSIFIER must key on this and never on `message`: the 403 that
 * `auth/elevate/` returns for a bad code is `{"status": 403, "message": "Invalid or
 * expired verification."}`, and it must not be mistaken for either of the `detail`
 * carrying 403s (elevation-required, CSRF failure). Separating the two readers is
 * what makes that impossible rather than merely unlikely.
 */
export function extractDetail(error: unknown): string | null {
  const body = unwrap(error);
  if (!isRecord(body)) return null;
  const detail = body['detail'];
  return typeof detail === 'string' ? detail : null;
}

/**
 * The server's PER-FIELD validation errors, keyed by request-body field name.
 *
 * A 400 from an elevated commercial write carries `{"errors": {"reason": ["Please
 * state a reason of at least 10 characters."]}}` — DRF's serializer errors, or the
 * domain's own single-field refusal. Rendering that beside the field it names is the
 * difference between an operator fixing their reason and an operator staring at one
 * flattened sentence wondering which control it belongs to.
 *
 * `extractErrorMessage` FLATTENS the same structure into one line, and that stays the
 * right answer for a banner. This is the narrower reader for a FORM, and the two are
 * kept separate for the same reason `extractDetail` is separate: a caller should have
 * to say which shape it wants rather than get whichever the flattener happened to pick.
 *
 * Returns an empty object when the body carries no field errors — including for the
 * 409 conflict body, which deliberately has no `errors` key at all.
 */
export function extractFieldErrors(error: unknown): Record<string, readonly string[]> {
  const body = unwrap(error);
  if (!isRecord(body)) return {};
  const errors = body['errors'];
  if (!isRecord(errors)) return {};

  const out: Record<string, readonly string[]> = {};
  for (const [field, value] of Object.entries(errors)) {
    const messages = toMessages(value);
    if (messages.length) out[field] = messages;
  }
  return out;
}

/**
 * The server's per-field validation errors for a NESTED request body, keyed by dotted
 * path.
 *
 * The creation endpoint's body is nested — `{restaurant: {…}, owner: {…}, reason}` —
 * and DRF nests its errors the same way: `{"owner": {"phone_number": ["…"]}}`. The
 * backend deliberately shapes a DOMAIN refusal on the same field identically, so one
 * field never has two error shapes depending on which layer refused it. This reader
 * flattens that tree to `owner.phone_number` so a form can hang each message on the
 * control it names; a top-level list (`reason`, `__all__`) keeps its plain key, so for
 * a flat body it agrees exactly with `extractFieldErrors`.
 *
 * Kept separate from `extractFieldErrors` rather than folded into it: the flat reader
 * is what the commercial forms assert against, and widening its output keys would
 * silently change what those specs pin.
 */
export function extractNestedFieldErrors(error: unknown): Record<string, readonly string[]> {
  const body = unwrap(error);
  if (!isRecord(body)) return {};
  const errors = body['errors'];
  if (!isRecord(errors)) return {};

  const out: Record<string, readonly string[]> = {};
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [field, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${field}` : field;
      if (isRecord(value)) {
        walk(value, path);
        continue;
      }
      const messages = toMessages(value);
      if (messages.length) out[path] = messages;
    }
  };
  walk(errors, '');
  return out;
}

/** One field's errors as a flat string list. DRF sends `string | string[]`. */
function toMessages(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toMessages(entry));
  }
  return [];
}

function readMessage(body: unknown): string | null {
  if (typeof body === 'string') {
    // A non-JSON body (an Apache error page, a proxy failure). Prose only — an HTML
    // document is worse than the fallback.
    const trimmed = body.trim();
    return trimmed && !trimmed.startsWith('<') ? trimmed : null;
  }
  if (!isRecord(body)) return null;

  // `detail` first: it is what DRF produces, and DRF produces most failures.
  const fromDetail = flatten(body['detail']);
  if (fromDetail) return fromDetail;

  // Then `message`: the hand-written endpoint denials.
  const fromMessage = flatten(body['message']);
  if (fromMessage) return fromMessage;

  // Then field errors — the shape a serializer or the lifecycle service produces
  // (`{"errors": {"to_state": "...", "blockers": [...]}}`).
  const errors = body['errors'];
  if (isRecord(errors)) {
    const parts = Object.values(errors).map(flatten).filter((part): part is string => !!part);
    if (parts.length) return parts.join(' ');
  }

  return null;
}

/** Collapse DRF's string | string[] | {field: string[]} error values to one line. */
function flatten(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map(flatten).filter((part): part is string => !!part);
    return parts.length ? parts.join(' ') : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
