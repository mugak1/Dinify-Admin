/**
 * The restaurant read model, mirroring `platform_admin_app/restaurant_reads.py`.
 *
 * Every field below was read out of that module during recon, not out of a brief.
 * Two rules govern this file, and both exist because the alternative is a portal that
 * quietly says something the server never said:
 *
 *   1. WHERE THE BACKEND HAS A CLOSED VOCABULARY, SO DOES THIS. Lifecycle state,
 *      readiness state, audit result and order status are enumerated on the server;
 *      widening them to `string` here would let a typo compile and would lose the
 *      exhaustiveness checking that makes a new state a compile error rather than a
 *      blank cell.
 *
 *      Step 3E.1 added five more closed vocabularies under the same rule — payment
 *      timing, payment collection mode and the billing-interval unit are all
 *      enumerated in `commercial_app`, so they are enumerated here.
 *
 *   2. WHERE IT DOES NOT, THIS DOES NOT INVENT ONE. `readiness.blockers` carries codes
 *      Step 3 has not written yet, and `currency` is any three-letter ISO-4217 code the
 *      server accepts rather than a list this repo gets to choose. Declaring a union for
 *      either would be a guess with a type annotation on it.
 *
 * NULLS ARE MEANINGFUL AND ARE PRESERVED. A null `location`, a null
 * `last_activity_at`, a null `latest_order`, a null `subscription_terms.current` and a
 * null axis `value` each say something different from an empty string or a zero, and
 * the transport layer normalises none of them away.
 *
 * ONE MORE RULE ARRIVED WITH STEP 3E.1. The wire carries BOTH the canonical
 * `commercial` object and the transitional legacy fields it supersedes, and they may
 * disagree. WHERE THEY DO, `commercial` WINS — see the compatibility fence below.
 */

/** `restaurants_app` spells exactly these four. There is no fifth. */
export type LifecycleState = 'onboarding' | 'live' | 'suspended' | 'offboarded';

export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'onboarding',
  'live',
  'suspended',
  'offboarded',
];

/**
 * Go-live readiness, as `restaurant_reads.readiness_summary` reports it.
 *
 * `not_applicable` is NOT a polite "ready". Readiness answers one question — may this
 * restaurant move `onboarding -> live` — and that question has no answer for a
 * restaurant already live, suspended or offboarded. Rendering zero blockers there as
 * a tick would read as ready, which for an offboarded tenant is the opposite of true.
 */
export type ReadinessState = 'ready' | 'not_ready' | 'not_applicable';

export interface ReadinessSummary {
  readonly state: ReadinessState;
  readonly blocker_count: number;
  /**
   * Backend-owned machine codes. Today the seam fails closed and returns exactly one
   * (`readiness_not_configured`); Step 3 fills it with the real checklist. Typed as
   * `string` on purpose — the vocabulary is not written yet, and a union invented
   * here would be wrong the day it lands.
   */
  readonly blockers: readonly string[];
}

/** The one blocker the fail-closed seam emits today. */
export const BLOCKER_READINESS_NOT_CONFIGURED = 'readiness_not_configured';

/**
 * ══ THE CANONICAL COMMERCIAL CONTRACT (Step 3E.1) ═════════════════════════════════
 *
 * `commercial` is the authoritative answer to a restaurant's RECORDED commercial
 * configuration and terms.
 *
 * Recorded, not AGREED. An administrator writing down a price is not the owner accepting
 * one, and this projection carries no owner consent of any kind — see the terms note
 * below. Owner go-live approval is a separate concept that will bind to these exact
 * facts later; describing the read as what a restaurant has "agreed" would quietly
 * promote a platform-side entry into a two-sided agreement.
 *
 * It arrives on BOTH the directory row and the detail payload —
 * `restaurant_reads` calls `commercial_reads.commercial_summary` on each — so the two
 * screens are structurally incapable of disagreeing, and this application models it on
 * the shared shape below rather than as a detail-only extra.
 *
 * ── IT ANSWERS THREE INDEPENDENT QUESTIONS, AND THEY STAY THREE ───────────────────
 *
 *   payment_timing           Does the diner pay before or after eating? A SERVICE
 *                            MODEL fact — quick-service versus full-service.
 *   payment_collection_mode  Does Dinify initiate the diner's payment at all? A
 *                            CUSTODY fact.
 *   subscription_terms       What has Dinify recorded that this restaurant pays IT?
 *
 * Every partial combination is real and reachable. Timing decided while collection is
 * not; collection decided while timing is not; terms recorded while both service axes
 * are still open. THERE IS DELIBERATELY NO `commercial_configured` BOOLEAN on the
 * server, and there must be none here either: collapsing three facts into one word
 * makes "partially configured" unrepresentable, which is precisely the state an
 * operator most needs to see.
 *
 * ── WHAT `subscription_terms.configured` MEANS, AND WHAT IT DOES NOT ──────────────
 *
 * It means ONE thing: an open `RestaurantSubscriptionTerms` row exists — recorded
 * pricing intent, and nothing else. It is NOT active, paid, valid, current, in good
 * standing, a trial, an invoice, an invoice paid, a successful collection, or an
 * owner's agreement. Dinify has never collected a subscription payment through this
 * system: there is no invoice model, no receivable and no collection path, so any word
 * implying money changed hands is an assertion the database cannot support. The
 * backend named the model TERMS and not `Agreement` for exactly this reason, and
 * `restaurant.labels.ts` is where the vocabulary is held to it.
 *
 * ── NO INFERENCE, IN EITHER DIRECTION ────────────────────────────────────────────
 *
 * Nothing here is derived from `require_order_prepayments`, table configuration,
 * transaction tender, `flat_fee`, `preferred_subscription_method`, the legacy validity
 * or expiry columns, lifecycle state or `is_test`. `offline` is a PERMANENT,
 * FIRST-CLASS mode — not cash-only, not degraded, not a fallback and not a pre-launch
 * state — and `psp_online` carries no provider, no merchant id and no readiness
 * verdict, because this platform has no PSP integration to be ready.
 */

