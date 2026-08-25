import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { RestaurantHttp } from './restaurant.http';
import {
  CommercialMutationResult,
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

  /**
   * ══ THE SERVICE-CONFIGURATION WRITES (Step 3E.2) ═══════════════════════════════
   *
   * TWO NAMED OPERATIONS, TWO NAMED ROUTES. What these assert is that the transport is
   * a pipe in the write direction too: it posts the caller's exact body to the exact
   * endpoint, unwraps the envelope, and hands back the canonical projection unchanged.
   * It defaults nothing, coalesces nothing and reshapes nothing.
   *
   * The CSRF header, the bounded refresh-and-replay and the elevation replay are NOT
   * re-tested here. They belong to the interceptors, which have their own suite, and
   * duplicating them would create a second place for the same rules to drift.
   */
  describe('service-configuration writes', () => {
    const TIMING_URL = `/api/admin/v1/restaurants/${DETAIL_ID}/commercial/payment-timing/`;
    const COLLECTION_URL =
      `/api/admin/v1/restaurants/${DETAIL_ID}/commercial/payment-collection-mode/`;

    /** The success envelope, exactly as `commercial_base.success` builds it. */
    function envelope(changed: boolean, commercial: CommercialSummary) {
      return { status: 200, message: 'Payment timing recorded.', data: { changed, commercial } };
    }

    it('POSTs payment timing to its OWN route, with the exact body', () => {
      http
        .setPaymentTiming(DETAIL_ID, {
          value: 'pay_after',
          expected_current: 'pay_first',
          reason: 'Switching to table service',
        })
        .subscribe();

      const request = controller.expectOne(TIMING_URL);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        value: 'pay_after',
        expected_current: 'pay_first',
        reason: 'Switching to table service',
      });
      request.flush(envelope(true, CONFIGURED_COMMERCIAL));
    });

    it('POSTs collection mode to its OWN route, with the exact body', () => {
      http
        .setPaymentCollectionMode(DETAIL_ID, {
          value: 'psp_online',
          expected_current: 'offline',
          reason: 'Moving to provider-initiated collection',
        })
        .subscribe();

      const request = controller.expectOne(COLLECTION_URL);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        value: 'psp_online',
        expected_current: 'offline',
        reason: 'Moving to provider-initiated collection',
      });
      request.flush(envelope(true, CONFIGURED_COMMERCIAL));
    });

    it('TRANSMITS expected_current AS AN ACTUAL JSON NULL, never omitted', () => {
      // THE MOST IMPORTANT ASSERTION IN THIS BLOCK. The server requires the key and
      // separately allows it to be null: an explicit null is the assertion "nobody had
      // configured this when I loaded it", and an OMITTED key is no assertion at all —
      // a 400. `JSON.stringify` drops an `undefined` property, so the difference between
      // the two is one coalesce away, and it is invisible at the type level.
      for (const [label, url, body] of [
        ['timing', TIMING_URL, { value: 'pay_first', expected_current: null, reason: 'Initial service model setup' }],
        ['collection', COLLECTION_URL, { value: 'offline', expected_current: null, reason: 'Initial collection setup' }],
      ] as const) {
        if (label === 'timing') {
          http.setPaymentTiming(DETAIL_ID, body as never).subscribe();
        } else {
          http.setPaymentCollectionMode(DETAIL_ID, body as never).subscribe();
        }

        const request = controller.expectOne(url);
        const sent = request.request.body as Record<string, unknown>;

        expect(Object.keys(sent)).withContext(`${label}: key present`).toContain('expected_current');
        expect(sent['expected_current']).withContext(`${label}: literal null`).toBeNull();
        // Serialised, which is where an `undefined` would actually vanish.
        expect(JSON.stringify(sent))
          .withContext(`${label}: survives serialisation`)
          .toContain('"expected_current":null');

        request.flush(envelope(true, UNCONFIGURED_COMMERCIAL));
      }
    });

    it('unwraps the envelope to {changed, commercial}', () => {
      let received: CommercialMutationResult | undefined;
      http
        .setPaymentTiming(DETAIL_ID, {
          value: 'pay_first',
          expected_current: null,
          reason: 'Initial service model setup',
        })
        .subscribe((value) => (received = value));

      controller.expectOne(TIMING_URL).flush(envelope(true, CONFIGURED_COMMERCIAL));

      expect(received?.changed).toBeTrue();
      // Passed through UNCHANGED — the write response is the same canonical projection
      // a GET returns, so the client adopts it rather than rebuilding one.
      expect(received?.commercial).toEqual(CONFIGURED_COMMERCIAL);
    });

    it('passes a changed:false no-op through as a SUCCESS', () => {
      // The server answers a same-state request this way even when the concurrency
      // assertion has gone stale, so a lost response plus an exact retry is not a false
      // conflict. The transport must not reinterpret it as anything but a 200.
      let received: CommercialMutationResult | undefined;
      let errored = false;
      http
        .setPaymentCollectionMode(DETAIL_ID, {
          value: 'offline',
          expected_current: null,
          reason: 'Re-sending after a lost response',
        })
        .subscribe({ next: (value) => (received = value), error: () => (errored = true) });

      controller
        .expectOne(COLLECTION_URL)
        .flush({ status: 200, message: 'Payment collection mode recorded.', data: { changed: false, commercial: CONFIGURED_COMMERCIAL } });

      expect(errored).toBeFalse();
      expect(received?.changed).toBeFalse();
      expect(received?.commercial).toEqual(CONFIGURED_COMMERCIAL);
    });

    it('surfaces a 409 as an error carrying its status and code', () => {
      const seen: { status: number; code: unknown }[] = [];
      http
        .setPaymentTiming(DETAIL_ID, {
          value: 'pay_after',
          expected_current: null,
          reason: 'Attempting against a stale token',
        })
        .subscribe({
          next: () => fail('a conflict must not produce a value'),
          error: (error: { status: number; error: { code?: string } }) =>
            seen.push({ status: error.status, code: error.error?.code }),
        });

      controller.expectOne(TIMING_URL).flush(
        {
          status: 409,
          message: 'Commercial configuration changed since it was loaded.',
          code: 'stale_service_configuration',
        },
        { status: 409, statusText: 'Conflict' },
      );

      expect(seen).toEqual([{ status: 409, code: 'stale_service_configuration' }]);
    });

    it('encodes the restaurant id into the path segment', () => {
      http
        .setPaymentTiming('a/../b', {
          value: 'pay_first',
          expected_current: null,
          reason: 'Encoding check for the route helper',
        })
        .subscribe();

      // A malformed id must not escape its segment on a WRITE either.
      controller.expectOne('/api/admin/v1/restaurants/a%2F..%2Fb/commercial/payment-timing/').flush(
        envelope(true, CONFIGURED_COMMERCIAL),
      );
    });

    // ── SUBSCRIPTION TERMS (Step 3E.3) ─────────────────────────────────────────────

    const RECORD_URL = `/api/admin/v1/restaurants/${DETAIL_ID}/commercial/subscription-terms/`;
    const REPLACE_URL =
      `/api/admin/v1/restaurants/${DETAIL_ID}/commercial/subscription-terms/replace/`;
    const END_URL = `/api/admin/v1/restaurants/${DETAIL_ID}/commercial/subscription-terms/end/`;

    const TERMS_ID = '5d6e7f80-9a1b-4c2d-8e3f-000000000001';

    /** The five commercial facts, exactly as a form would state them. */
    const FACTS = {
      recurring_amount: '150000.00',
      currency: 'UGX',
      billing_interval_unit: 'month',
      billing_interval_count: 1,
      effective_from: '2026-08-01T00:00:00+03:00',
    } as const;

    it('POSTs each terms operation to its OWN route — three routes, never one', () => {
      // THREE EXPLICIT ROUTES, not one with an `action`. Recording first terms,
      // superseding the open ones and closing them are materially different decisions
      // with different preconditions and different concurrency tokens; a shared path
      // segment would make "what did this operator do?" a question about an argument.
      http
        .recordSubscriptionTerms(DETAIL_ID, { ...FACTS, reason: 'Recording the signed price' })
        .subscribe();
      expect(controller.expectOne(RECORD_URL).request.method).toBe('POST');
      controller.expectNone(REPLACE_URL);
      controller.expectNone(END_URL);
      controller.verify();

      http
        .replaceSubscriptionTerms(DETAIL_ID, {
          expected_terms_id: TERMS_ID,
          ...FACTS,
          reason: 'Uplift agreed for the new quarter',
        })
        .subscribe();
      expect(controller.expectOne(REPLACE_URL).request.method).toBe('POST');
      controller.expectNone(RECORD_URL);
      controller.expectNone(END_URL);
      controller.verify();

      http
        .endSubscriptionTerms(DETAIL_ID, {
          expected_terms_id: TERMS_ID,
          ended_at: '2026-09-01T00:00:00+03:00',
          reason: 'Restaurant is leaving the platform',
        })
        .subscribe();
      expect(controller.expectOne(END_URL).request.method).toBe('POST');
      controller.expectNone(RECORD_URL);
      controller.expectNone(REPLACE_URL);
    });

    it('sends RECORD with the five facts and a reason — and NO expected_terms_id', () => {
      // THE CONTRACT. `record` means "record terms only if none are open", which the
      // server enforces under the restaurant lock. A token here would be a field the
      // caller has to supply and nothing would check — so its ABSENCE is the assertion.
      http
        .recordSubscriptionTerms(DETAIL_ID, { ...FACTS, reason: 'Recording the signed price' })
        .subscribe();

      const sent = controller.expectOne(RECORD_URL).request.body as Record<string, unknown>;
      expect(sent).toEqual({ ...FACTS, reason: 'Recording the signed price' });
      expect(Object.keys(sent)).not.toContain('expected_terms_id');
      expect(JSON.stringify(sent)).not.toContain('expected_terms_id');
    });

    it('sends the amount as a decimal STRING, never a JSON number', () => {
      // The backend's `StrictDecimalStringField` refuses a JSON number outright, and
      // `"0.00"` versus `0.0` is precisely the distinction that would be lost. A single
      // `Number()` anywhere on this path reintroduces the float the whole round trip
      // exists to keep out.
      for (const amount of ['150000.00', '0.00', '150000.50']) {
        http
          .recordSubscriptionTerms(DETAIL_ID, {
            ...FACTS,
            recurring_amount: amount,
            reason: 'Checking the decimal survives the wire',
          })
          .subscribe();

        const sent = controller.expectOne(RECORD_URL).request.body as Record<string, unknown>;
        expect(typeof sent['recurring_amount']).withContext(amount).toBe('string');
        expect(sent['recurring_amount']).withContext(amount).toBe(amount);
        expect(JSON.stringify(sent))
          .withContext(amount)
          .toContain(`"recurring_amount":"${amount}"`);
        controller.verify();
      }
    });

    it('sends REPLACE with the token FIRST-CLASS, as the UUID string the read published', () => {
      // A UUID, not a value — the difference from an axis's `expected_current`. The
      // backend refuses a JSON number here for a specific reason: DRF's `UUIDField` would
      // turn `42` into a well-formed UUID no row has ever carried, and the request would
      // come back as a 409 saying the terms changed when nothing had.
      http
        .replaceSubscriptionTerms(DETAIL_ID, {
          expected_terms_id: TERMS_ID,
          ...FACTS,
          recurring_amount: '175000.00',
          reason: 'Uplift agreed for the new quarter',
        })
        .subscribe();

      const sent = controller.expectOne(REPLACE_URL).request.body as Record<string, unknown>;
      expect(sent['expected_terms_id']).toBe(TERMS_ID);
      expect(typeof sent['expected_terms_id']).toBe('string');
      expect(sent).toEqual({
        expected_terms_id: TERMS_ID,
        ...FACTS,
        recurring_amount: '175000.00',
        reason: 'Uplift agreed for the new quarter',
      });
    });

    it('sends END with exactly three fields — token, boundary and reason', () => {
      // Ending terms changes ONE thing: when they stopped applying. There is no amount
      // to restate, and a body carrying the commercial facts would invite a server that
      // read them.
      http
        .endSubscriptionTerms(DETAIL_ID, {
          expected_terms_id: TERMS_ID,
          ended_at: '2026-09-01T00:00:00+03:00',
          reason: 'Restaurant is leaving the platform',
        })
        .subscribe();

      const sent = controller.expectOne(END_URL).request.body as Record<string, unknown>;
      expect(sent).toEqual({
        expected_terms_id: TERMS_ID,
        ended_at: '2026-09-01T00:00:00+03:00',
        reason: 'Restaurant is leaving the platform',
      });
      for (const absent of ['recurring_amount', 'currency', 'billing_interval_unit', 'value']) {
        expect(Object.keys(sent)).withContext(absent).not.toContain(absent);
      }
    });

    it('transmits both timestamps with an EXPLICIT offset, never naive', () => {
      // The backend's `AwareDateTimeField` refuses a naive value rather than assuming
      // one, and Step 3C refuses it again underneath. The difference between midnight
      // EAT and midnight UTC is three hours of "which terms were in force", and an
      // operator in another timezone would never see the substitution happen.
      const aware = /(Z|[+-]\d{2}:\d{2})$/;

      http
        .recordSubscriptionTerms(DETAIL_ID, { ...FACTS, reason: 'Recording the signed price' })
        .subscribe();
      const recorded = controller.expectOne(RECORD_URL).request.body as Record<string, string>;
      expect(recorded['effective_from']).toMatch(aware);
      controller.verify();

      http
        .endSubscriptionTerms(DETAIL_ID, {
          expected_terms_id: TERMS_ID,
          ended_at: '2026-09-01T12:00:00Z',
          reason: 'Restaurant is leaving the platform',
        })
        .subscribe();
      const ended = controller.expectOne(END_URL).request.body as Record<string, string>;
      expect(ended['ended_at']).toMatch(aware);
    });

    it('unwraps each terms envelope to {changed, commercial}', () => {
      // Every one of them returns the WHOLE canonical projection, exactly as the axis
      // writes and the GET do — which is what lets the client adopt rather than rebuild.
      for (const [url, call] of [
        [RECORD_URL, () => http.recordSubscriptionTerms(DETAIL_ID, { ...FACTS, reason: 'Recording the signed price' })],
        [REPLACE_URL, () => http.replaceSubscriptionTerms(DETAIL_ID, { expected_terms_id: TERMS_ID, ...FACTS, reason: 'Uplift agreed for the new quarter' })],
        [END_URL, () => http.endSubscriptionTerms(DETAIL_ID, { expected_terms_id: TERMS_ID, ended_at: '2026-09-01T00:00:00+03:00', reason: 'Restaurant is leaving the platform' })],
      ] as const) {
        let received: CommercialMutationResult | undefined;
        call().subscribe((value) => (received = value));
        controller
          .expectOne(url)
          .flush({ status: 200, message: 'ok', data: { changed: true, commercial: CONFIGURED_COMMERCIAL } });

        expect(received?.changed).withContext(url).toBeTrue();
        expect(received?.commercial).withContext(url).toEqual(CONFIGURED_COMMERCIAL);
      }
    });

    it('passes a terms changed:false no-op through as a SUCCESS', () => {
      let received: CommercialMutationResult | undefined;
      let errored = false;
      http
        .recordSubscriptionTerms(DETAIL_ID, { ...FACTS, reason: 'Re-sending after a lost response' })
        .subscribe({ next: (value) => (received = value), error: () => (errored = true) });

      controller
        .expectOne(RECORD_URL)
        .flush({ status: 200, message: 'Subscription terms recorded.', data: { changed: false, commercial: CONFIGURED_COMMERCIAL } });

      expect(errored).toBeFalse();
      expect(received?.changed).toBeFalse();
      expect(received?.commercial).toEqual(CONFIGURED_COMMERCIAL);
    });

    it('surfaces each terms 409 with its own code intact', () => {
      // FOUR DISTINCT CONFLICTS, and they are not interchangeable: "already has different
      // open terms" and "has no open terms" call for opposite next actions. The transport
      // must not flatten them.
      for (const [url, call, code] of [
        [RECORD_URL, () => http.recordSubscriptionTerms(DETAIL_ID, { ...FACTS, reason: 'Recording against a stale view' }), 'subscription_terms_already_open'],
        [REPLACE_URL, () => http.replaceSubscriptionTerms(DETAIL_ID, { expected_terms_id: TERMS_ID, ...FACTS, reason: 'Replacing against a stale view' }), 'stale_subscription_terms'],
        [END_URL, () => http.endSubscriptionTerms(DETAIL_ID, { expected_terms_id: TERMS_ID, ended_at: '2026-09-01T00:00:00+03:00', reason: 'Ending against a stale view' }), 'no_open_subscription_terms'],
      ] as const) {
        const seen: { status: number; code: unknown }[] = [];
        call().subscribe({
          next: () => fail('a conflict must not produce a value'),
          error: (error: { status: number; error: { code?: string } }) =>
            seen.push({ status: error.status, code: error.error?.code }),
        });

        controller
          .expectOne(url)
          .flush(
            { status: 409, message: 'Subscription terms changed since they were loaded.', code },
            { status: 409, statusText: 'Conflict' },
          );

        expect(seen).withContext(url).toEqual([{ status: 409, code }]);
      }
    });

    it('encodes the restaurant id into every terms path segment', () => {
      http
        .recordSubscriptionTerms('a/../b', { ...FACTS, reason: 'Encoding check for the route helper' })
        .subscribe();
      controller
        .expectOne('/api/admin/v1/restaurants/a%2F..%2Fb/commercial/subscription-terms/')
        .flush({ status: 200, message: 'ok', data: { changed: true, commercial: CONFIGURED_COMMERCIAL } });

      http
        .replaceSubscriptionTerms('a/../b', { expected_terms_id: TERMS_ID, ...FACTS, reason: 'Encoding check for the route helper' })
        .subscribe();
      controller
        .expectOne('/api/admin/v1/restaurants/a%2F..%2Fb/commercial/subscription-terms/replace/')
        .flush({ status: 200, message: 'ok', data: { changed: true, commercial: CONFIGURED_COMMERCIAL } });

      http
        .endSubscriptionTerms('a/../b', { expected_terms_id: TERMS_ID, ended_at: '2026-09-01T00:00:00+03:00', reason: 'Encoding check for the route helper' })
        .subscribe();
      controller
        .expectOne('/api/admin/v1/restaurants/a%2F..%2Fb/commercial/subscription-terms/end/')
        .flush({ status: 200, message: 'ok', data: { changed: true, commercial: CONFIGURED_COMMERCIAL } });
    });

    it('exposes exactly the named operations, and NO generic mutation', () => {
      // SEVEN NAMED OPERATIONS, and nothing that takes a URL, a field name or an action.
      // A generic writer would make "what did this operator change?" a question about an
      // argument rather than about which operation was called — and would let one future
      // grant of access reach all of them.
      //
      // `#write` is a REAL hash-private method for this reason. A TypeScript `private` one
      // is erased at runtime and leaves a callable `write(route, body)` on the instance,
      // which is the exact surface this test exists to refuse. That is not hypothetical:
      // this assertion caught it.
      const surface = http as unknown as Record<string, unknown>;
      for (const named of [
        'list',
        'detail',
        'setPaymentTiming',
        'setPaymentCollectionMode',
        'recordSubscriptionTerms',
        'replaceSubscriptionTerms',
        'endSubscriptionTerms',
      ]) {
        expect(typeof surface[named]).withContext(`${named} is part of the port`).toBe('function');
      }
      for (const forbidden of [
        'post',
        'write',
        'mutate',
        'mutateCommercial',
        'setCommercialField',
        'setAxis',
        'writeSubscriptionTerms',
        'mutateSubscriptionTerms',
        'setSubscriptionTerms',
        'updateSubscriptionTerms',
        'deleteSubscriptionTerms',
        'cancelSubscription',
      ]) {
        expect(typeof surface[forbidden])
          .withContext(`${forbidden} must not be part of the public API`)
          .not.toBe('function');
      }
    });
  });
});
