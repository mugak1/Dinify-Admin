import { StatusPillVariant } from '../../ui/status-pill.component';
import {
  ActivityResult,
  BLOCKER_READINESS_NOT_CONFIGURED,
  LifecycleState,
  OrderStatus,
  PaymentModeSummary,
  ReadinessSummary,
  SubscriptionSummary,
} from './restaurant.model';

/**
 * OPERATOR LANGUAGE FOR BACKEND MACHINE VALUES — one place, so the directory row and
 * the detail header can never disagree about what a restaurant's state is called.
 *
 * ── THE RULE THAT GOVERNS EVERY FUNCTION HERE ─────────────────────────────────────
 *
 * Translate; never upgrade. The backend reports several concepts as UNCONFIGURED
 * because the models behind them do not exist yet, and a column reading "Not
 * configured" looks unfinished — which is exactly the pressure that produces a portal
 * asserting things the database cannot support. Three of these were easy to fake:
 *
 *   READINESS. `not_ready` + `readiness_not_configured` does NOT mean this restaurant
 *   failed a checklist. It means the checklist has not been built (the seam fails
 *   closed until Step 3), so the copy says that about the ENGINE and not about the
 *   tenant. `not_applicable` is not a quiet "ready" either — for an offboarded
 *   restaurant, "ready to go live" has no answer at all.
 *
 *   PAYMENT MODE. There is no field. Not inferred from `require_order_prepayments`
 *   (a diner-checkout toggle) or from anything else.
 *
 *   SUBSCRIPTION. `legacy_validity_flag` is a bare boolean that defaults True and that
 *   nothing maintains. It is NEVER rendered as Active, Paid, Current, Trial or In
 *   good standing — none of those are facts the server can prove, and an operator who
 *   reads "Paid" will stop chasing an invoice that was never raised.
 *
 * NOTHING HERE COMPUTES STATE. Every function is a pure projection of a value the
 * server already sent.
 */

/** The em dash used wherever a value is genuinely absent. Matches `formatting/time`. */
export const NO_VALUE = '—';

// --- lifecycle ---------------------------------------------------------------

const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  onboarding: 'Onboarding',
  live: 'Live',
  suspended: 'Suspended',
  offboarded: 'Offboarded',
};

export function lifecycleLabel(state: LifecycleState): string {
  return LIFECYCLE_LABELS[state] ?? state;
}

/**
 * The pill variant for a lifecycle state.
 *
 * Total by construction, with `neutral` for anything the four-state vocabulary does
 * not cover — a server that grows a fifth state renders a neutral pill carrying its
 * name rather than nothing at all.
 */
export function lifecycleVariant(state: LifecycleState): StatusPillVariant {
  return state in LIFECYCLE_LABELS ? (state as StatusPillVariant) : 'neutral';
}

/** What being in this state MEANS, for the detail header. */
const LIFECYCLE_MEANING: Record<LifecycleState, string> = {
  onboarding: 'Being set up. Diners cannot order yet.',
  live: 'Accepting diner orders.',
  suspended: 'Trading is paused. Diners see a temporarily-unavailable message.',
  offboarded: 'No longer trading. The diner menu is gone.',
};

export function lifecycleMeaning(state: LifecycleState): string {
  return LIFECYCLE_MEANING[state] ?? '';
}

// --- readiness ---------------------------------------------------------------

/**
 * The readiness cell, as one short phrase.
 *
 * Shaped so Step 3 needs no change here: when the seam starts returning real blocker
 * codes, `not_ready` already renders "3 blockers" from `blocker_count`. The
 * not-configured case is singled out FIRST because it is a statement about the engine
 * rather than about the restaurant, and the two must not read alike.
 */
export function readinessLabel(readiness: ReadinessSummary): string {
  switch (readiness.state) {
    case 'ready':
      return 'Ready';
    case 'not_applicable':
      return 'Not applicable';
    case 'not_ready':
      if (isNotConfigured(readiness)) return 'Not configured';
      return readiness.blocker_count === 1 ? '1 blocker' : `${readiness.blocker_count} blockers`;
    default:
      return NO_VALUE;
  }
}

/** True when the ONLY thing standing in the way is that Step 3 has not landed. */
export function isNotConfigured(readiness: ReadinessSummary): boolean {
  return (
    readiness.state === 'not_ready' &&
    readiness.blockers.length === 1 &&
    readiness.blockers[0] === BLOCKER_READINESS_NOT_CONFIGURED
  );
}

/**
 * One blocker code in operator language.
 *
 * Known codes get real sentences. An unknown one — which is what Step 3 will produce
 * before this map is updated — is HUMANISED rather than shown raw or dropped:
 * `published_menu_item` reads as "Published menu item", which is imperfect but is
 * still a blocker the operator can act on. Showing snake_case to an operator, or
 * showing nothing, are both worse.
 */
