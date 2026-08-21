import {
  ActivityEntry,
  LifecycleState,
  OperationsSummary,
  RestaurantDetail,
  RestaurantOwner,
  RestaurantRow,
} from '../core/restaurants/restaurant.model';

/**
 * The development corpus behind `MockRestaurantApi`. DEVELOPMENT ONLY.
 *
 * ── THESE ARE NOT RICHER THAN THE BACKEND ─────────────────────────────────────────
 *
 * The temptation with fixtures is to invent the product you wish existed — a
 * subscription that is Paid, a payment mode that is Cash only, an owner who has
 * Claimed. Every one of those would make the review pleasant and the screen a lie,
 * and the first real deploy would then look broken by comparison.
 *
 * So the mock derives exactly what the SERVER derives:
 *
 *   readiness       — `not_ready` + [`readiness_not_configured`] while onboarding
 *                     (the seam fails closed), `not_applicable` otherwise
 *   needs_attention — onboarding AND readiness not ready, the one condition
 *                     `restaurant_reads.needs_attention` recognises today
 *   payment mode    — null / unconfigured, because there is no field
 *   subscription    — the legacy Restaurant columns, labelled legacy
 *   owner claim     — `claim_tracked: false`, `claim_status: null`
 *
 * Derived rather than written out per row, so a fixture cannot disagree with the rule.
 *
 * ── WHAT THE CORPUS IS SHAPED TO SHOW ─────────────────────────────────────────────
 *
 * Every state an operator has to be able to tell apart on sight: onboarding with
 * attention, an ordinary live tenant, a live TEST tenant, a suspended one, an
 * offboarded one, open support issues and none, a restaurant with no admin activity
 * at all, a missing location, a missing owner, a rehearsal (TEST) latest order, a
 * restaurant with no orders — and enough rows to page through at the default 25.
 */

/** A stable, uuid4-shaped id per fixture. Deterministic so deep links survive reloads. */
function id(index: number): string {
  const hex = (index + 1).toString(16).padStart(12, '0');
  return `9a7f1c${(index + 16).toString(16).padStart(2, '0')}-4b2e-4f3a-9c1d-${hex}`;
}

interface Seed {
  readonly name: string;
  readonly location: string | null;
  readonly status: LifecycleState;
  readonly isTest?: boolean;
  readonly openIssues?: number;
  /** Hours ago. `null` means this restaurant has never been acted on. */
  readonly lastActivityHoursAgo?: number | null;
  readonly owner?: Partial<RestaurantOwner> | null;
  readonly operations?: Partial<OperationsSummary>;
  readonly latestOrderHoursAgo?: number | null;
  readonly latestOrderTest?: boolean;
  readonly activity?: readonly (readonly [action: string, hoursAgo: number, result: ActivityEntry['result'], actor: string | null])[];
  readonly legacyValid?: boolean;
  readonly legacyExpiryDaysAhead?: number | null;
  readonly preferredMethod?: string | null;
}

