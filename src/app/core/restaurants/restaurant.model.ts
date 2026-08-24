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
 * The owner-invitation lifecycle.
 *
 * `not_applicable` and `not_issued` ARE DIFFERENT FACTS and must never be collapsed:
 * a legacy-adopted restaurant never had an invitation to issue, while an
 * admin-created one has simply not been sent theirs yet. Reading the first as the
 * second invents a missing step for every restaurant that predates the domain.
 */
export type OwnerInvitationStatus =
  | 'unavailable'
  | 'not_applicable'
  | 'not_issued'
  | 'pending'
  | 'expired'
  | 'consumed'
  | 'cancelled'
  | 'superseded';

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

  readonly invitation: {
    readonly status: OwnerInvitationStatus;
  };
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
