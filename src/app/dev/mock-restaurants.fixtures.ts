import {
  ActivityEntry,
  LifecycleState,
  OnboardingSource,
  OnboardingSummary,
  OperationsSummary,
  OwnerControlEvidence,
  OwnerControlStatus,
  OwnerInvitationStatus,
  OwnerRelationshipStatus,
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
 *   onboarding      — the Step 2C projection, with the SERVER's own consequences
 *                     applied (see `onboarding()` below): untracked means every nested
 *                     status is `unavailable`, a legacy-adopted restaurant's invitation
 *                     is `not_applicable` and never `not_issued`, and the evidence
 *                     follows from the control state rather than being written beside
 *                     it
 *   owner claim     — the COMPATIBILITY ALIASES, mirrored off `onboarding` exactly as
 *                     the backend mirrors them: `claim_tracked` = `onboarding.tracked`,
 *                     `claim_status` = the owner-control status while tracked
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
 *
 * Step 2C added the onboarding states to that list, because they are exactly the kind
 * of distinction that is easy to render wrongly and impossible to notice: a tenant the
 * domain has never heard of, a legacy adoption with no control evidence (the shape live
 * Baba House returns), a valid administrative attestation, a redeemed invitation, an
 * invitation still pending, each of the three owner-relationship inconsistencies, and
 * an attestation that has gone stale under a change of owner.
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
  /**
   * The Step 2C onboarding record, or `null` for a restaurant the domain has never
   * heard of. Omitted means the commonest real shape: adopted from before the domain
   * existed, structurally consistent, and no control evidence — which is exactly what
   * live Baba House returns.
   *
   * Only the ANTECEDENTS are written here. Everything the backend derives from them —
   * the invitation default, the evidence, the nulls that follow from being untracked —
   * is applied by `onboarding()` below, so a seed cannot state a combination the server
   * would never produce.
   */
  readonly onboarding?: OnboardingSeed | null;
}