/** `commercial_app` spells exactly these two. A service-model fact. */
export type PaymentTiming = 'pay_first' | 'pay_after';

/**
 * `commercial_app` spells exactly these two. A CUSTODY fact: whether Dinify initiates
 * the diner's payment. `offline` means it does not and the restaurant collects through
 * whatever tender it likes — never "cash only", which names one tender out of many.
 */
export type PaymentCollectionMode = 'offline' | 'psp_online';

/** `commercial_app` spells exactly these four. A generic recurrence, never a plan. */
export type BillingIntervalUnit = 'day' | 'week' | 'month' | 'year';

/**
 * One configured-or-not commercial axis.
 *
 * `configured` IS THE SERVER'S BOOLEAN AND IS NOT RECOMPUTED HERE. The backend derives
 * it from the value and keeps value/timestamp all-or-none at the database, so a client
 * that re-derived it would at best duplicate the rule and at worst quietly disagree
 * with it. The transport passes the projection through exactly as sent.
 */
export interface CommercialAxis<T> {
  readonly configured: boolean;
  /** The exact persisted MACHINE value. Turning it into prose is the labels' job. */
  readonly value: T | null;
  /** When this configuration DECISION was recorded. Null while unconfigured. */
  readonly set_at: string | null;
}

/**
 * The single OPEN terms row — `ended_at IS NULL`, guaranteed at most one by a partial
 * unique index on the server.
 *
 * `recurring_amount` IS A DECIMAL STRING AND MUST STAY ONE. The backend serialises the
 * `Decimal` with `str()` specifically so DRF's encoder cannot turn it into a float, and
 * a price that renders differently from how it is stored is a price nobody can
 * reconcile. Zero is a real, deliberate price — a waived period, a pilot — and is a
 * different fact from having no terms row at all.
 *
 * `id` is not decoration: Step 3C's writers take `expected_terms_id`, so a future write
 * screen asserts optimistic concurrency with the exact fact it read.
 */
export interface CommercialSubscriptionTerms {
  readonly id: string;
  readonly recurring_amount: string;
  /** ISO-4217, three uppercase letters, stored with NO default. Never assumed UGX. */
  readonly currency: string;
  readonly billing_interval: {
    readonly unit: BillingIntervalUnit;
    /** At least 1, enforced by a check constraint. Not assumed to be 1. */
    readonly count: number;
  };
  /** When these terms became commercially APPLICABLE. Not when they were recorded. */
  readonly effective_from: string;
  /** When a platform operator WROTE THEM DOWN. Never agreed/signed/activated/paid. */
  readonly recorded_at: string;
}

export interface CommercialSummary {
  readonly payment_timing: CommercialAxis<PaymentTiming>;
  readonly payment_collection_mode: CommercialAxis<PaymentCollectionMode>;
  readonly subscription_terms: {
    /** An open terms row exists. See the block comment above for what that is not. */
    readonly configured: boolean;
    readonly current: CommercialSubscriptionTerms | null;
  };
}

