import { formatMoney } from '../formatting/currency';
import { StatusPillVariant } from '../../ui/status-pill.component';
import {
  ActivityResult,
  BLOCKER_READINESS_NOT_CONFIGURED,
  BillingIntervalUnit,
  CommercialSubscriptionTerms,
  CommercialSummary,
  LifecycleState,
  OnboardingSource,
  OrderStatus,
  OwnerControlEvidence,
  OwnerControlStatus,
  OwnerInvitationStatus,
  OwnerRelationshipStatus,
  PaymentCollectionMode,
  PaymentTiming,
  ReadinessSummary,
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
 *   COMMERCIAL (Step 3E.1). Three independent facts, and the upgrade pressure runs in
 *   three different directions. `offline` is a permanent, first-class custody mode and
 *   must never read as cash-only, degraded or pre-launch. `psp_online` records an
 *   INTENTION that Dinify initiates payment and proves nothing about a provider being
 *   connected. And an open subscription-terms row is RECORDED PRICING INTENT — never
 *   Active, Paid, Current, Trial or In good standing. Dinify has never collected a
 *   subscription payment through this system, so an operator who reads "Paid" will stop
 *   chasing an invoice that was never raised.
 *
 *   PARTIAL CONFIGURATION IS A REAL STATE and stays visible. Collapsing "timing decided,
 *   collection still open" into a single "Configured" or "Not configured" destroys the
 *   distinction the operator is looking at the column to find.
 *
 *   THE LEGACY FIELDS ARE NOT AN INPUT HERE. `payment_mode` is frozen null,
 *   `has_commercial_subscription` is frozen false, and `legacy_validity_flag` is a bare
 *   boolean that defaults True and that nothing maintains. Where the legacy fields and
 *   `commercial` disagree, `commercial` wins — and no function in this file reads the
 *   legacy three except `subscriptionMethodLabel`, which exists only to label the
 *   fenced-off legacy reconciliation block.
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

// --- commercial: the canonical domain (Step 3E.1) -----------------------------

/**
 * What an UNCONFIGURED commercial fact is called. One phrase, so a directory cell and a
 * workspace row cannot describe the same absence in two different ways.
 *
 * DISTINCT FROM `NO_VALUE`, and the distinction is load-bearing. "Not configured" says
 * the server was asked and answered: no decision has been recorded. `NO_VALUE` says the
 * server did not answer at all. Rendering the second as the first would manufacture a
 * commercial verdict out of a missing payload — the same defect class as a dead backend
 * presenting as "Invalid credentials."
 */
export const NOT_CONFIGURED = 'Not configured';

const PAYMENT_TIMING_LABELS: Record<PaymentTiming, string> = {
  // WHEN the diner pays, relative to eating. Not a payment method and not a policy
  // about prepayment enforcement — `require_order_prepayments` is a different toggle
  // on a different object and is never consulted.
  pay_first: 'Pay first',
  pay_after: 'Pay after',
};

export function paymentTimingLabel(value: PaymentTiming | null): string {
  if (value === null) return NOT_CONFIGURED;
  return PAYMENT_TIMING_LABELS[value] ?? humanise(value);
}

const PAYMENT_COLLECTION_MODE_LABELS: Record<PaymentCollectionMode, string> = {
  // WHO takes the diner's money. `offline` means Dinify does not initiate the payment
  // and the restaurant collects it — through cash, its own card terminal, its own
  // mobile-money till, an account, anything. NEVER "Cash only": that names one tender
  // out of many and would misreport a restaurant running its own card machine.
  // Never "Manual", "Offline payments" or "No online payments" either — each of those
  // reads as an absence or a degradation, and this is a permanent first-class mode a
  // restaurant is fully entitled to go live in.
  offline: 'Restaurant collects',
  // Dinify initiates the payment through a payment service provider. A statement of the
  // SERVICE MODEL, not of operational readiness: this platform has no PSP integration,
  // so there is no provider, no merchant id and nothing connected to report. Never
  // "Online payments enabled", "PSP connected" or "Dinify collects (live)".
  psp_online: 'Dinify via PSP',
};

export function paymentCollectionModeLabel(value: PaymentCollectionMode | null): string {
  if (value === null) return NOT_CONFIGURED;
  return PAYMENT_COLLECTION_MODE_LABELS[value] ?? humanise(value);
}

/**
 * The one sentence a configured collection mode needs beyond its two words.
 *
 * Both are worth stating, for opposite reasons: `offline` is the one most likely to be
 * read DOWN (as cash-only, or as a restaurant that has not finished setting up), and
 * `psp_online` is the one most likely to be read UP (as a provider being connected and
 * payments working). Null while unconfigured — an absence explains itself.
 */
export function paymentCollectionModeNote(value: PaymentCollectionMode | null): string | null {
  switch (value) {
    case 'offline':
      return (
        'Dinify does not initiate the diner payment. The restaurant collects it itself, ' +
        'through whichever methods it accepts.'
      );
    case 'psp_online':
      return (
        'Dinify is recorded as initiating the diner payment through a payment service ' +
        'provider. This does not confirm that a provider is connected.'
      );
    default:
      return null;
  }
}

/**
 * BOTH SERVICE AXES IN ONE DENSE CELL, for the directory's Payment column.
 *
 * The backend has two facts and the directory has seven columns; §15 keeps it dense, so
 * this composes rather than growing an eighth. What it must NOT do is collapse — a
 * restaurant with timing decided and collection still open is in a real state that an
 * operator acts on, and "Configured" / "Not configured" would erase it. So a partial
 * combination NAMES the half that is missing:
 *
 *   both      Pay first · Restaurant collects
 *   timing    Pay first · Collection not configured
 *   custody   Timing not configured · Restaurant collects
 *   neither   Not configured
 *
 * A missing `commercial` object returns `NO_VALUE`, never `Not configured` — see
 * `NOT_CONFIGURED` above.
 */
export function commercialPaymentLabel(commercial: CommercialSummary | null | undefined): string {
  if (!commercial) return NO_VALUE;

  const timing = commercial.payment_timing.value;
  const collection = commercial.payment_collection_mode.value;
  if (timing === null && collection === null) return NOT_CONFIGURED;

  const timingPart = timing === null ? 'Timing not configured' : paymentTimingLabel(timing);
  const collectionPart =
    collection === null ? 'Collection not configured' : paymentCollectionModeLabel(collection);
  return `${timingPart} · ${collectionPart}`;
}

const BILLING_INTERVAL_UNITS: Record<BillingIntervalUnit, readonly [string, string]> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years'],
};