const SEEDS: readonly Seed[] = [
  {
    // ONBOARDING + NEEDS ATTENTION — the one condition the flag recognises today.
    name: 'Ankole Grill House',
    location: 'Kololo, Kampala',
    status: 'onboarding',
    openIssues: 1,
    lastActivityHoursAgo: 3,
    owner: { name: 'Miriam Nakato', email: 'miriam@ankolegrill.ug', phone_number: '256772140388' },
    operations: { table_count: 12, usable_table_count: 9, dining_area_count: 2 },
    latestOrderHoursAgo: 5,
    latestOrderTest: true, // A pre-go-live REHEARSAL order: real, commercially invisible.
    activity: [
      ['admin.delegation.session_ended', 3, 'success', 'Simon Mugambi'],
      ['admin.delegation.minted', 4, 'success', 'Simon Mugambi'],
      ['admin.restaurant.transition_denied', 26, 'denied', 'Simon Mugambi'],
      ['admin.auth.elevated', 26, 'success', 'Simon Mugambi'],
    ],
    legacyExpiryDaysAhead: 21,
  },
  {
    // The ordinary live tenant: nothing wrong, nothing to do.
    name: 'Kampala Bistro',
    location: 'Nakasero, Kampala',
    status: 'live',
    openIssues: 0,
    lastActivityHoursAgo: 52,
    owner: { name: 'David Okello', email: 'david@kampalabistro.ug', phone_number: '256701552910' },
    operations: { table_count: 24, usable_table_count: 24, dining_area_count: 3 },
    latestOrderHoursAgo: 1,
    activity: [['admin.restaurant.lifecycle_transition', 52, 'success', 'Simon Mugambi']],
    legacyExpiryDaysAhead: 96,
    preferredMethod: 'monthly',
  },
  {
    // A LIVE TEST TENANT — the treatment has to survive being next to a real one.
    name: 'Dinify Demo Kitchen',
    location: 'Internal',
    status: 'live',
    isTest: true,
    openIssues: 0,
    lastActivityHoursAgo: 9,
    owner: { name: 'Simon Mugambi', email: 'ops@dinifyapp.com', phone_number: '256780000001' },
    operations: { table_count: 4, usable_table_count: 4, dining_area_count: 1 },
    latestOrderHoursAgo: 2,
    latestOrderTest: true,
    activity: [['admin.restaurant.lifecycle_transition', 9, 'success', 'Simon Mugambi']],
  },
  {
    name: 'Nile Perch House',
    location: 'Jinja',
    status: 'suspended',
    openIssues: 4,
    lastActivityHoursAgo: 14,
    owner: {
      name: 'Grace Atim',
      email: 'grace@nileperch.ug',
      phone_number: '256772883014',
      is_active: false,
    },
    operations: { table_count: 18, usable_table_count: 11, dining_area_count: 2 },
    latestOrderHoursAgo: 15,
    activity: [
      ['admin.restaurant.lifecycle_transition', 14, 'success', 'Simon Mugambi'],
      ['admin.auth.elevated', 14, 'success', 'Simon Mugambi'],
      ['admin.delegation.action_denied', 40, 'denied', 'Simon Mugambi'],
    ],
    legacyValid: false,
    legacyExpiryDaysAhead: -6,
  },
  {
    name: 'Speke Road Cafe',
    location: null, // No location recorded — the cell must not render "null".
    status: 'onboarding',
    openIssues: 0,
    lastActivityHoursAgo: null, // NEVER ACTED ON from the control plane.
    owner: { name: null, email: 'owner@spekeroadcafe.ug', phone_number: '256759410772' },
    operations: { table_count: 0, usable_table_count: 0, dining_area_count: 0 },
    latestOrderHoursAgo: null, // No orders at all.
    activity: [],
  },
  {
    name: 'Garden City Rooftop',
    location: 'Kampala Central',
    status: 'live',
    openIssues: 11,
    lastActivityHoursAgo: 6,
    owner: { name: 'Peter Ssemakula', email: 'peter@gardencityrooftop.ug', phone_number: '256703112884' },
    operations: { table_count: 31, usable_table_count: 28, dining_area_count: 4 },
    latestOrderHoursAgo: 0.4,
    activity: [
      ['admin.delegation.session_started', 6, 'success', 'Simon Mugambi'],
      ['admin.delegation.minted', 6, 'success', 'Simon Mugambi'],
    ],
    preferredMethod: 'yearly',
  },
  {
    name: 'Entebbe Lakeside Kitchen',
    location: 'Entebbe',
    status: 'offboarded',
    openIssues: 0,
    lastActivityHoursAgo: 1_900,
    owner: null, // No owner row — the Overview renders that honestly.
    operations: { table_count: 9, usable_table_count: 0, dining_area_count: 1 },
    latestOrderHoursAgo: 2_100,
    activity: [['admin.restaurant.lifecycle_transition', 1_900, 'success', 'Simon Mugambi']],
    legacyValid: false,
    legacyExpiryDaysAhead: -70,
  },
  {
    name: 'Bugolobi Shawarma Bar',
    location: 'Bugolobi, Kampala',
    status: 'onboarding',
    openIssues: 2,
    lastActivityHoursAgo: 30,
    owner: { name: 'Aisha Namusoke', email: 'aisha@bugolobishawarma.ug', phone_number: '256788221094' },
    operations: { table_count: 6, usable_table_count: 5, dining_area_count: 1 },
    latestOrderHoursAgo: null,
    activity: [['admin.auth.login_success', 30, 'success', 'Simon Mugambi']],
  },
  {
    name: 'Mbarara Steakhouse',
    location: 'Mbarara',
    status: 'live',
    openIssues: 1,
    lastActivityHoursAgo: 200,
    owner: { name: 'Julius Tumusiime', email: 'julius@mbararasteak.ug', phone_number: '256772660418' },
    operations: { table_count: 15, usable_table_count: 15, dining_area_count: 2 },
    latestOrderHoursAgo: 3,
  },
  {
    name: 'Gulu Highway Diner',
    location: 'Gulu',
    status: 'suspended',
    openIssues: 0,
    lastActivityHoursAgo: 700,
    owner: { name: 'Betty Aciro', email: 'betty@guluhighway.ug', phone_number: '256701998233' },
    operations: { table_count: 10, usable_table_count: 4, dining_area_count: 1 },
    latestOrderHoursAgo: 720,
    legacyValid: false,
  },
];