/**
 * ══ THE SERVICE-CONFIGURATION WRITE CONTRACT (Step 3E.2) ══════════════════════════
 *
 * Two requests, one per axis, mirroring the two named endpoints. They are separate
 * types for the same reason the endpoints are separate routes: the vocabularies
 * differ, and a shared `{value: string}` would let a collection mode be posted to the
 * timing endpoint and be caught only by the server.
 *
 * ── `expected_current` IS REQUIRED, AND SEPARATELY NULLABLE ───────────────────────
 *
 * This is the whole of the optimistic-concurrency story and the easiest thing in the
 * slice to get quietly wrong. The field is REQUIRED on the server
 * (`required=True, allow_null=True`), so:
 *
 *   { "expected_current": null }   an ASSERTION — "nobody had configured this when I
 *                                  loaded it". The only assertion that succeeds
 *                                  against a fresh restaurant.
 *   { }                            NO assertion at all. A 400.
 *
 * They are not the same request, and TypeScript will not save anyone here: an
 * `undefined` property is DROPPED by `JSON.stringify`, so a value that arrives as
 * `undefined` instead of `null` silently becomes the second case. Every producer of
 * this type must coalesce to `null` explicitly, and a transport test asserts the key
 * is present with a literal null.
 *
 * THE VALUE IS THE EXACT AXIS VALUE THE OPERATOR LOADED — never derived from
 * `configured`, never from a legacy field, never from the other axis, never from a
 * form default, and never re-read at submit time. See `restaurant-tabs.pages.ts`.
 */
export interface SetPaymentTimingRequest {
  readonly value: PaymentTiming;
  readonly expected_current: PaymentTiming | null;
  readonly reason: string;
}

export interface SetPaymentCollectionModeRequest {
  readonly value: PaymentCollectionMode;
  readonly expected_current: PaymentCollectionMode | null;
  readonly reason: string;
}

/**
 * ══ THE SUBSCRIPTION-TERMS WRITE CONTRACT (Step 3E.3) ═════════════════════════════
 *
 * Three requests, one per named operation, because the three are materially different
 * decisions rather than three modes of one.
 *
 * ── THE AMOUNT IS A STRING, AND THAT IS ENFORCED AT BOTH ENDS ────────────────────
 *
 * The backend's `StrictDecimalStringField` REFUSES a JSON number outright — not a
 * `CharField`, which would coerce `150000` to `"150000"` and silently bypass the very
 * contract it exists to hold. `"0.00"` versus `0.0` is exactly the distinction that
 * would be lost. So nothing on this side may call `Number()`, `parseFloat()` or `+` on
 * an amount on its way to the wire; a form collects a string and a string is sent.
 *
 * ── THE MOMENTS MUST CARRY AN EXPLICIT OFFSET ────────────────────────────────────
 *
 * `effective_from` and `ended_at` go through `AwareDateTimeField`, which refuses a
 * naive value rather than assuming a zone for it. `eatWallTimeToIso` is how this
 * application produces one — see `core/formatting/time.ts` for why the browser's own
 * timezone must never be the interpreter.
 *
 * ── NEITHER MOMENT MAY BE IN THE FUTURE ──────────────────────────────────────────
 *
 * The domain records terms that are ALREADY in effect and does not schedule future
 * changes (`future_effective_terms_not_supported`). Backdating is ordinary and
 * truthful, subject to the monotonic timeline rules the writer owns.
 */

/**
 * RECORD — the restaurant's first (or, after an end, its next) open terms.
 *
 * THERE IS DELIBERATELY NO `expected_terms_id`, and adding one would be inventing a
 * concurrency field the contract does not have. The precondition is ABSENCE — "record
 * these only if none are open" — and the backend enforces it under the restaurant
 * lock: identical open terms are a safe no-op, different ones are a 409
 * `subscription_terms_already_open`.
 */
export interface RecordSubscriptionTermsRequest {
  readonly recurring_amount: string;
  readonly currency: string;
  readonly billing_interval_unit: BillingIntervalUnit;
  readonly billing_interval_count: number;
  readonly effective_from: string;
  readonly reason: string;
}

/**
 * REPLACE — supersede the exact currently-open row.
 *
 * ONE atomic close-then-insert on the server: the outgoing row's `ended_at` is set to
 * exactly the replacement's `effective_from`, so the history has no gap and no overlap.
 * TERMS ROWS ARE IMMUTABLE — this is not an edit, and the superseded row stays in
 * history where a future invoice or owner approval can still reference it by id.
 *
 * `expected_terms_id` is `commercial.subscription_terms.current.id`, captured when the
 * editor opened. Required, non-null, and never derived from anything else.
 */
export interface ReplaceSubscriptionTermsRequest {
  readonly expected_terms_id: string;
  readonly recurring_amount: string;
  readonly currency: string;
  readonly billing_interval_unit: BillingIntervalUnit;
  readonly billing_interval_count: number;
  readonly effective_from: string;
  readonly reason: string;
}

/**
 * END — close the exact currently-open row, leaving the restaurant with none.
 *
 * Carries NO commercial facts: ending terms states a boundary, not a price. Nothing is
 * auto-created to fill the gap, and the historical rows are retained — "ended" is not
 * "deleted".
 *
 * `ended_at` is REQUIRED and never defaulted to now. The operator is recording when the
 * terms stopped applying, which is frequently not the moment they got round to typing
 * it.
 */
export interface EndSubscriptionTermsRequest {
  readonly expected_terms_id: string;
  readonly ended_at: string;
  readonly reason: string;
}

