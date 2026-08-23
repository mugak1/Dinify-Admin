import { StatusPillVariant } from '../../ui/status-pill.component';
import {
  ActivityResult,
  BLOCKER_READINESS_NOT_CONFIGURED,
  LifecycleState,
  OnboardingSource,
  OrderStatus,
  OwnerControlEvidence,
  OwnerControlStatus,
  OwnerInvitationStatus,
  OwnerRelationshipStatus,
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
 *   ONBOARDING (Step 2C). Five separate questions, five separate answers, and the
 *   temptation is to fuse them into one green "Onboarding complete". Structural owner
 *   CONSISTENCY is not evidence anybody CONTROLS the account; an administrator's
 *   ATTESTATION is not an observed sign-in; a legacy tenant's `not_applicable`
 *   invitation is not a missing one; and evidence recorded against a PREVIOUS owner
 *   establishes nothing about the current one. Each of those conflations would read as
 *   reassurance the database cannot support.
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

// --- onboarding: provenance (Step 2C) ----------------------------------------

/**
 * What the portal says when the admin onboarding domain holds no answer.
 *
 * Distinct from "Not established" and from "Not issued", and the distinction is the
 * whole point: those two report an EVALUATED question, this one reports a question
 * that was never asked. Calling an unrepresented restaurant unclaimed or inconsistent
 * would manufacture a fault out of an absence of data.
 */
export const NOT_TRACKED = 'Not tracked';

const ONBOARDING_SOURCE_LABELS: Record<OnboardingSource, string> = {
  // Not "Imported" and not "Migrated": nothing moved. A restaurant that already
  // existed was brought under a record that did not exist before.
  legacy_adopted: 'Pre-existing restaurant',
  admin_created: 'Created by Dinify Admin',
};

/**
 * How the restaurant entered the onboarding domain.
 *
 * A null source is the untracked case — the domain holds no record, so there is no
 * provenance to state. It is reported as not tracked rather than guessed at.
 */
export function onboardingSourceLabel(source: OnboardingSource | null): string {
  if (source === null) return NOT_TRACKED;
  return ONBOARDING_SOURCE_LABELS[source] ?? humanise(source);
}

/**
 * The one line of provenance an operator needs, or null where the label already says
 * everything.
 *
 * "Pre-existing restaurant" is the phrase most likely to be misread as a creation
 * date, so it — and only it — gets a sentence. `recorded_at` is when the ADMIN RECORD
 * appeared, not when the restaurant did, and the copy never implies otherwise.
 */
export function onboardingSourceNote(source: OnboardingSource | null): string | null {
  if (source !== 'legacy_adopted') return null;
  return 'This restaurant existed before the Admin onboarding record was introduced.';
}

/** Said once, at panel level, when the domain has no record of this restaurant. */
export const ONBOARDING_UNTRACKED_NOTE =
  'This restaurant has not yet been represented in the Admin onboarding domain.';

// --- onboarding: the owner relationship --------------------------------------

const OWNER_RELATIONSHIP_LABELS: Record<OwnerRelationshipStatus, string> = {
  unavailable: NOT_TRACKED,
  consistent: 'Consistent',
  missing_owner_membership: 'Owner access missing',
  multiple_owner_memberships: 'Multiple active owners',
  owner_membership_mismatch: 'Owner mismatch',
};

/**
 * Whether `Restaurant.owner` agrees with active owner-role membership.
 *
 * A STRUCTURAL check and nothing more. "Consistent" says the records agree; it is not
 * evidence that anybody controls the account, which is a separate row.
 */
export function ownerRelationshipLabel(status: OwnerRelationshipStatus): string {
  return OWNER_RELATIONSHIP_LABELS[status] ?? humanise(status);
}

/**
 * What an inconsistency MEANS, in operator English — because "Owner mismatch" alone
 * does not say which two things fail to match.
 *
 * Deliberately descriptive and never prescriptive: the portal states what the server
 * observed and stops. Which identity is correct is not something this read can know,
 * and a repair action is not in this slice.
 */
export function ownerRelationshipNote(status: OwnerRelationshipStatus): string | null {
  switch (status) {
    case 'missing_owner_membership':
      return 'The owner of record does not currently hold active owner access.';
    case 'multiple_owner_memberships':
      return 'More than one active user currently holds the owner role.';
    case 'owner_membership_mismatch':
      return 'The owner of record and the active owner-role user do not match.';
    default:
      // `consistent` and `unavailable` stay quiet. §10: a completed or unevaluated
      // state should recede, not explain itself at length.
      return null;
  }
}

/** The three states an operator has to look at. Warning treatment, never celebration. */
export function ownerRelationshipIsNotable(status: OwnerRelationshipStatus): boolean {
  return (
    status === 'missing_owner_membership' ||
    status === 'multiple_owner_memberships' ||
    status === 'owner_membership_mismatch'
  );
}

// --- onboarding: owner control -----------------------------------------------

const OWNER_CONTROL_LABELS: Record<OwnerControlStatus, string> = {
  unavailable: NOT_TRACKED,
  not_established: 'Not established',
  // Both are established. They differ in the EVIDENCE, which is its own row — see
  // `ownerControlEvidenceLabel`. Collapsing them into one word here is correct; making
  // the evidence disappear with them would not be.
  attested: 'Established',
  invitation_redeemed: 'Established',
  // Evidence exists and does not apply to the current owner. Not "established", and
  // not silence either.
  stale_attestation: 'Stale evidence',
};

export function ownerControlLabel(status: OwnerControlStatus): string {
  return OWNER_CONTROL_LABELS[status] ?? humanise(status);
}

const OWNER_CONTROL_EVIDENCE_LABELS: Record<OwnerControlEvidence, string> = {
  // An ADMINISTRATOR recorded this. Nobody observed the owner do anything.
  legacy_attestation: 'Recorded by administrative attestation',
  // Observed: the owner redeemed the invitation that was sent to them.
  invitation_redeemed: 'Owner invitation redeemed',
};

/**
 * WHAT establishes control, never "Owner claimed account".
 *
 * The two evidences are not interchangeable. An attestation is a platform operator's
 * assertion, made for a restaurant that predates invitations; a redemption is an
 * observed act by the owner. Describing the first as the second would turn an internal
 * judgement into external proof, on the row an operator uses to decide whether it is
 * safe to hand a tenant its own account.
 *
 * Null when there is no evidence to name.
 */
export function ownerControlEvidenceLabel(evidence: OwnerControlEvidence | null): string | null {
  if (evidence === null) return null;
  return OWNER_CONTROL_EVIDENCE_LABELS[evidence] ?? humanise(evidence);
}

/**
 * The sentence a control state needs beyond its label, or null.
 *
 * `not_established` says only that no evidence is recorded — NOT that an owner failed
 * to claim an invitation, which for a legacy-adopted restaurant would describe a step
 * that never applied to it.
 */
export function ownerControlNote(status: OwnerControlStatus): string | null {
  switch (status) {
    case 'not_established':
      return 'No owner-control evidence is recorded yet.';
    case 'stale_attestation':
      return (
        'The recorded owner-control attestation applies to a previous owner and does not ' +
        'establish control for the current owner.'
      );
    default:
      return null;
  }
}

/** Stale evidence is a problem to look at. Established and untracked are not. */
export function ownerControlIsNotable(status: OwnerControlStatus): boolean {
  return status === 'stale_attestation';
}

// --- onboarding: the invitation ----------------------------------------------

const OWNER_INVITATION_LABELS: Record<OwnerInvitationStatus, string> = {
  unavailable: NOT_TRACKED,
  // NOT "Not issued". A legacy-adopted restaurant never had an invitation to issue,
  // and saying otherwise invents a missing step for every tenant that predates the
  // domain. This one is load-bearing truth, not a nicety.
  not_applicable: 'Not applicable',
  not_issued: 'Not issued',
  pending: 'Pending',
  expired: 'Expired',
  consumed: 'Redeemed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};

export function ownerInvitationLabel(status: OwnerInvitationStatus): string {
  return OWNER_INVITATION_LABELS[status] ?? humanise(status);
}

/**
 * An expired invitation is the one state an operator has to do something about — the
 * owner cannot act on it and nothing will re-issue it on its own. Pending is waiting,
 * not failing; cancelled and superseded were deliberate.
 */
export function ownerInvitationIsNotable(status: OwnerInvitationStatus): boolean {
  return status === 'expired';
}

// --- shared ------------------------------------------------------------------

/** `readiness_not_configured` -> `Readiness not configured`. Never returns ''. */
function humanise(code: string): string {
  const words = code.replace(/[_\-.]+/g, ' ').trim();
  if (!words) return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
