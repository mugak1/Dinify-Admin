import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { RestaurantHttp } from './restaurant.http';
import {
  DirectoryQuery,
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
 * A row carrying every null the backend can actually send. Fixtures that only ever
 * hold populated values are how a transport quietly grows a `?? ''`.
 */
const SPARSE_ROW: RestaurantRow = {
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
    claim_tracked: false,
    claim_status: null,
  },
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
      expect(received?.owner?.claim_tracked).toBeFalse();
      expect(received?.owner?.claim_status).toBeNull();
      expect(received?.operations.latest_order).withContext('no orders stays null').toBeNull();
      expect(received?.allowed_transitions).toEqual(['live', 'offboarded']);
      expect(received?.recent_activity[0].action).toBe('admin.restaurant.lifecycle_transition');
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
});