/**
 * What a successful service-configuration write returns.
 *
 * `commercial` IS THE SAME CANONICAL PROJECTION `GET` RETURNS — the server re-reads it
 * inside the mutation's own transaction and hands back the state the write actually
 * produced, rather than an echo of what was asked for. So the client adopts it
 * wholesale and never manufactures a `set_at`, derives a `configured`, or issues a
 * second GET to learn what it was just told.
 *
 * `changed` DISTINGUISHES A REAL WRITE FROM A NO-OP RETRY, and it is not decoration.
 * The server deliberately answers a same-state request with success and
 * `changed: false` — even when `expected_current` has gone stale — so that a lost
 * response followed by an exact retry does not become a false conflict and does not
 * re-stamp attribution. Both outcomes are successes; only the operator-facing sentence
 * differs, and a `changed: false` must never be described as a new decision.
 */
export interface CommercialMutationResult {
  readonly changed: boolean;
  readonly commercial: CommercialSummary;
}

/**
 * ══ TRANSITIONAL COMPATIBILITY — NOT THE COMMERCIAL DOMAIN ════════════════════════
 *
 * Everything from here to the end of this section is the pre-Step-3E contract. The
 * backend still sends it, deliberately and unchanged, so a deployed client is not
 * reinterpreted underneath it — `restaurant_reads.subscription_summary` calls leaving
 * `has_commercial_subscription` False "the single most important line in this module to
 * leave alone", because the deployed portal rendered that boolean as **Active**.
 *
 * WHERE THESE DISAGREE WITH `commercial`, `commercial` WINS. They are typed here for
 * two reasons and no others: the wire carries them, and a reconciliation surface (the
 * Overview "Legacy record" block) reads the three columns that still vary. NO NEW
 * CONSUMER MAY BE BUILT ON THEM, nothing may fall back to them when `commercial` is
 * unconfigured, and no canonical value may be inferred from them.
 */

/**
 * The LEGACY subscription columns on `Restaurant`, named for what they are.
 *
 * `has_commercial_subscription` IS FROZEN FALSE ON THE SERVER and stays false even for
 * a restaurant with open subscription terms. That is deliberate, not a gap waiting to
 * be filled: the deployed portal rendered this boolean as **Active**, and an open terms
 * row does not prove a payment was ever collected. Nothing may branch on it any more —
 * `commercial.subscription_terms` is the answer, in honest vocabulary.
 *
 * Everything prefixed `legacy_` is a column nothing currently maintains. In particular
 * `legacy_validity_flag` defaults True and is not evidence that any invoice exists,
 * which is why nothing in this application may render it as paid, active or current.
 * These three still VARY per restaurant, which is why the fenced-off Overview "Legacy
 * record" block can usefully show them for reconciliation.
 */
export interface SubscriptionSummary {
  readonly source: string;
  readonly has_commercial_subscription: boolean;
  readonly legacy_validity_flag: boolean;
  readonly legacy_expiry_at: string | null;
  /** `per_order` | `monthly` | `yearly` — how Dinify bills, not how the diner pays. */
  readonly preferred_method: string | null;
}

/**
 * The pre-Step-3E "payment mode", FROZEN at its Step-1 meaning: permanently null and
 * unconfigured, for every restaurant, forever.
 *
 * IT IS NOT WIRED TO `payment_collection_mode`, on either side. The backend refused to
 * point this key at the new domain precisely because "payment mode" was a placeholder
 * for a concept nobody had modelled, and Step 3B then modelled TWO — a service-model
 * axis and a custody axis — neither of which is what the old ambiguous label promised.
 *
 * SO THIS CARRIES NO INFORMATION. It is typed only because the wire still carries it,
 * and because the canonical-beats-legacy regression fixtures need to be able to state a
 * legacy half that contradicts `commercial`. NOTHING RENDERS IT.
 */
export interface PaymentModeSummary {
  readonly payment_mode: string | null;
  readonly payment_mode_configured: boolean;
}

/** The fields the directory row and the detail payload share, byte for byte. */
interface RestaurantCommon extends PaymentModeSummary {
  readonly id: string;
  /**
   * THE CANONICAL COMMERCIAL ANSWER, on the SHARED shape because the server computes
   * it once and sends the same object to both reads. It is deliberately not
   * detail-only: the directory's Payment and Subscription-terms columns read exactly
   * what the workspace reads, so a row and a header cannot disagree.
   */
  readonly commercial: CommercialSummary;
  readonly name: string;
  readonly location: string | null;
  readonly status: LifecycleState;
  /**
   * PLATFORM-OWNED. `Restaurant.is_test` (migration `restaurants_app/0057`) marks a
   * tenant that is not a real commercial customer. Distinct from `Order.is_test`,
   * which marks one order as commercially invisible — see `LatestOrder`.
   */
  readonly is_test: boolean;
  readonly readiness: ReadinessSummary;
  readonly subscription: SubscriptionSummary;
  readonly last_activity_at: string | null;
  readonly needs_attention: boolean;
}

