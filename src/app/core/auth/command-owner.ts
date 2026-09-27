/**
 * THE COMMAND OWNER (D10): which administrator issued a command, and in which admin
 * session.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────
 *
 * A matched CSRF pair shows that a request came from this origin. It does NOT show
 * which admin session a command was issued under, and on this plane the two come
 * apart. `GET /auth/session/` calls Django's `get_token()`, which RE-EMITS whatever
 * CSRF secret the request carried. So a `session/` response sent before another
 * sign-in and delivered after it puts the old CSRF cookie back beside the new session
 * cookie, and a tab still holding the old token passes CSRF as whoever signed in
 * since. A second sign-in by the SAME administrator has the same shape with nothing
 * about CSRF stale at all. Rotation at `verify/` gives each sign-in a fresh secret; it
 * does not bind that secret to a session.
 *
 * ── THE CONTRACT (backend `platform_admin_app/command_owner.py`, D10 B1) ──────────
 *
 * `verify/` and `session/` publish `command_owner = {version: 1, actor, session}`:
 * the `User.pk` and the `AdminSession.id`, both lowercase canonical UUIDs. Neither is
 * a credential — nothing on the server resolves a session by its id, and the token and
 * its hash are never published. An unsafe request may send
 *
 *     X-Admin-Command-Owner: 1;<actor>;<session>
 *
 * and the server refuses it, BEFORE CSRF, permissions, factor evaluation or the
 * handler, unless it names the session that authenticated it:
 *
 *     header cannot be read                   400  admin_command_owner_malformed
 *     names a different administrator         409  admin_command_actor_changed
 *     same administrator, different session  409  admin_command_session_changed
 *
 * An ABSENT header is the legacy contract and is not checked, which is why this client
 * never sends a guarded write without one (see `errorClassifierInterceptor`).
 *
 * ── WHAT THIS MODULE HOLDS ────────────────────────────────────────────────────────
 *
 * The strict reader for the published owner, the header format, the exact reader for
 * the three refusals, and the typed outcomes a command can end in. The owner is kept
 * in memory only (`SessionStore`); it is never persisted, logged or put in a URL.
 */

export const COMMAND_OWNER_VERSION = 1;
export const COMMAND_OWNER_HEADER = 'X-Admin-Command-Owner';

export interface CommandOwner {
  readonly version: 1;
  /** `User.pk`. Immutable for an account. */
  readonly actor: string;
  /** `AdminSession.id`. New at every sign-in. */
  readonly session: string;
}

/**
 * The owner and the local lifecycle a command was ISSUED under. Captured once, before
 * the first send, and never rewritten by a retry, a replay or a later failure.
 */
export interface IssuedUnder {
  readonly owner: CommandOwner | null;
  readonly lifecycle: number;
}

export type OwnerReading =
  | { readonly kind: 'owner'; readonly owner: CommandOwner }
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_KEYS = ['actor', 'session', 'version'];

/**
 * Read `command_owner` off a `session/` or `verify/` body. STRICT: the object must
 * carry exactly `version`, `actor` and `session`; the version must be the number 1;
 * both ids must be lowercase canonical UUIDs. Anything else PRESENT is `malformed` and
 * nothing is normalised — every repair rule would be a second way to spell an owner
 * the server never published. A body without the key is `absent`: a server that does
 * not publish the capability.
 */
export function readCommandOwner(body: unknown): OwnerReading {
  if (!isRecord(body) || !('command_owner' in body)) return { kind: 'absent' };
  const raw = body['command_owner'];
  if (!isRecord(raw) || Array.isArray(raw)) return { kind: 'malformed' };
  const keys = Object.keys(raw).sort();
  if (keys.length !== OWNER_KEYS.length || keys.some((key, i) => key !== OWNER_KEYS[i])) {
    return { kind: 'malformed' };
  }
  const { version, actor, session } = raw;
  if (version !== COMMAND_OWNER_VERSION) return { kind: 'malformed' };
  if (typeof actor !== 'string' || !UUID.test(actor)) return { kind: 'malformed' };
  if (typeof session !== 'string' || !UUID.test(session)) return { kind: 'malformed' };
  return { kind: 'owner', owner: { version: COMMAND_OWNER_VERSION, actor, session } };
}

export function formatCommandOwner(owner: CommandOwner): string {
  return `${COMMAND_OWNER_VERSION};${owner.actor};${owner.session}`;
}

export type OwnerChange = 'same' | 'actor-changed' | 'session-changed';

/**
 * The actor comparison CLASSIFIES and the session comparison is what proves identity:
 * a session id is unique, so equal sessions are the same owner. A different actor is
 * reported as such because "someone else is signed in" and "you signed in again" call
 * for different sentences.
 */
export function compareOwners(issued: CommandOwner, current: CommandOwner): OwnerChange {
  if (issued.actor !== current.actor) return 'actor-changed';
  if (issued.session !== current.session) return 'session-changed';
  return 'same';
}

export type OwnerRefusal = 'owner-malformed' | 'actor-changed' | 'session-changed';

/** The three refusals, keyed by their machine code, with the only status each has. */
const REFUSALS: Readonly<Record<string, { status: number; refusal: OwnerRefusal }>> = {
  admin_command_owner_malformed: { status: 400, refusal: 'owner-malformed' },
  admin_command_actor_changed: { status: 409, refusal: 'actor-changed' },
  admin_command_session_changed: { status: 409, refusal: 'session-changed' },
};