/**
 * The recurrence, rendered LITERALLY: `every month`, `every 2 months`, `every 14 days`.
 *
 * The backend stores a generic recurrence — a unit and a count — and deliberately not a
 * plan catalogue. So this must never produce "Monthly plan", "Annual plan", "Basic",
 * "Pro" or "Trial": every one of those invents a product tier the database has no column
 * for, and an operator reading "Basic" will look for a plan definition that does not
 * exist.
 *
 * THE COUNT IS NOT ASSUMED TO BE 1. A count of 1 drops the numeral because "every 1
 * month" reads as a translation artefact; anything else keeps it and pluralises.
 */
export function billingIntervalLabel(interval: {
  readonly unit: BillingIntervalUnit;
  readonly count: number;
}): string {
  const forms = BILLING_INTERVAL_UNITS[interval.unit];
  // A unit outside the closed vocabulary is still rendered rather than dropped — a
  // server that grows a fifth reads slightly mechanically instead of going blank.
  const [singular, plural] = forms ?? [interval.unit, `${interval.unit}s`];
  if (interval.count === 1) return `every ${singular}`;
  return `every ${interval.count} ${plural}`;
}

/**
 * The recorded price on its own: `UGX 150,000`, `UGX 0`, `KES 4,500.75`.
 *
 * The currency comes off the SAME record as the amount and is never assumed — see
 * `formatMoney`. A non-zero fraction survives; an all-zero one does not.
 */
export function subscriptionAmountLabel(terms: CommercialSubscriptionTerms): string {
  return formatMoney(terms.recurring_amount, terms.currency);
}

/**
 * THE SUBSCRIPTION-TERMS CELL: `UGX 150,000 · every month`, or `Not configured`.
 *
 * ── THE HIGHEST-RISK LABEL IN THIS FILE ──────────────────────────────────────────
 *
 * It replaced `has_commercial_subscription ? 'Active' : 'Not configured'`, and the word
 * it replaced is the point. An open `RestaurantSubscriptionTerms` row means ONE thing:
 * somebody at Dinify wrote down what this restaurant is to pay. It is not evidence of an
 * agreement, an invoice, a payment, a collection or any account standing — there is no
 * invoice model on the server and no collection path, so Dinify has never taken a
 * subscription payment through this system at all.
 *
 * So the cell states THE TERMS THEMSELVES rather than a verdict about them. A price and
 * a recurrence are facts the database can prove; "Active" is not. There is deliberately
 * no success treatment either — a recorded price is not an achievement to celebrate.
 *
 * Zero is a real price (a waived period, a pilot) and renders as `UGX 0`, never as
 * "Free", "Trial", "Waived" or "No subscription" — those describe the ABSENCE of a
 * terms row, which is a different fact with a different label.
 */
export function subscriptionTermsLabel(commercial: CommercialSummary | null | undefined): string {
  if (!commercial) return NO_VALUE;

  // `current` is what is actually rendered, so it — not the boolean beside it — is what
  // is guarded on. The server keeps the two consistent; a client that dereferenced
  // `current` on the strength of `configured` would crash rather than degrade if it ever
  // stopped doing so.
  const terms = commercial.subscription_terms.current;
  if (!terms) return NOT_CONFIGURED;

  return `${subscriptionAmountLabel(terms)} · ${billingIntervalLabel(terms.billing_interval)}`;
}

/**
 * Said beside recorded terms, every time they are shown.
 *
 * The label above states a price and a recurrence, which is honest but is also exactly
 * the shape an operator pattern-matches to a billing status. This is the sentence that
 * stops that read.
 */
export const SUBSCRIPTION_TERMS_NOTE =
  'Recorded terms only. Not an invoice, a payment, or evidence of account standing.';

// --- subscription: the LEGACY record -----------------------------------------

/**
 * `per_order` -> `Per order`.
 *
 * TRANSITIONAL. The only reader of a legacy commercial column left in this file, and it
 * exists solely to label the fenced-off "Legacy record" block on Overview, which an
 * operator reconciling an old row will want. It is never a fallback for
 * `commercial.subscription_terms` and never appears outside that block.
 */
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