/** One row of `GET /restaurants/`. */
export interface RestaurantRow extends RestaurantCommon {
  readonly open_issue_count: number;
}

/**
 * The owner, from `serialize_owner`. `null` when the restaurant has no owner row.
 *
 * ── `claim_tracked` / `claim_status` ARE BACKEND COMPATIBILITY ALIASES ────────────
 *
 * They are no longer always false/null: Step 2C gave the admin plane a real onboarding
 * domain, and these two fields now MIRROR it —
 *
 *   `claim_tracked`  mirrors `RestaurantDetail.onboarding.tracked`
 *   `claim_status`   mirrors `onboarding.owner_control.status` while tracked, null
 *                    otherwise
 *
 * `RestaurantDetail.onboarding` is the CANONICAL, richer contract, and it is what this
 * application renders: it also carries provenance, the owner-relationship check, the
 * evidence behind owner control and the invitation state, none of which these two
 * fields can express. The aliases are kept in the type because the server still sends
 * them and a consumer elsewhere may still read them — NOT so a second screen can grow
 * its own answer to a question `onboarding` already answers. Two sources of truth for
 * one fact is how the portal starts disagreeing with itself.
 *
 * Do not widen them, do not derive presentation from them, and do not render them
 * alongside the onboarding panel.
 */
export interface RestaurantOwner {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone_number: string | null;
  readonly is_active: boolean;
  readonly claim_tracked: boolean;
  readonly claim_status: string | null;
}

/** `orders_app` spells exactly these seven. */
export type OrderStatus =
  | 'initiated'
  | 'pending'
  | 'preparing'
  | 'served'
  | 'paid'
  | 'refunded'
  | 'cancelled';

export interface LatestOrder {
  readonly id: string;
  readonly created_at: string | null;
  readonly order_status: OrderStatus;
  /**
   * `Order.is_test` — operationally real, commercially invisible. True either because
   * the tenant itself is a test tenant or because the order was a pre-go-live
   * rehearsal. Different fact from `Restaurant.is_test`, and never inferred from it.
   */
  readonly is_test: boolean;
}

export interface OperationsSummary {
  readonly table_count: number;
  /** Tables a QR scan can actually start an order at: enabled, active, in service. */
  readonly usable_table_count: number;
  readonly dining_area_count: number;
  readonly latest_order: LatestOrder | null;
}

/** `AdminAuditLog.result`. */
export type ActivityResult = 'success' | 'failure' | 'denied';

/**
 * One audit row for Overview's recent-activity strip — NARRATIVE SUBSTRATE ONLY.
 *
 * No before/after state, no source IP, no user agent, no request id: the endpoint
 * deliberately does not return them, and the full Activity screen (spec §12) is where
 * forensic detail belongs. Nothing in this repo may ask for them here.
 */
export interface ActivityEntry {
  readonly id: string;
  readonly timestamp: string | null;
  /** A dotted `admin.<domain>.<verb>` action. Open vocabulary — the backend appends. */
  readonly action: string;
  readonly result: ActivityResult;
  /** A display name, an email, or the literal typed at a failed sign-in. */
  readonly actor: string | null;
}

/**
 * ══ THE ADMIN ONBOARDING DOMAIN (Step 2C) ═════════════════════════════════════════
 *
 * Five closed vocabularies the backend spells exactly, mirroring the Step 2C contract
 * that is already merged, deployed and empirically accepted. They are enumerated here
 * for the same reason lifecycle state is: a state the server grows becomes a compile
 * error rather than a blank cell.
 *
 * WHAT THIS DOMAIN IS FOR. Before Step 2C the portal could not tell "this restaurant
 * has an owner row" from "somebody demonstrably controls this restaurant's owner
 * account", so it said neither and rendered "Not tracked yet" for everyone. The server
 * can now distinguish, separately:
 *
 *   - whether the restaurant is represented in the onboarding domain at all;
 *   - HOW it got there (created here, or adopted from before the domain existed);
 *   - whether `Restaurant.owner` agrees with who actually holds active owner access;
 *   - whether control of the CURRENT owner is established, and by WHAT evidence;
 *   - the invitation lifecycle, where invitations apply at all.
 *
 * Those are five different questions. Nothing in this application may answer one of
 * them using another's value — see `restaurant.labels.ts`.
 */

/** How a restaurant entered the admin onboarding domain. */
export type OnboardingSource = 'admin_created' | 'legacy_adopted';

/**
 * Whether `Restaurant.owner` agrees with active owner-role membership. A STRUCTURAL
 * check about roles — it says nothing about whether anyone controls the account.
 */
export type OwnerRelationshipStatus =
  | 'unavailable'
  | 'consistent'
  | 'missing_owner_membership'
  | 'multiple_owner_memberships'
  | 'owner_membership_mismatch';

