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
 *   2. WHERE IT DOES NOT, THIS DOES NOT INVENT ONE. `payment_mode` has no
 *      authoritative field on the server at all and `readiness.blockers` carries
 *      codes Step 3 has not written yet. Declaring a union for either would be a
 *      guess with a type annotation on it.
 *
 * NULLS ARE MEANINGFUL AND ARE PRESERVED. A null `location`, a null
 * `last_activity_at`, a null `latest_order` and a null `payment_mode` each say
 * something different from an empty string or a zero, and the transport layer
 * normalises none of them away.
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
 * The LEGACY subscription columns on `Restaurant`, named for what they are.
 *
 * `has_commercial_subscription` is the key to branch on: it is False for every
 * restaurant today and becomes True when `RestaurantSubscription` lands. Everything
 * prefixed `legacy_` is a column nothing currently maintains — in particular
 * `legacy_validity_flag` defaults True and is not evidence that any invoice exists,
 * which is why nothing in this application may render it as paid, active or current.
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
 * The commercial payment mode — `cash_only`, a PSP-backed mode, or whatever Step 2/3
 * settles on. `payment_mode` is null and `payment_mode_configured` is false for every
 * restaurant today because THERE IS NO SUCH FIELD on the server yet.
 *
 * `require_order_prepayments` is a diner-checkout toggle and is deliberately absent
 * from this contract; inferring one from the other would produce a confident answer
 * that is wrong for any restaurant that configured prepayment for its own reasons.
 */
export interface PaymentModeSummary {
  readonly payment_mode: string | null;
  readonly payment_mode_configured: boolean;
}

/** The fields the directory row and the detail payload share, byte for byte. */
interface RestaurantCommon extends PaymentModeSummary {
  readonly id: string;
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
 * `claim_tracked` is false and `claim_status` is null for everyone, and they are
 * present rather than absent for a reason: an account existing is not the same as an
 * owner having claimed it. Step 2 builds the difference; until then the portal says
 * "not tracked yet" instead of inferring a claim from a `User` row.
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

/** `GET /restaurants/<uuid>/` — the workspace header and the Overview tab. */
export interface RestaurantDetail extends RestaurantCommon {
  /** Read off the lifecycle service. Step 4 turns these into controls; not here. */
  readonly allowed_transitions: readonly LifecycleState[];
  readonly created_at: string | null;
  readonly owner: RestaurantOwner | null;
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