export function readinessBlockerLabel(code: string): string {
  const known = BLOCKER_LABELS[code];
  if (known) return known;
  return humanise(code);
}

const BLOCKER_LABELS: Record<string, string> = {
  [BLOCKER_READINESS_NOT_CONFIGURED]: 'Go-live readiness checks are not configured yet.',
};

// --- payment mode ------------------------------------------------------------

/**
 * The payment-mode cell. `Not configured` while the server says so, and the mode
 * itself once a field exists to say otherwise — humanised, because whatever that
 * vocabulary turns out to be it will be snake_case.
 */
export function paymentModeLabel(payment: PaymentModeSummary): string {
  if (!payment.payment_mode_configured || !payment.payment_mode) return 'Not configured';
  return humanise(payment.payment_mode);
}

// --- subscription ------------------------------------------------------------

/**
 * The subscription cell. ALWAYS "Not configured" until a commercial subscription
 * record exists — see the rule at the top of this file.
 */
export function subscriptionLabel(subscription: SubscriptionSummary): string {
  return subscription.has_commercial_subscription ? 'Active' : 'Not configured';
}

/** `per_order` -> `Per order`. Legacy billing method, labelled as legacy where shown. */
export function subscriptionMethodLabel(method: string | null): string {
  return method ? humanise(method) : NO_VALUE;
}

// --- orders ------------------------------------------------------------------

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  initiated: 'Draft',
  pending: 'Pending',
  preparing: 'Preparing',
  served: 'Served',
  paid: 'Paid',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
};

export function orderStatusLabel(status: OrderStatus): string {
  return ORDER_STATUS_LABELS[status] ?? humanise(status);
}

// --- activity ----------------------------------------------------------------

/**
 * `AdminAuditLog.action` in plain language — every constant in
 * `platform_admin_app/audit_actions.py`, which is a closed, greppable set on the
 * server and therefore worth mapping exhaustively here.
 *
 * An action this map does not know is HUMANISED, never blank: the backend appends to
 * that module as new capability lands, and an Overview strip that renders empty rows
 * for a newly-audited action is worse than one that reads slightly mechanically.
 */
const ACTION_LABELS: Record<string, string> = {
  'admin.auth.challenge_issued': 'Sign-in challenge issued',
  'admin.auth.login_success': 'Signed in',
  'admin.auth.login_failure': 'Sign-in failed',
  'admin.auth.logout': 'Signed out',
  'admin.auth.totp_failure': 'Second factor rejected',
  'admin.auth.recovery_code_used': 'Recovery code used',
  'admin.auth.lockout': 'Account locked out',
  'admin.auth.lockout_cleared': 'Lockout cleared',
  'admin.auth.elevated': 'Re-authenticated',
  'admin.auth.totp_enrolled': 'Authenticator enrolled',
  'admin.auth.totp_reset': 'Authenticator reset',
  'admin.auth.recovery_codes_generated': 'Recovery codes issued',
  'admin.session.revoked': 'Session revoked',
  'admin.delegation.minted': 'Delegated access granted',
  'admin.delegation.mint_denied': 'Delegated access refused',
  'admin.delegation.revoked': 'Delegated access revoked',
  'admin.delegation.superseded': 'Delegated access superseded',
  'admin.delegation.session_started': 'Delegated session started',
  'admin.delegation.session_start_denied': 'Delegated session refused',
  'admin.delegation.session_ended': 'Delegated session ended',
  'admin.delegation.action_performed': 'Action performed in a delegated session',
  'admin.delegation.action_denied': 'Action refused in a delegated session',
  'admin.restaurant.lifecycle_transition': 'Lifecycle changed',
  'admin.restaurant.transition_denied': 'Lifecycle change refused',
};

export function activityActionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  // Drop the `admin.` namespace, which every action carries and none distinguishes.
  return humanise(action.replace(/^admin\./, '').replace(/\./g, ' '));
}

const RESULT_LABELS: Record<ActivityResult, string> = {
  success: 'Succeeded',
  failure: 'Failed',
  denied: 'Refused',
};

export function activityResultLabel(result: ActivityResult): string {
  return RESULT_LABELS[result] ?? humanise(result);
}

/** Only a non-success result is worth a pill — §16 asks for badges sparingly. */
export function activityResultIsNotable(result: ActivityResult): boolean {
  return result !== 'success';
}

// --- shared ------------------------------------------------------------------

/** `readiness_not_configured` -> `Readiness not configured`. Never returns ''. */
function humanise(code: string): string {
  const words = code.replace(/[_\-.]+/g, ' ').trim();
  if (!words) return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