/**
 * Whether control of the CURRENT owner's account is established.
 *
 * `attested` and `invitation_redeemed` are both established, by different evidence —
 * an administrator's attestation is not an observed sign-in, and the portal must not
 * describe one as the other. `stale_attestation` is evidence that exists but applies
 * to a PREVIOUS owner, which establishes nothing about the current one.
 */
export type OwnerControlStatus =
  | 'unavailable'
  | 'not_established'
  | 'attested'
  | 'invitation_redeemed'
  | 'stale_attestation';

/** What established (or purported to establish) owner control. */
export type OwnerControlEvidence = 'legacy_attestation' | 'invitation_redeemed';

/**
 * The owner-invitation lifecycle, exactly as `onboarding_reads` spells it.
 *
 * `not_applicable` and `not_issued` ARE DIFFERENT FACTS and must never be collapsed:
 * a legacy-adopted restaurant never had an invitation to issue, while an
 * admin-created one has simply not had one issued yet. Reading the first as the
 * second invents a missing step for every restaurant that predates the domain.
 *
 * `verification_locked` (backend Step 2F.2) is an UNRESOLVED state, like `expired`:
 * the credential still holds the per-onboarding slot, can still be reissued and can
 * still be cancelled — it simply can no longer be challenged or redeemed, because its
 * owner-claim guess budget is spent. The server reports it AHEAD of `expired`
 * deliberately: both are unclaimable and both are remedied by a reissue, but only one
 * of them says somebody sat there guessing, and filing a security event as a clock
 * problem is the wrong way round. This union was stale without it — the Admin
 * frontend predates that backend step — and a status the type does not know renders
 * as a humanised code rather than as a compile error.
 */
export type OwnerInvitationStatus =
  | 'unavailable'
  | 'not_applicable'
  | 'not_issued'
  | 'pending'
  | 'expired'
  | 'verification_locked'
  | 'consumed'
  | 'cancelled'
  | 'superseded';

/** The three UNRESOLVED states — the credential still occupies the slot. */
export const UNRESOLVED_OWNER_INVITATION_STATUSES: readonly OwnerInvitationStatus[] = [
  'pending',
  'expired',
  'verification_locked',
];

/**
 * The invitation axis of the onboarding projection — a state word plus the SAFE
 * metadata that makes it actionable (backend Step 2E).
 *
 * `id` IS THE CONCURRENCY TOKEN: it is exactly what the reissue and cancel routes take
 * as `expected_invitation_id`, and it is the only way an operator can act on the
 * invitation they actually reviewed rather than on whatever is current when the POST
 * arrives. `issued_at` / `expires_at` are what make `pending` and `expired` legible.
 *
 * NOTHING ELSE, and nothing else may be added here. No `token_hash`, no raw claim
 * token, no claim URL, no delivery state, no attempt count, no owner identity. An
 * invitation id is an opaque handle; the token is a credential; the two must never
 * become interchangeable because they sit in the same object. All three metadata keys
 * are present and null for `not_issued` / `not_applicable` / `unavailable`, so a
 * consumer never has to branch on the status word to know which keys exist.
 */
export interface OwnerInvitationProjection {
  readonly status: OwnerInvitationStatus;
  readonly id: string | null;
  readonly issued_at: string | null;
  readonly expires_at: string | null;
}

/**
 * The onboarding projection carried by the DETAIL read.
 *
 * `tracked` is false for a restaurant the domain holds no record of; `source` and
 * `recorded_at` are then null and the three nested statuses are `unavailable`. That is
 * a statement that the questions have NOT BEEN EVALUATED — not that they were
 * evaluated and failed.
 *
 * `recorded_at` IS NOT THE RESTAURANT'S CREATION DATE. It is when the restaurant
 * entered the ADMIN ONBOARDING DOMAIN, which for a legacy-adopted tenant is long after
 * it started trading. `RestaurantDetail.created_at` is the other one.
 */
export interface OnboardingSummary {
  readonly tracked: boolean;
  readonly source: OnboardingSource | null;
  readonly recorded_at: string | null;

  readonly owner_relationship: {
    readonly status: OwnerRelationshipStatus;
  };

  readonly owner_control: {
    readonly status: OwnerControlStatus;
    readonly evidence: OwnerControlEvidence | null;
    readonly evidence_at: string | null;
  };

  readonly invitation: OwnerInvitationProjection;
}

/** `GET /restaurants/<uuid>/` — the workspace header and the Overview tab. */
export interface RestaurantDetail extends RestaurantCommon {
  /** Read off the lifecycle service. Step 4 turns these into controls; not here. */
  readonly allowed_transitions: readonly LifecycleState[];
  readonly created_at: string | null;
  readonly owner: RestaurantOwner | null;
  /**
   * DETAIL ONLY, and deliberately so. `GET /restaurants/` did not gain onboarding —
   * the directory answers "which restaurants need me", and five more per-row states
   * would be five more columns nobody scans. `RestaurantRow` must not grow this.
   */
  readonly onboarding: OnboardingSummary;
  readonly support: { readonly open_issue_count: number };
  readonly operations: OperationsSummary;
  readonly recent_activity: readonly ActivityEntry[];
}

