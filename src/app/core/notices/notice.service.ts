import { computed, Injectable, signal } from '@angular/core';

import { LOW_RECOVERY_CODES_THRESHOLD } from '../api/api.constants';

/**
 * One notice, composed of the facts that are true right now.
 *
 * `facts` is a LIST rather than a sentence on purpose. "The lockout was cleared" and
 * "two recovery codes remain" are different facts — one says something was fixed, the
 * other says a resource is running out — and joining them into a single string (which
 * is what the login page used to do before writing it to a console nobody has open)
 * loses the distinction the operator needs to act on.
 */
export interface OperatorNotice {
  readonly title: string;
  /** Distinct facts, one line each. Never flattened into a single sentence. */
  readonly facts: readonly string[];
  /** What to do about it, when there is something to do. */
  readonly action: string | null;
  /** True when the notice is the "running out" kind rather than the "fixed" kind. */
  readonly urgent: boolean;
}

/** What `verify/` or `elevate/` just reported about the second factor. */
export interface SecondFactorOutcome {
  /** `verify/` only: this sign-in cleared an account lockout (the break-glass path). */
  readonly lockoutCleared?: boolean;
  readonly usedRecoveryCode: boolean;
  readonly recoveryCodesRemaining: number;
}

/**
 * THE OPERATOR NOTICE CHANNEL — post-authentication facts that must be SEEN.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────
 *
 * `verify/` and `elevate/` report two things no other surface will ever mention
 * again: that a sign-in cleared an account lockout, and how many recovery codes are
 * left. Both used to reach `console.warn`, which is to say nobody. Running out of
 * recovery codes with a lost authenticator means `manage.py reset_platform_admin_totp`
 * on the box — a state worth several warnings before it arrives, not one.
 *
 * ── ONE NOTICE. THIS IS THE BOUNDARY, AND IT IS HOW TOAST SYSTEMS GET BORN ────────
 *
 * At most one notice is visible, ever. No stacking, no queue, no auto-dismiss, no
 * timers. If two conditions hold at once they COMPOSE into one notice with one line
 * each; they do not become two notices. Anything that needs more than this is a
 * different problem and should be argued for on its own terms rather than arriving as
 * "just one more toast".
 *
 * ── IT PERSISTS, AND IT COMES BACK ────────────────────────────────────────────────
 *
 * Dismissal is remembered, and a fresh statement of the facts undismisses: the warning
 * returns on the next sign-in while the condition still holds.
 *
 * ── THE RELOAD GAP, AND ITS FIX ───────────────────────────────────────────────────
 *
 * `GET /auth/session/` returns exactly six fields and `recovery_codes_remaining` is
 * NOT among them — the count is only ever stated by `verify/` and `elevate/`. So a
 * mid-session page reload loses it, and this service cannot honestly re-assert a
 * warning it can no longer verify. The gap is accepted rather than papered over with
 * client-side storage: persisting a security-adjacent count in the browser is a new
 * surface for a marginal gain.
 *
 * TODO(backend): add `recovery_codes_remaining` to `GET /auth/session/`. When it
 * lands, wiring it is one call to `record()` from `AdminAuthService.bootstrap()` —
 * a source change, not a redesign. See CLAUDE.md.
 */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  /** Sticky for the session: the lockout WAS cleared, whatever happens afterwards. */
  private readonly _lockoutCleared = signal(false);
  /** Sticky for the session: a one-shot credential has been spent. */
  private readonly _usedRecoveryCode = signal(false);
  /** Null until a second factor states it. See the reload gap above. */
  private readonly _recoveryCodesRemaining = signal<number | null>(null);
  private readonly _dismissed = signal(false);

  /** The single notice, or null. Composed, never queued. */
  readonly notice = computed<OperatorNotice | null>(() => {
    if (this._dismissed()) return null;

    const remaining = this._recoveryCodesRemaining();
    // Null unless the count is known AND low, so the number stays in hand below.
    const low = remaining !== null && remaining <= LOW_RECOVERY_CODES_THRESHOLD ? remaining : null;
    const cleared = this._lockoutCleared();
    if (low === null && !cleared) return null;

    const facts: string[] = [];
    if (cleared) facts.push('This sign-in cleared the account lockout.');
    if (this._usedRecoveryCode()) facts.push('A recovery code was used. It cannot be used again.');
    if (low !== null) facts.push(remainingSentence(low));

    return {
      title: low !== null ? 'Recovery codes are running low' : 'Account lockout cleared',
      facts,
      action:
        low !== null
          ? 'Regenerate them before the last one is spent. Running out with a lost ' +
            'authenticator means running manage.py reset_platform_admin_totp on the server.'
          : null,
      urgent: low !== null,
    };
  });

  /**
   * Record what a second factor just reported. Called after `verify/` AND after
   * `elevate/` — a re-elevation spends a recovery code exactly as a sign-in does, and
   * dropping the count there is how an operator reaches zero without ever being told.
   */
  record(outcome: SecondFactorOutcome): void {
    if (outcome.lockoutCleared) this._lockoutCleared.set(true);
    if (outcome.usedRecoveryCode) this._usedRecoveryCode.set(true);
    this._recoveryCodesRemaining.set(outcome.recoveryCodesRemaining);

    // Undismiss only when this outcome gives the operator something new to see. A
    // routine re-elevation with eight codes left must not resurrect a notice they
    // have already read and dismissed.
    if (outcome.lockoutCleared || outcome.recoveryCodesRemaining <= LOW_RECOVERY_CODES_THRESHOLD) {
      this._dismissed.set(false);
    }
  }

  dismiss(): void {
    this._dismissed.set(true);
  }

  /** Sign-out. These facts belong to a session and must not outlive one. */
  clear(): void {
    this._lockoutCleared.set(false);
    this._usedRecoveryCode.set(false);
    this._recoveryCodesRemaining.set(null);
    this._dismissed.set(false);
  }
}

function remainingSentence(remaining: number): string {
  if (remaining <= 0) return 'No recovery codes remain.';
  if (remaining === 1) return 'One recovery code remains.';
  return `${remaining} recovery codes remain.`;
}