/**
 * Is this failure the server's owner precondition, EXACTLY as B1 renders it?
 *
 * The body must be `{detail: <string>, code: <one of the three>}` and nothing else,
 * and the status must be the one that code is sent with. A domain 409 (a stale
 * concurrency token, an invitation that moved) carries a different code and is never
 * read as an ownership change: that would cross a session boundary for an ordinary
 * conflict. Duck-typed, like `classifyTransportFailure`, so the development mock's
 * error shape reads the same way.
 */
export function readOwnerRefusal(error: unknown): OwnerRefusal | null {
  if (!isRecord(error)) return null;
  const status = error['status'];
  const body = error['error'];
  if (typeof status !== 'number' || !isRecord(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'code' || keys[1] !== 'detail') return null;
  if (typeof body['detail'] !== 'string' || typeof body['code'] !== 'string') return null;
  const entry = REFUSALS[body['code']];
  return entry && entry.status === status ? entry.refusal : null;
}

// ── OUTCOMES ──────────────────────────────────────────────────────────────────────
//
// Each carries `error: {detail}`, so every consumer's existing `extractErrorMessage`
// fallback renders its sentence. None carries a response body, a claim code or a
// credential: only fixed copy and, where one existed, the non-sensitive request id.

/** Why a command was not run. Every reason is a statement that nothing was executed. */
export type NotRunReason =
  | 'actor-changed'
  | 'session-changed'
  | 'owner-malformed'
  | 'binding-unsupported'
  | 'no-session'
  | 'session-ended'
  | 'continuity-unconfirmed'
  | 'owner-unknown';

const NOT_RUN_COPY: Readonly<Record<NotRunReason, string>> = {
  'actor-changed':
    'This browser is now signed in as a different administrator. This command was not run.',
  'session-changed':
    'A new admin session has started in this browser since this command was issued. This command was not run.',
  'owner-malformed':
    'This command could not be tied to its admin session, so it was not run.',
  'binding-unsupported':
    'This admin service cannot confirm which session a command belongs to, so changes are disabled in this tab. This command was not run.',
  'no-session': 'There is no admin session in this tab. This command was not run.',
  'session-ended':
    'The admin session this command belonged to has ended in this tab. This command was not run.',
  'continuity-unconfirmed':
    'This tab could not confirm that its admin session is still current, so this command was not run.',
  'owner-unknown':
    'This tab could not name the admin session to end, so no sign-out request was sent.',
};

/**
 * REFUSED BEFORE EXECUTION. Either this client did not send it (`sent: false`), or the
 * server refused it before any handler ran (`sent: true`) — its owner precondition,
 * CSRF, authentication or step-up. This is the one outcome allowed to say "not run".
 *
 * It deliberately carries no `status`, so a consumer that branches on status reaches
 * its general branch, which renders the sentence and keeps the operator's draft.
 */
export class CommandNotRunError extends Error {
  readonly executed = false;
  readonly error: { readonly detail: string };

  constructor(
    readonly reason: NotRunReason,
    readonly sent: boolean,
  ) {
    super(NOT_RUN_COPY[reason]);
    this.name = 'CommandNotRunError';
    this.error = { detail: NOT_RUN_COPY[reason] };
  }
}

/**
 * THE SERVER ANSWERED WITH A WELL-FORMED SUCCESS, after the local lifecycle the
 * command belonged to had ended. The answer is not delivered — a claim code or a
 * projection minted for one session must never render under another — and the command
 * is never re-sent. It says what the server reported, nothing more.
 */
export class CommandResultWithheldError extends Error {
  readonly error = {
    detail:
      'The admin service reported this command as completed, but its admin session has since ended in this tab, so the result is not shown here.',
  };

  constructor(readonly requestId: string | null = null) {
    super('Command result withheld: its session ended in this tab.');
    this.name = 'CommandResultWithheldError';
  }
}

/**
 * DISPATCHED, AND THE ANSWER IS MISSING, UNREADABLE OR INCONCLUSIVE — and the local
 * lifecycle it belonged to has since ended. Never "nothing changed", never re-sent.
 *
 * `incoherent` is set so every consumer's existing INDETERMINATE branch handles it:
 * `classifyTransportFailure` reads it as "no usable answer", which is exactly what the
 * command has. Rendering it as an ordinary failure instead would re-open the form for
 * a second submission of something that may already have happened.
 */
export class CommandOutcomeUnknownError extends Error {
  readonly incoherent = true;
  readonly error = {
    detail:
      'It is not known whether this command was carried out, and its admin session has since ended in this tab. It will not be sent again.',
  };

  constructor(readonly requestId: string | null = null) {
    super('Command outcome unknown: its session ended in this tab.');
    this.name = 'CommandOutcomeUnknownError';
  }
}

/** A READ whose answer belongs to a lifecycle that has ended. Nothing adopts it. */
export class SessionEndedReadError extends Error {
  readonly error = { detail: 'This read belonged to an admin session that has ended in this tab.' };

  constructor() {
    super('Read discarded: its session ended in this tab.');
    this.name = 'SessionEndedReadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