export interface DirectoryPagination {
  readonly page: number;
  readonly page_size: number;
  readonly count: number;
  /** At least 1 even for an empty result, so the portal always has a page to render. */
  readonly pages: number;
}

export interface RestaurantDirectoryPage {
  readonly results: readonly RestaurantRow[];
  readonly pagination: DirectoryPagination;
}

/**
 * The directory query. EXACTLY the parameters `KNOWN_PARAMS` accepts, and no others.
 *
 * The backend's query string is DENY-BY-DEFAULT: an unrecognised key is a 400, not a
 * cheerfully unfiltered 200. So this application sends only what it owns and never
 * forwards an unknown parameter from `location.search`.
 */
export interface DirectoryQuery {
  readonly search: string | null;
  readonly status: LifecycleState | null;
  readonly attention: boolean | null;
  readonly page: number;
  readonly pageSize: number | null;
}

/** The server's default. Sending it explicitly would only lengthen every URL. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * ══ THE RESTAURANT CREATION CONTRACT (Step 2G, over backend Step 2D) ══════════════
 *
 * `POST admin/v1/restaurants/` — the SAME collection route the directory reads,
 * because creating a restaurant is adding to that collection. There is deliberately
 * no `/restaurants/create/`, no `/restaurants/new/` API route and no customer-plane
 * creation path anywhere; the method carries the meaning, not the URL. (The Angular
 * screen lives at `/restaurants/new` — a UI address, not an API one.)
 *
 * ── THE OWNER IS A DISCRIMINATED UNION, AND EACH MODE REFUSES THE OTHER'S FIELDS ──
 *
 * The backend reads which keys were SENT, not which were non-blank: a `user_id` key
 * beside `mode: "new"` is a 400 even when its value is empty, because a key the caller
 * sent is a claim they made about the request. So the request body is built by a
 * function that includes only the chosen mode's fields, never by spreading a form
 * object that happens to hold both drafts — see `restaurant-create.page.ts`.
 *
 * "This phone number already exists, so that must be who you meant" is the failure
 * the split exists to prevent. A phone already in use is a 409
 * `owner_account_already_exists` carrying ONLY the existing account's UUID, and
 * attaching that account is a separate, deliberate `mode: "existing"` request naming
 * it. Nothing on this client ever switches modes on the operator's behalf.
 *
 * ── `is_test` IS A JSON BOOLEAN, STRICTLY ─────────────────────────────────────────
 *
 * The server's `StrictBooleanField` refuses `1`, `"true"`, `"yes"` and `null`: a
 * tenant's test classification decides whether it appears in every revenue figure,
 * and that decision has to be made by an operator saying so. It is typed `boolean`
 * here and stated explicitly by the form — never inferred from the name, the
 * location, the owner, the environment or a mock convention.
 */
export type OwnerMode = 'new' | 'existing';

/** `mode: "new"` — a brand-new owner identity. Phone is the identity; email is not. */
export interface NewOwnerSpec {
  readonly mode: 'new';
  readonly first_name: string;
  readonly last_name: string;
  /** Passed through RAW. Canonicalising a Ugandan MSISDN is `normalise_msisdn`'s job. */
  readonly phone_number: string;
  /** Optional. An explicit `null` states its absence rather than omitting the key. */
  readonly email: string | null;
}

/** `mode: "existing"` — attach an exact existing account, named by its UUID. */
export interface ExistingOwnerSpec {
  readonly mode: 'existing';
  readonly user_id: string;
}

export type OwnerSpec = NewOwnerSpec | ExistingOwnerSpec;

export interface CreateRestaurantRequest {
  readonly restaurant: {
    readonly name: string;
    readonly location: string;
    readonly is_test: boolean;
  };
  readonly owner: OwnerSpec;
  readonly reason: string;
}

/**
 * The credential half of a creation or a reissue response.
 *
 * `claim_token` IS THE RAW BEARER CREDENTIAL AND THIS IS THE ONLY TIME IT IS EVER
 * RETURNED. The server persists only its SHA-256 hash, so a lost response is
 * unrecoverable by design and the remedy is a REISSUE — never recoverable plaintext,
 * never the hash handed back as a token, never a "retry returns the same token".
 *
 * On this side it may exist ONLY in the transient state of the component that shows
 * it to the authenticated operator. It is never written to localStorage,
 * sessionStorage, IndexedDB, a cookie, a URL, router navigation state,
 * `RestaurantWorkspaceStore`, a canonical restaurant model, a notice, a log or an
 * error object. A refresh loses it, and that is the accepted cost.
 *
 * THERE IS NO CLAIM URL. The owner types this code into the restaurant portal's
 * owner-claim screen; nothing here fabricates a link carrying it.
 */