/**
 * Filler so the directory pages at the default 25 per page. Deliberately plain — the
 * distinctions worth reviewing are all in the seeds above, and a corpus where every
 * row is remarkable teaches nothing about scanning an ordinary one.
 */
const FILLER_NAMES: readonly string[] = [
  'Acacia Avenue Kitchen', 'Bwaise Rolex Point', 'Cafe Javas Ntinda', 'Ddungu Fish Grill',
  'Elgon View Restaurant', 'Fort Portal Coffee House', 'Ggaba Beach Bar', 'Hoima Road Canteen',
  'Ishasha Ridge Cafe', 'Jinja Road Kitchen', 'Kabale Highlands Grill', 'Lugogo Deli',
  'Masaka Junction Diner', 'Ntinda Pork Joint', 'Owino Market Canteen', 'Port Bell Fish House',
  'Queensway Chicken Grill', 'Rubaga Family Kitchen', 'Ssese Islands Cafe', 'Tororo Rock Diner',
  'Ug Street Food Co', 'Victoria Mall Eatery', 'Wandegeya Bites', 'Yumbe Corner Kitchen',
];

const FILLER_LOCATIONS: readonly string[] = ['Kampala', 'Wakiso', 'Entebbe', 'Jinja', 'Mbarara'];
const FILLER_STATUSES: readonly LifecycleState[] = ['live', 'live', 'onboarding', 'live', 'suspended'];

const FILLER_SEEDS: readonly Seed[] = FILLER_NAMES.map((name, index) => ({
  name,
  location: FILLER_LOCATIONS[index % FILLER_LOCATIONS.length],
  status: FILLER_STATUSES[index % FILLER_STATUSES.length],
  openIssues: index % 4 === 0 ? (index % 3) + 1 : 0,
  lastActivityHoursAgo: index % 5 === 0 ? null : (index + 1) * 11,
  owner: {
    name: `Owner ${index + 1}`,
    email: `owner${index + 1}@example.ug`,
    phone_number: `2567${String(70000000 + index).padStart(8, '0')}`,
  },
  operations: {
    table_count: 4 + (index % 17),
    usable_table_count: 2 + (index % 13),
    dining_area_count: 1 + (index % 3),
  },
  latestOrderHoursAgo: index % 6 === 0 ? null : index + 2,
}));

const ALL_SEEDS: readonly Seed[] = [...SEEDS, ...FILLER_SEEDS];

// --- derivation, mirroring platform_admin_app/restaurant_reads.py -----------------

/**
 * A FIXED clock, so a review session is reproducible and the EAT formatting can be
 * checked against a known instant. Advanced only by reloading, never per render.
 */
const NOW_MS = Date.parse('2026-08-21T12:00:00+03:00');

function isoHoursAgo(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined) return null;
  return new Date(NOW_MS - hours * 3_600_000).toISOString();
}

function isoDaysAhead(days: number | null | undefined): string | null {
  if (days === null || days === undefined) return null;
  return new Date(NOW_MS + days * 86_400_000).toISOString();
}

