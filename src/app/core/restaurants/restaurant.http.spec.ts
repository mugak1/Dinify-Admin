import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { RestaurantHttp } from './restaurant.http';
import {
  CommercialSummary,
  DirectoryQuery,
  OnboardingSummary,
  RestaurantDetail,
  RestaurantDirectoryPage,
  RestaurantRow,
} from './restaurant.model';

const LIST_URL = '/api/admin/v1/restaurants/';
const DETAIL_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** No filters, no page: the query a freshly-opened directory makes. */
const DEFAULT_QUERY: DirectoryQuery = {
  search: null,
  status: null,
  attention: null,
  page: 1,
  pageSize: null,
};

/**
 * The canonical commercial projection, with NOTHING configured — the shape a restaurant
 * that has made no commercial decisions actually returns. Every null here is one a
 * helpful `?? ''` or `?? 0` in the transport would destroy.
 */
const UNCONFIGURED_COMMERCIAL: CommercialSummary = {
  payment_timing: { configured: false, value: null, set_at: null },
  payment_collection_mode: { configured: false, value: null, set_at: null },
  subscription_terms: { configured: false, current: null },
};

/** The same projection fully populated, with a terms row on every field. */
const CONFIGURED_COMMERCIAL: CommercialSummary = {
  payment_timing: {
    configured: true,
    value: 'pay_first',
    set_at: '2026-08-24T12:00:00+00:00',
  },
  payment_collection_mode: {
    configured: true,
    value: 'psp_online',
    set_at: '2026-08-23T09:30:00+00:00',
  },
  subscription_terms: {
    configured: true,
    current: {
      id: '5d6e7f80-9a1b-4c2d-8e3f-000000000abc',
      recurring_amount: '150000.00',
      currency: 'UGX',
      billing_interval: { unit: 'month', count: 2 },
      effective_from: '2026-08-01T00:00:00+00:00',
      recorded_at: '2026-08-24T12:00:00+00:00',
    },
  },
};

/**
 * A row carrying every null the backend can actually send. Fixtures that only ever
 * hold populated values are how a transport quietly grows a `?? ''`.
 */
const SPARSE_ROW: RestaurantRow = {
  commercial: UNCONFIGURED_COMMERCIAL,
  id: DETAIL_ID,
  name: 'Speke Road Cafe',
  location: null,
  status: 'onboarding',
  is_test: false,
  readiness: { state: 'not_ready', blocker_count: 1, blockers: ['readiness_not_configured'] },
  payment_mode: null,
  payment_mode_configured: false,
  subscription: {
    source: 'legacy_restaurant_fields',
    has_commercial_subscription: false,
    legacy_validity_flag: true,
    legacy_expiry_at: null,
    preferred_method: 'per_order',
  },
  open_issue_count: 0,
  last_activity_at: null,
  needs_attention: true,
};

const TEST_ROW: RestaurantRow = {
  ...SPARSE_ROW,
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  name: 'Dinify Demo Kitchen',
  location: 'Internal',
  status: 'live',
  is_test: true,
  readiness: { state: 'not_applicable', blocker_count: 0, blockers: [] },
  open_issue_count: 3,
  last_activity_at: '2026-08-20T09:15:00+03:00',
  needs_attention: false,
};

/**
 * The Step 2C projection with every nullable field NULL — the shape a tracked legacy
 * adoption with no control evidence actually has, and the one a helpful `?? ''` or a
 * defaulted evidence would silently destroy.
 */
const SPARSE_ONBOARDING: OnboardingSummary = {
  tracked: true,
  source: 'legacy_adopted',
  recorded_at: '2026-08-22T09:14:33+03:00',
  owner_relationship: { status: 'consistent' },
  owner_control: { status: 'not_established', evidence: null, evidence_at: null },
  invitation: { status: 'not_applicable' },
};

const DETAIL: RestaurantDetail = {
  ...SPARSE_ROW,
  allowed_transitions: ['live', 'offboarded'],
  created_at: '2026-05-02T08:00:00+03:00',
  owner: {
    id: '00000000-0000-4000-8000-000000000009',
    name: null,
    email: 'owner@spekeroadcafe.ug',
    phone_number: '256759410772',
    is_active: true,
    // The compatibility aliases, as the server sends them alongside `onboarding`.
    claim_tracked: true,
    claim_status: 'not_established',
  },
  onboarding: SPARSE_ONBOARDING,
  support: { open_issue_count: 0 },
  operations: {
    table_count: 0,
    usable_table_count: 0,
    dining_area_count: 0,
    latest_order: null,
  },
  recent_activity: [
    {
      id: '00000000-0000-4000-8000-00000000000a',
      timestamp: '2026-08-19T14:02:00+03:00',
      action: 'admin.restaurant.lifecycle_transition',
      result: 'success',
      actor: 'Simon Mugambi',
    },
  ],
};