export interface IssuedOwnerInvitation {
  readonly id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly claim_token: string;
}

/**
 * What a successful `POST admin/v1/restaurants/` returns (201).
 *
 * `restaurant` is the canonical DETAIL projection, re-read inside the creation
 * transaction — the same bytes `GET /restaurants/<id>/` returns. The workspace still
 * loads it through its ordinary read rather than adopting this copy: the screen the
 * operator lands on must be built from the canonical read, and this object also
 * travels beside a credential that must not be carried anywhere it does not need to be.
 *
 * `owner_account.created` is STATED by the operation, never re-derived — a brand-new
 * account and a long-standing one are indistinguishable a moment later.
 */
export interface RestaurantCreationResult {
  readonly restaurant: RestaurantDetail;
  readonly owner_account: {
    readonly id: string;
    readonly created: boolean;
  };
  readonly owner_invitation: IssuedOwnerInvitation;
}

/**
 * The 409 vocabulary of creation — `onboarding_creation.CONFLICT_CODES`.
 *
 * A conflict is a well-formed request the platform's current state contradicts, so
 * the remedy is to look and decide again, never to edit the body blindly. Two of them
 * carry a `details` object of UUIDs only: `owner_account_already_exists` names the
 * existing account (so an operator can DELIBERATELY choose `mode: "existing"`), and
 * `restaurant_already_exists` names the existing restaurant. The email conflict
 * deliberately names no account at all.
 */
export type RestaurantCreationConflictCode =
  | 'owner_account_already_exists'
  | 'owner_email_already_in_use'
  | 'owner_account_not_found'
  | 'owner_account_inactive'
  | 'owner_account_not_restaurant_user'
  | 'restaurant_already_exists';

/**
 * ══ THE OWNER-INVITATION LIFECYCLE CONTRACT (Step 2G, over backend Step 2E) ═══════
 *
 * Two routes, two named operations, ONE body shape — the server shares one
 * serializer between them because the contract is genuinely identical: the exact
 * invitation reviewed, plus why.
 *
 * `expected_invitation_id` IS AN OPTIMISTIC-CONCURRENCY ASSERTION OF IDENTITY, NOT
 * STATUS. It says "the invitation I reviewed is still the one this onboarding
 * presents as its head". It is `OnboardingSummary.invitation.id`, captured when the
 * operator opened the action and never re-read at submit time; if the head has since
 * moved to another invitation the server answers 409 `stale_owner_invitation`, and
 * an old Cancel click can never terminate a credential the operator has never seen.
 * REQUIRED with no default: an omitted token is a 400, never "act on whatever is
 * current".
 *
 * `reissue`, NOT `resend`. Nothing in this system delivers anything — no email, no
 * SMS, no notification, no delivery column on the schema. What happens is ROTATION:
 * the outstanding credential dies and a new raw token is handed to the operator who
 * asked, exactly once.
 */
export interface OwnerInvitationRequest {
  readonly expected_invitation_id: string;
  readonly reason: string;
}

/**
 * A successful reissue. `onboarding` is the canonical Step-2C projection re-read
 * inside the same transaction — byte-identical to the next GET — and is adopted;
 * `owner_invitation` carries the new credential ONCE, in its own object, so no
 * future change to the canonical projection can start carrying it by accident.
 * `changed` is always true: a reissue that changed nothing is not a thing.
 */
export interface OwnerInvitationReissueResult {
  readonly changed: true;
  readonly onboarding: OnboardingSummary;
  readonly owner_invitation: IssuedOwnerInvitation;
}

/**
 * A successful cancellation. NO CREDENTIAL, ever — which is exactly why an EXACT RETRY
 * is safe here and impossible on reissue: repeating a cancellation answers
 * `changed: false` with the original timestamp and actor intact, and that is a
 * SUCCESS, never a failure and never a conflict.
 */
export interface OwnerInvitationCancelResult {
  readonly changed: boolean;
  readonly onboarding: OnboardingSummary;
}

/**
 * The 409 vocabulary of the two invitation routes — `onboarding_invitations`'s
 * `CONFLICT_CODES` plus the three owner-consistency codes the reissue route flattens
 * into the same map. Every conflict body carries a fixed operator sentence and the
 * code, and deliberately NO `details`: naming the current invitation id would invite a
 * blind retry instead of a reload.
 */
export type OwnerInvitationConflictCode =
  | 'onboarding_not_tracked'
  | 'owner_invitation_not_applicable'
  | 'stale_owner_invitation'
  | 'owner_invitation_not_issued'
  | 'owner_control_already_established'
  | 'owner_account_not_found'
  | 'owner_account_inactive'
  | 'owner_account_not_restaurant_user'
  | 'owner_invitation_already_resolved'
  | OwnerRelationshipStatus;