/** `check_go_live_readiness` fails closed, and only for a restaurant still onboarding. */
function readiness(status: LifecycleState) {
  if (status !== 'onboarding') {
    return { state: 'not_applicable' as const, blocker_count: 0, blockers: [] };
  }
  return {
    state: 'not_ready' as const,
    blocker_count: 1,
    blockers: ['readiness_not_configured'],
  };
}

function subscription(seed: Seed) {
  return {
    source: 'legacy_restaurant_fields',
    has_commercial_subscription: false,
    legacy_validity_flag: seed.legacyValid ?? true,
    legacy_expiry_at: isoDaysAhead(seed.legacyExpiryDaysAhead ?? null),
    preferred_method: seed.preferredMethod ?? 'per_order',
  };
}

function row(seed: Seed, index: number): RestaurantRow {
  const state = readiness(seed.status);
  return {
    id: id(index),
    name: seed.name,
    location: seed.location,
    status: seed.status,
    is_test: seed.isTest ?? false,
    readiness: state,
    payment_mode: null,
    payment_mode_configured: false,
    subscription: subscription(seed),
    open_issue_count: seed.openIssues ?? 0,
    last_activity_at: isoHoursAgo(seed.lastActivityHoursAgo),
    needs_attention: state.state === 'not_ready',
  };
}

function owner(seed: Seed, index: number): RestaurantOwner | null {
  if (seed.owner === null) return null;
  const supplied = seed.owner ?? {};
  return {
    id: `1f2e3d4c-5b6a-4978-8899-${String(index + 1).padStart(12, '0')}`,
    name: supplied.name ?? 'Unnamed Owner',
    email: supplied.email ?? null,
    phone_number: supplied.phone_number ?? null,
    is_active: supplied.is_active ?? true,
    // Never inferred from the existence of a User row — Step 2 builds the difference.
    claim_tracked: false,
    claim_status: null,
  };
}

function operations(seed: Seed, index: number): OperationsSummary {
  const supplied = seed.operations ?? {};
  const latestAt = isoHoursAgo(seed.latestOrderHoursAgo);
  return {
    table_count: supplied.table_count ?? 0,
    usable_table_count: supplied.usable_table_count ?? 0,
    dining_area_count: supplied.dining_area_count ?? 0,
    latest_order:
      latestAt === null
        ? null
        : {
            id: `7c8d9e0f-1a2b-4c3d-8e4f-${String(index + 1).padStart(12, '0')}`,
            created_at: latestAt,
            order_status: seed.status === 'live' ? 'paid' : 'served',
            is_test: seed.latestOrderTest ?? seed.isTest ?? false,
          },
  };
}

function activity(seed: Seed, index: number): readonly ActivityEntry[] {
  return (seed.activity ?? []).map(([action, hoursAgo, result, actor], entry) => ({
    id: `3b4c5d6e-7f80-4192-a3b4-${String(index * 10 + entry).padStart(12, '0')}`,
    timestamp: isoHoursAgo(hoursAgo) as string,
    action,
    result,
    actor,
  }));
}

function detail(seed: Seed, index: number): RestaurantDetail {
  const base = row(seed, index);
  return {
    ...base,
    // Read off the lifecycle matrix, exactly as `lifecycle.allowed_targets` sorts it.
    allowed_transitions: ALLOWED_TRANSITIONS[seed.status],
    created_at: isoHoursAgo(4_000 + index * 40),
    owner: owner(seed, index),
    support: { open_issue_count: base.open_issue_count },
    operations: operations(seed, index),
    recent_activity: activity(seed, index),
  };
}

/** `restaurants_app.controllers.lifecycle.ALLOWED_TRANSITIONS`, sorted as it sorts. */
const ALLOWED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  onboarding: ['live', 'offboarded'],
  live: ['offboarded', 'suspended'],
  suspended: ['live', 'offboarded'],
  offboarded: [],
};

/** Ordered `name` then `id`, matching `directory_queryset()`. */
export const MOCK_RESTAURANT_ROWS: readonly RestaurantRow[] = ALL_SEEDS.map(row).sort(compareRows);

export const MOCK_RESTAURANT_DETAILS: ReadonlyMap<string, RestaurantDetail> = new Map(
  ALL_SEEDS.map((seed, index) => [id(index), detail(seed, index)] as const),
);

function compareRows(a: RestaurantRow, b: RestaurantRow): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