function page(results: readonly RestaurantRow[], count = results.length): RestaurantDirectoryPage {
  return { results, pagination: { page: 1, page_size: 25, count, pages: 1 } };
}

/**
 * THE WIRE CONTRACT, pinned against `platform_admin_app/restaurant_reads.py`.
 *
 * Two things are being defended here. First, that the client emits ONLY the parameters
 * the server accepts: its query string is deny-by-default, so a speculative `sort` or a
 * defaulted `page=1` is at best noise and at worst a 400 on a screen whose whole job is
 * to answer a question honestly. Second, that the transport NORMALISES NOTHING — every
 * null in the payload means something specific, and a helpful `?? ''` in here would
 * destroy the distinction the screens above are built to render.
 */
describe('RestaurantHttp', () => {
  let http: RestaurantHttp;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), RestaurantHttp],
    });
    http = TestBed.inject(RestaurantHttp);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  function expectList(query: DirectoryQuery): TestRequest {
    http.list(query).subscribe();
    return controller.expectOne((request) => request.url === LIST_URL);
  }

  describe('list', () => {
    it('GETs the directory route on the relative admin API base', () => {
      const request = expectList(DEFAULT_QUERY);
      expect(request.request.method).toBe('GET');
      expect(request.request.url).toBe(LIST_URL);
      request.flush({ status: 200, data: page([]) });
    });

    it('sends NO query parameters when nothing is filtered', () => {
      // `page=1` and `page_size=25` are the server's own defaults. Sending them would
      // lengthen every shareable URL and every fixture for no behavioural difference.
      const request = expectList(DEFAULT_QUERY);
      expect(request.request.params.keys()).toEqual([]);
      request.flush({ status: 200, data: page([]) });
    });

    it('encodes search, trimmed', () => {
      const request = expectList({ ...DEFAULT_QUERY, search: '  kampala  ' });
      expect(request.request.params.get('search')).toBe('kampala');
      request.flush({ status: 200, data: page([]) });
    });

    it('omits a search that is only whitespace', () => {
      const request = expectList({ ...DEFAULT_QUERY, search: '   ' });
      expect(request.request.params.has('search')).toBeFalse();
      request.flush({ status: 200, data: page([]) });
    });

    it('encodes the lifecycle status', () => {
      const request = expectList({ ...DEFAULT_QUERY, status: 'suspended' });
      expect(request.request.params.get('status')).toBe('suspended');
      request.flush({ status: 200, data: page([]) });
    });

    it('encodes attention=true', () => {
      const request = expectList({ ...DEFAULT_QUERY, attention: true });
      expect(request.request.params.get('attention')).toBe('true');
      request.flush({ status: 200, data: page([]) });
    });

    it('encodes an explicit attention=false, because the server EXCLUDES on it', () => {
      // `?attention=false` is not "no filter": it excludes the attention set. Dropping
      // it would silently answer a different question from the one that was asked.
      const request = expectList({ ...DEFAULT_QUERY, attention: false });
      expect(request.request.params.get('attention')).toBe('false');
      request.flush({ status: 200, data: page([]) });
    });

    it('omits attention entirely when no opinion is held', () => {
      const request = expectList({ ...DEFAULT_QUERY, attention: null });
      expect(request.request.params.has('attention')).toBeFalse();
      request.flush({ status: 200, data: page([]) });
    });

    it('encodes page beyond the first, and page_size only when it differs', () => {
      const request = expectList({ ...DEFAULT_QUERY, page: 3, pageSize: 50 });
      expect(request.request.params.get('page')).toBe('3');
      expect(request.request.params.get('page_size')).toBe('50');
      request.flush({ status: 200, data: page([]) });

      const atDefault = expectList({ ...DEFAULT_QUERY, pageSize: 25 });
      expect(atDefault.request.params.has('page_size')).toBeFalse();
      atDefault.flush({ status: 200, data: page([]) });
    });

    it('sends nothing beyond the five parameters the server accepts', () => {
      const request = expectList({
        search: 'nile',
        status: 'live',
        attention: true,
        page: 2,
        pageSize: 10,
      });
      expect(request.request.params.keys().sort()).toEqual([
        'attention',
        'page',
        'page_size',
        'search',
        'status',
      ]);
      request.flush({ status: 200, data: page([]) });
    });

    it('unwraps the envelope and preserves every null in the payload', () => {
      let received: RestaurantDirectoryPage | undefined;
      http.list(DEFAULT_QUERY).subscribe((value) => (received = value));

      controller
        .expectOne((request) => request.url === LIST_URL)
        .flush({
          status: 200,
          message: 'ok',
          data: { results: [SPARSE_ROW, TEST_ROW], pagination: { page: 2, page_size: 25, count: 34, pages: 2 } },
        });

      expect(received?.pagination).toEqual({ page: 2, page_size: 25, count: 34, pages: 2 });
      expect(received?.results.length).toBe(2);

      const [sparse, test] = received?.results ?? [];
      expect(sparse.location).withContext('null location survives').toBeNull();
      expect(sparse.last_activity_at).withContext('null last activity survives').toBeNull();
      expect(sparse.payment_mode).withContext('null payment mode survives').toBeNull();
      expect(sparse.subscription.legacy_expiry_at).toBeNull();
      expect(sparse.readiness.blockers).toEqual(['readiness_not_configured']);
      expect(test.is_test).toBeTrue();
      expect(test.readiness.state).toBe('not_applicable');
    });

    it('does NOT carry onboarding on a directory row', () => {
      // The directory contract deliberately did not gain onboarding: five more
      // per-row states would be five more columns nobody scans, and the question
      // "who controls this tenant" belongs on the workspace. The transport must not
      // grow a row-level projection to fill the gap.
      let received: RestaurantDirectoryPage | undefined;
      http.list(DEFAULT_QUERY).subscribe((value) => (received = value));

      controller
        .expectOne((request) => request.url === LIST_URL)
        .flush({ status: 200, data: page([SPARSE_ROW]) });

      const [row] = received?.results ?? [];
      expect(Object.keys(row)).not.toContain('onboarding');
    });
  });

  describe('detail', () => {
    it('GETs the UUID path', () => {
      http.detail(DETAIL_ID).subscribe();
      const request = controller.expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`);
      expect(request.request.method).toBe('GET');
      request.flush({ status: 200, data: DETAIL });
    });

    it('unwraps the envelope and preserves owner fields, nulls and activity', () => {
      let received: RestaurantDetail | undefined;
      http.detail(DETAIL_ID).subscribe((value) => (received = value));
      controller
        .expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`)
        .flush({ status: 200, message: 'ok', data: DETAIL });

      expect(received?.owner?.email).toBe('owner@spekeroadcafe.ug');
      expect(received?.owner?.name).withContext('a nameless owner stays null').toBeNull();
      expect(received?.operations.latest_order).withContext('no orders stays null').toBeNull();
      expect(received?.allowed_transitions).toEqual(['live', 'offboarded']);
      expect(received?.recent_activity[0].action).toBe('admin.restaurant.lifecycle_transition');
    });

    // ── THE STEP 2C ONBOARDING PROJECTION ────────────────────────────────────────
    //
    // The backend owns these semantics entirely. What is defended here is that the
    // transport is a PIPE: it does not compute onboarding, does not infer it from the
    // owner fields, does not synthesise it from the compatibility aliases, and does not
    // fill a null with something friendlier. Every one of those would be the client
    // inventing a fact about who controls a restaurant.

    it('passes the onboarding projection through byte for byte', () => {
      let received: RestaurantDetail | undefined;
      http.detail(DETAIL_ID).subscribe((value) => (received = value));
      controller
        .expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`)
        .flush({ status: 200, message: 'ok', data: DETAIL });

      expect(received?.onboarding).toEqual(SPARSE_ONBOARDING);
    });

    it('preserves every null inside owner_control rather than defaulting it', () => {
      let received: RestaurantDetail | undefined;
      http.detail(DETAIL_ID).subscribe((value) => (received = value));
      controller
        .expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`)
        .flush({ status: 200, message: 'ok', data: DETAIL });

      // "No evidence" and "some evidence recorded at the epoch" are different claims.
      expect(received?.onboarding.owner_control.evidence).toBeNull();
      expect(received?.onboarding.owner_control.evidence_at).toBeNull();
    });

    it('carries the untracked shape through without turning it into a failure', () => {
      // `tracked: false` with three `unavailable` statuses says the questions were not
      // asked. A transport that helpfully substituted `not_established` would turn that
      // into an evaluated verdict the server never reached.
      const untracked: OnboardingSummary = {
        tracked: false,
        source: null,
        recorded_at: null,
        owner_relationship: { status: 'unavailable' },
        owner_control: { status: 'unavailable', evidence: null, evidence_at: null },
        invitation: { status: 'unavailable' },
      };

      let received: RestaurantDetail | undefined;
      http.detail(DETAIL_ID).subscribe((value) => (received = value));
      controller
        .expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`)
        .flush({ status: 200, data: { ...DETAIL, onboarding: untracked } });

      expect(received?.onboarding).toEqual(untracked);
    });

    it('does not derive onboarding from the compatibility aliases, or the reverse', () => {
      // A payload where the aliases and the canonical object disagree is not something
      // the server produces — it is here so a future "helpful" reconciliation in the
      // transport fails loudly instead of silently picking a winner.
      let received: RestaurantDetail | undefined;
      http.detail(DETAIL_ID).subscribe((value) => (received = value));
      controller.expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`).flush({
        status: 200,
        data: {
          ...DETAIL,
          owner: { ...DETAIL.owner, claim_tracked: false, claim_status: null },
        },
      });

      expect(received?.onboarding.tracked).withContext('the canonical value stands').toBeTrue();
      expect(received?.onboarding.owner_control.status).toBe('not_established');
      expect(received?.owner?.claim_tracked).withContext('the alias stands too').toBeFalse();
    });

    it('keeps every closed-vocabulary value exactly as the server spelled it', () => {
      const rich: OnboardingSummary = {
        tracked: true,
        source: 'admin_created',
        recorded_at: '2026-07-01T11:00:00+03:00',
        owner_relationship: { status: 'owner_membership_mismatch' },
        owner_control: {
          status: 'stale_attestation',
          evidence: 'legacy_attestation',
          evidence_at: '2026-06-02T08:30:00+03:00',
        },
        invitation: { status: 'superseded' },
      };

      let received: RestaurantDetail | undefined;
      http.detail(DETAIL_ID).subscribe((value) => (received = value));
      controller
        .expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`)
        .flush({ status: 200, data: { ...DETAIL, onboarding: rich } });

      expect(received?.onboarding).toEqual(rich);
    });

    it('passes the canonical commercial object through on DETAIL, byte for byte', () => {
      let received: RestaurantDetail | undefined;
      http.detail(DETAIL_ID).subscribe((value) => (received = value));
      controller
        .expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`)
        .flush({ status: 200, data: { ...DETAIL, commercial: CONFIGURED_COMMERCIAL } });

      expect(received?.commercial).toEqual(CONFIGURED_COMMERCIAL);
    });

    it('surfaces a 404 as an error rather than an empty result', () => {
      const seen: number[] = [];
      http.detail(DETAIL_ID).subscribe({
        next: () => fail('a 404 must not produce a value'),
        error: (error: { status: number }) => seen.push(error.status),
      });
      controller
        .expectOne(`/api/admin/v1/restaurants/${DETAIL_ID}/`)
        .flush({ status: 404, message: 'Restaurant not found.' }, { status: 404, statusText: 'Not Found' });

      expect(seen).toEqual([404]);
    });
  });

  /**
   * ══ THE CANONICAL COMMERCIAL CONTRACT SURVIVES THE TRANSPORT UNTOUCHED ══════════
   *
   * The rule this block exists to hold: THE TRANSPORT IS A PIPE, NOT A COMMERCIAL RULES
   * ENGINE. It unwraps the envelope and hands the payload on. It does not derive
   * `configured` from a value, does not fill a null, does not reformat a decimal string,
   * does not read a legacy field, and does not invent a commercial fact the server did
   * not send — because every one of those would put a claim on screen that no row in the
   * database supports.
   */
  describe('the commercial projection', () => {
    function listedRow(commercial: CommercialSummary): RestaurantRow | undefined {
      let received: RestaurantDirectoryPage | undefined;
      http.list(DEFAULT_QUERY).subscribe((value) => (received = value));
      controller
        .expectOne((request) => request.url === LIST_URL)
        .flush({ status: 200, data: page([{ ...SPARSE_ROW, commercial }]) });
      return received?.results[0];
    }

    it('carries commercial on DIRECTORY rows', () => {
      // It is deliberately NOT detail-only: the server computes it once and sends the
      // same object to both reads, which is what makes a row and a workspace header
      // structurally incapable of disagreeing.
      expect(listedRow(CONFIGURED_COMMERCIAL)?.commercial).toEqual(CONFIGURED_COMMERCIAL);
    });

    it('preserves PARTIAL configuration exactly as sent', () => {
      // The three facts are independent and every partial combination is real. A
      // transport that normalised one axis onto the other would erase the state.
      const partial: CommercialSummary = {
        payment_timing: { configured: true, value: 'pay_after', set_at: '2026-08-24T12:00:00+00:00' },
        payment_collection_mode: { configured: false, value: null, set_at: null },
        subscription_terms: { configured: false, current: null },
      };

      const row = listedRow(partial);
      expect(row?.commercial).toEqual(partial);
      expect(row?.commercial.payment_timing.value).toBe('pay_after');
      expect(row?.commercial.payment_collection_mode.configured).toBeFalse();
    });

    it('leaves every null NULL', () => {
      const row = listedRow(UNCONFIGURED_COMMERCIAL);
      expect(row?.commercial.payment_timing.value).toBeNull();
      expect(row?.commercial.payment_timing.set_at).toBeNull();
      expect(row?.commercial.payment_collection_mode.value).toBeNull();
      expect(row?.commercial.payment_collection_mode.set_at).toBeNull();
      expect(row?.commercial.subscription_terms.current)
        .withContext('a null terms row is not an empty object')
        .toBeNull();
    });

    it('keeps recurring_amount the EXACT string the backend sent', () => {
      // The backend serialises the Decimal with `str()` so DRF's encoder cannot turn it
      // into a float. A transport that parsed it would reintroduce exactly the hazard
      // that was avoided, and a price nobody can reconcile.
      const amounts = ['150000.00', '0.00', '150000.50', '99999999.99'];
      for (const amount of amounts) {
        const row = listedRow({
          ...CONFIGURED_COMMERCIAL,
          subscription_terms: {
            configured: true,
            current: { ...CONFIGURED_COMMERCIAL.subscription_terms.current!, recurring_amount: amount },
          },
        });
        const received = row?.commercial.subscription_terms.current?.recurring_amount;
        expect(received).withContext(amount).toBe(amount);
        expect(typeof received).withContext(`${amount} stays a string`).toBe('string');
      }
    });

    it('keeps the terms id exact — it is a concurrency token, not decoration', () => {
      // Step 3C's writers take `expected_terms_id`. A value this layer reshaped would
      // make a future optimistic-concurrency assertion fail against a fact it did read.
      const row = listedRow(CONFIGURED_COMMERCIAL);
      expect(row?.commercial.subscription_terms.current?.id)
        .toBe('5d6e7f80-9a1b-4c2d-8e3f-000000000abc');
    });

    it('keeps the billing interval unit and count unchanged', () => {
      const interval = listedRow(CONFIGURED_COMMERCIAL)?.commercial.subscription_terms.current
        ?.billing_interval;
      expect(interval?.unit).toBe('month');
      expect(interval?.count).withContext('a count of 2 is not normalised to 1').toBe(2);
    });

    it('keeps every commercial timestamp unchanged', () => {
      // Formatting is the presentation layer's job, and it happens against EAT. A
      // transport that pre-formatted would leave the pages unable to distinguish
      // `set_at` from `effective_from` from `recorded_at`.
      const row = listedRow(CONFIGURED_COMMERCIAL);
      expect(row?.commercial.payment_timing.set_at).toBe('2026-08-24T12:00:00+00:00');
      expect(row?.commercial.payment_collection_mode.set_at).toBe('2026-08-23T09:30:00+00:00');
      expect(row?.commercial.subscription_terms.current?.effective_from)
        .toBe('2026-08-01T00:00:00+00:00');
      expect(row?.commercial.subscription_terms.current?.recorded_at)
        .toBe('2026-08-24T12:00:00+00:00');
    });

    it('DOES NOT DERIVE canonical state from the compatibility fields', () => {
      // The wire carries both contracts and they disagree by design: the server freezes
      // `payment_mode` null and `has_commercial_subscription` false while `commercial`
      // says otherwise. The transport must reconcile NEITHER direction — it hands both
      // on exactly as they arrived and lets the labels decide which one is authoritative.
      const row = listedRow(CONFIGURED_COMMERCIAL);

      expect(row?.commercial.payment_collection_mode.value)
        .withContext('canonical is untouched by the frozen legacy null')
        .toBe('psp_online');
      expect(row?.commercial.subscription_terms.configured)
        .withContext('canonical is untouched by the frozen legacy false')
        .toBeTrue();

      expect(row?.payment_mode).withContext('legacy is not back-filled either').toBeNull();
      expect(row?.payment_mode_configured).toBeFalse();
      expect(row?.subscription.has_commercial_subscription)
        .withContext('the frozen legacy flag is not flipped to match')
        .toBeFalse();
    });
  });
});