interface OnboardingSeed {
  readonly source?: OnboardingSource;
  readonly recordedHoursAgo?: number;
  readonly relationship?: OwnerRelationshipStatus;
  readonly control?: OwnerControlStatus;
  /** Hours ago the evidence was recorded. Ignored where the control state has none. */
  readonly evidenceHoursAgo?: number;
  /** Only meaningful for `admin_created`; a legacy adoption is always not applicable. */
  readonly invitation?: OwnerInvitationStatus;
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
    // THE SHAPE LIVE BABA HOUSE RETURNS — adopted, consistent, no control evidence,
    // and no invitation because none ever applied. Reviewed most often, so it is first.
    onboarding: { source: 'legacy_adopted', recordedHoursAgo: 26 },
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
    // Created here, invited, and the owner redeemed it — control established by an
    // OBSERVED act. The invitation stays its own row: `consumed` and established
    // control are related facts, not one fact said twice.
    onboarding: {
      source: 'admin_created',
      recordedHoursAgo: 900,
      control: 'invitation_redeemed',
      evidenceHoursAgo: 880,
      invitation: 'consumed',
    },
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
    // A VALID LEGACY ATTESTATION: established, but by an administrator's assertion
    // rather than anything the owner did. The evidence line has to say which.
    onboarding: {
      source: 'legacy_adopted',
      recordedHoursAgo: 300,
      control: 'attested',
      evidenceHoursAgo: 290,
    },
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
    // The owner of record no longer holds active owner access — a STRUCTURAL problem,
    // and the panel must state it without guessing which identity is the right one.
    onboarding: {
      source: 'legacy_adopted',
      recordedHoursAgo: 400,
      relationship: 'missing_owner_membership',
    },
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
    // Invited and waiting. `pending` is waiting, not failing, so it stays quiet.
    onboarding: {
      source: 'admin_created',
      recordedHoursAgo: 60,
      invitation: 'pending',
    },
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
    // TWO problems at once, and they must read as two: more than one active owner, and
    // an attestation that was recorded against somebody who is no longer the owner.
    // Neither may be allowed to present the restaurant as controlled.
    onboarding: {
      source: 'legacy_adopted',
      recordedHoursAgo: 1_200,
      relationship: 'multiple_owner_memberships',
      control: 'stale_attestation',
      evidenceHoursAgo: 1_100,
    },
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
    // NOT REPRESENTED IN THE DOMAIN AT ALL. Every onboarding question reads "Not
    // tracked" — none of them was evaluated, so none of them may read as a failure.
    onboarding: null,
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
    // Created here and NOT YET INVITED. Distinct from Ankole's "not applicable": this
    // one has an invitation owing, that one never will.
    onboarding: {
      source: 'admin_created',
      recordedHoursAgo: 34,
      invitation: 'not_issued',
    },
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
    // The invitation lapsed and the two owner records disagree. Both need looking at,
    // and neither implies the other.
    onboarding: {
      source: 'admin_created',
      recordedHoursAgo: 1_500,
      relationship: 'owner_membership_mismatch',
      invitation: 'expired',
    },
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
    // Deliberately withdrawn. Cancelled and superseded were decisions, not faults, so
    // they stay quiet — only an EXPIRED invitation asks the operator to act.
    onboarding: {
      source: 'admin_created',
      recordedHoursAgo: 2_000,
      invitation: 'cancelled',
    },
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
  // Plain adoptions, like the fillers themselves — except one. `superseded` is the
  // only invitation state the named seeds above do not carry, and a state no fixture
  // ever reaches is a state nobody ever looks at.
  onboarding:
    index === 7
      ? { source: 'admin_created', recordedHoursAgo: 520, invitation: 'superseded' }
      : { source: 'legacy_adopted', recordedHoursAgo: 800 + index * 13 },
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

/**
 * The Step 2C onboarding projection, deriving everything the backend derives.
 *
 * THREE RULES ARE APPLIED HERE RATHER THAN WRITTEN PER SEED, so no fixture can state a
 * combination the server would never produce:
 *
 *   UNTRACKED IS TOTAL. No record means no provenance, no timestamp, and all three
 *   nested questions `unavailable` — never `not_established`, which would report an
 *   evaluation that never ran.
 *
 *   A LEGACY ADOPTION'S INVITATION IS ALWAYS `not_applicable`. There was no invitation
 *   to issue, so a seed cannot ask for one; `not_issued` is reachable only from
 *   `admin_created`.
 *
 *   EVIDENCE FOLLOWS THE CONTROL STATE. An attestation (valid or stale) is a
 *   `legacy_attestation`; established-by-redemption is `invitation_redeemed`; the two
 *   states with no evidence carry none, and therefore no timestamp either.
 */
function onboarding(seed: Seed): OnboardingSummary {
  if (seed.onboarding === null) return UNTRACKED;

  const settings = seed.onboarding ?? {};
  const source = settings.source ?? 'legacy_adopted';
  const control = settings.control ?? 'not_established';
  const evidence = CONTROL_EVIDENCE[control];
  const recordedHoursAgo = settings.recordedHoursAgo ?? 500;

  return {
    tracked: true,
    source,
    recorded_at: isoHoursAgo(recordedHoursAgo),
    owner_relationship: { status: settings.relationship ?? 'consistent' },
    owner_control: {
      status: control,
      evidence,
      evidence_at:
        evidence === null ? null : isoHoursAgo(settings.evidenceHoursAgo ?? recordedHoursAgo),
    },
    invitation: {
      status:
        source === 'legacy_adopted' ? 'not_applicable' : (settings.invitation ?? 'not_issued'),
    },
  };
}

/** Not represented in the domain: every question unevaluated, and none of them failed. */
const UNTRACKED: OnboardingSummary = {
  tracked: false,
  source: null,
  recorded_at: null,
  owner_relationship: { status: 'unavailable' },
  owner_control: { status: 'unavailable', evidence: null, evidence_at: null },
  invitation: { status: 'unavailable' },
};

const CONTROL_EVIDENCE: Record<OwnerControlStatus, OwnerControlEvidence | null> = {
  unavailable: null,
  not_established: null,
  attested: 'legacy_attestation',
  // Stale evidence is still evidence — it is a legacy attestation that has stopped
  // applying. Hiding it would leave "Stale evidence" with nothing to point at.
  stale_attestation: 'legacy_attestation',
  invitation_redeemed: 'invitation_redeemed',
};

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

function owner(seed: Seed, index: number, record: OnboardingSummary): RestaurantOwner | null {
  if (seed.owner === null) return null;
  const supplied = seed.owner ?? {};
  return {
    id: `1f2e3d4c-5b6a-4978-8899-${String(index + 1).padStart(12, '0')}`,
    name: supplied.name ?? 'Unnamed Owner',
    email: supplied.email ?? null,
    phone_number: supplied.phone_number ?? null,
    is_active: supplied.is_active ?? true,
    // THE COMPATIBILITY ALIASES, mirrored off the canonical record exactly as the
    // backend mirrors them — derived rather than written, so the mock cannot show the
    // two disagreeing when the real payload never would. Nothing in this application
    // renders them; the Onboarding panel reads `onboarding` directly.
    claim_tracked: record.tracked,
    claim_status: record.tracked ? record.owner_control.status : null,
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
  const record = onboarding(seed);
  return {
    ...base,
    // Read off the lifecycle matrix, exactly as `lifecycle.allowed_targets` sorts it.
    allowed_transitions: ALLOWED_TRANSITIONS[seed.status],
    // WHEN THE RESTAURANT WAS CREATED, which is not when the onboarding record was.
    // Deliberately older than every `recorded_at` above, because for a legacy adoption
    // it genuinely is — and a fixture where the two coincide would let the panel label
    // one as the other without anyone noticing.
    created_at: isoHoursAgo(4_000 + index * 40),
    owner: owner(seed, index, record),
    // DETAIL ONLY. `row()` above must never gain this — the directory contract did not.
    onboarding: record,
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
