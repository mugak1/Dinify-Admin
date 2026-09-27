import { classifyTransportFailure } from '../api/transport-failure';
import {
  COMMAND_OWNER_HEADER,
  CommandNotRunError,
  CommandOutcomeUnknownError,
  CommandResultWithheldError,
  compareOwners,
  formatCommandOwner,
  readCommandOwner,
  readOwnerRefusal,
  SessionEndedReadError,
} from './command-owner';

const ACTOR = '0a0a0a0a-0000-4000-8000-0000000000aa';
const SESSION = '0b0b0b0b-0000-4000-8000-0000000000bb';
const GOOD = { version: 1, actor: ACTOR, session: SESSION };

/**
 * THE D10 CLIENT CONTRACT, AS DATA. Backend B1 (`platform_admin_app/command_owner.py`)
 * is the other half; the strings and statuses below are that module's, not a summary.
 */
describe('command owner', () => {
  describe('readCommandOwner — strict, never normalised', () => {
    it('reads exactly {version: 1, actor, session} with lowercase canonical UUIDs', () => {
      expect(readCommandOwner({ command_owner: GOOD })).toEqual({
        kind: 'owner',
        owner: { version: 1, actor: ACTOR, session: SESSION },
      });
    });

    it('says ABSENT only when the key is missing — a server that does not publish the capability', () => {
      expect(readCommandOwner({}).kind).toBe('absent');
      expect(readCommandOwner(null).kind).toBe('absent');
      expect(readCommandOwner('x').kind).toBe('absent');
    });

    it('says MALFORMED for anything present that is not exactly the contract', () => {
      const bad: unknown[] = [
        null,
        'x',
        [],
        [GOOD],
        {},
        { ...GOOD, version: 2 },
        { ...GOOD, version: '1' },
        { ...GOOD, actor: ACTOR.toUpperCase() },
        { ...GOOD, session: `{${SESSION}}` },
        { ...GOOD, session: SESSION.replace(/-/g, '') },
        { ...GOOD, actor: 42 },
        { version: 1, actor: ACTOR },
        { ...GOOD, extra: true },
        { ...GOOD, session: ` ${SESSION}` },
      ];
      for (const value of bad) {
        expect(readCommandOwner({ command_owner: value }).kind)
          .withContext(JSON.stringify(value))
          .toBe('malformed');
      }
    });
  });

  it('formats the header B1 parses: `1;<actor>;<session>`', () => {
    expect(COMMAND_OWNER_HEADER).toBe('X-Admin-Command-Owner');
    expect(formatCommandOwner({ version: 1, actor: ACTOR, session: SESSION })).toBe(
      `1;${ACTOR};${SESSION}`,
    );
  });

  it('compares owners by actor, then session', () => {
    const owner = { version: 1 as const, actor: ACTOR, session: SESSION };
    expect(compareOwners(owner, { ...owner })).toBe('same');
    expect(compareOwners(owner, { ...owner, session: ACTOR })).toBe('session-changed');
    // A different actor is reported as such even when the session also differs.
    expect(compareOwners(owner, { ...owner, actor: SESSION, session: ACTOR })).toBe('actor-changed');
  });

  describe('readOwnerRefusal — the exact B1 contract and nothing else', () => {
    const refusal = (status: number, code: string, detail = 'x') => ({ status, error: { detail, code } });

    it('reads the three refusals on the status each is sent with', () => {
      expect(readOwnerRefusal(refusal(400, 'admin_command_owner_malformed'))).toBe('owner-malformed');
      expect(readOwnerRefusal(refusal(409, 'admin_command_actor_changed'))).toBe('actor-changed');
      expect(readOwnerRefusal(refusal(409, 'admin_command_session_changed'))).toBe('session-changed');
    });

    it('does not read an ordinary 409, a wrong status, an extra key or a non-string as one', () => {
      const others: unknown[] = [
        { status: 409, error: { status: 409, message: 'x', code: 'stale_service_configuration' } },
        refusal(409, 'stale_subscription_terms'),
        refusal(400, 'admin_command_actor_changed'),
        refusal(409, 'admin_command_owner_malformed'),
        refusal(403, 'admin_command_session_changed'),
        { status: 409, error: { detail: 'x', code: 'admin_command_actor_changed', status: 409 } },
        { status: 409, error: { detail: 7, code: 'admin_command_actor_changed' } },
        { status: 409, error: { code: 'admin_command_actor_changed' } },
        { status: '409', error: { detail: 'x', code: 'admin_command_actor_changed' } },
        { status: 409, error: 'admin_command_actor_changed' },
        null,
        new Error('x'),
      ];
      for (const error of others) {
        expect(readOwnerRefusal(error)).withContext(JSON.stringify(error)).toBeNull();
      }
    });
  });

  describe('outcomes', () => {
    it('NOT RUN says so, carries no status, and reaches every consumer through `error.detail`', () => {
      for (const reason of [
        'actor-changed',
        'session-changed',
        'owner-malformed',
        'binding-unsupported',
        'no-session',
        'session-ended',
      ] as const) {
        const error = new CommandNotRunError(reason, true);
        expect(error.executed).toBeFalse();
        expect(error.error.detail).withContext(reason).toContain('not run');
        expect('status' in error).withContext(reason).toBeFalse();
        // Not "no usable answer": a consumer takes its ordinary failure branch, keeps
        // the draft and shows the sentence.
        expect(classifyTransportFailure(error)).withContext(reason).toBe('other');
      }
    });

    it('an unknown sign-out owner says no sign-out request was sent', () => {
      expect(new CommandNotRunError('owner-unknown', false).error.detail).toContain(
        'no sign-out request was sent',
      );
    });

    it('WITHHELD says the server reported completion, and carries no result', () => {
      const error = new CommandResultWithheldError('req-1');
      expect(error.error.detail).toContain('reported this command as completed');
      expect(error.error.detail).toContain('not shown here');
      expect(error.requestId).toBe('req-1');
      expect(Object.keys(error)).not.toContain('body');
      expect(classifyTransportFailure(error)).toBe('other');
    });

    it('UNKNOWN never claims nothing changed, and routes to every consumer’s indeterminate branch', () => {
      const error = new CommandOutcomeUnknownError('req-2');
      expect(error.error.detail).toContain('It is not known whether this command was carried out');
      expect(error.error.detail).toContain('will not be sent again');
      expect(error.error.detail).not.toContain('not run');
      expect(error.error.detail).not.toContain('Nothing was changed');
      expect(classifyTransportFailure(error)).toBe('unavailable');
    });

    it('a discarded READ is its own outcome', () => {
      expect(new SessionEndedReadError().error.detail).toContain('has ended in this tab');
    });
  });
});
