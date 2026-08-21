import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import {
  Router,
  provideRouter,
  withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject, of, throwError } from 'rxjs';

import { AdminServiceStatus } from '../core/api/service-status';
import {
  RESTAURANT_API,
  RestaurantApi,
} from '../core/restaurants/restaurant.api';
import { RestaurantWorkspaceStore } from '../core/restaurants/restaurant-workspace.store';
import {
  RestaurantDetail,
  RestaurantDirectoryPage,
} from '../core/restaurants/restaurant.model';
import { RestaurantDetailPage } from './restaurant-detail.page';
import {
  RestaurantActivityTab,
  RestaurantBillingTab,
  RestaurantOverviewTab,
  RestaurantReadinessTab,
  RestaurantSupportTab,
} from './restaurant-tabs.pages';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQUEST_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** Not an `HttpErrorResponse`: everything must classify by duck-typing. */
class WireError extends Error {
  readonly headers = {
    get: (name: string) => (name === 'X-Request-ID' ? REQUEST_ID : null),
  };
  constructor(
    readonly status: number,
    readonly error: unknown = null,
  ) {
    super(`HTTP ${status}`);
  }
}

function detail(overrides: Partial<RestaurantDetail> = {}): RestaurantDetail {
  return {
    id: ID,
    name: 'Ankole Grill House',
    location: 'Kololo, Kampala',
    status: 'onboarding',
    is_test: false,
    readiness: {
      state: 'not_ready',
      blocker_count: 1,
      blockers: ['readiness_not_configured'],
    },
    payment_mode: null,
    payment_mode_configured: false,
    subscription: {
      source: 'legacy_restaurant_fields',
      has_commercial_subscription: false,
      legacy_validity_flag: true,
      legacy_expiry_at: '2026-09-11T12:00:00+03:00',
      preferred_method: 'per_order',
    },
    last_activity_at: '2026-08-19T15:42:00+03:00',
    needs_attention: true,
    allowed_transitions: ['live', 'offboarded'],
    created_at: '2026-05-02T08:00:00+03:00',
    owner: {
      id: '00000000-0000-4000-8000-000000000009',
      name: 'Miriam Nakato',
      email: 'miriam@ankolegrill.ug',
      phone_number: '256772140388',
      is_active: true,
      claim_tracked: false,
      claim_status: null,
    },
    support: { open_issue_count: 2 },
    operations: {
      table_count: 12,
      usable_table_count: 9,
      dining_area_count: 2,
      latest_order: {
        id: '11111111-0000-4000-8000-000000000001',
        created_at: '2026-08-21T07:05:00+03:00',
        order_status: 'served',
        is_test: true,
      },
    },
    recent_activity: [
      {
        id: 'e1',
        timestamp: '2026-08-21T09:00:00+03:00',
        action: 'admin.restaurant.lifecycle_transition',
        result: 'success',
        actor: 'Simon Mugambi',
      },
      {
        id: 'e2',
        timestamp: '2026-08-20T09:00:00+03:00',
        action: 'admin.restaurant.transition_denied',
        result: 'denied',
        actor: 'Simon Mugambi',
      },
      {
        id: 'e3',
        timestamp: '2026-08-19T09:00:00+03:00',
        action: 'admin.some.future_thing',
        result: 'success',
        actor: null,
      },
    ],
    ...overrides,
  };
}

class StubApi implements RestaurantApi {
  detailCalls: string[] = [];
  answer: () => Observable<RestaurantDetail> = () => of(detail());

  list(): Observable<RestaurantDirectoryPage> {
    throw new Error('the workspace must not read the directory');
  }
  detail(id: string): Observable<RestaurantDetail> {
    this.detailCalls.push(id);
    return this.answer();
  }
}

/**
 * THE RESTAURANT WORKSPACE — the §9.1 persistent header, and Overview.
 *
 * Three things these specs exist to hold:
 *
 *   ONE READ FOR THE WHOLE WORKSPACE. The header and Overview are one screen; a
 *   second `GET /restaurants/<id>/` from the tab would let them disagree about the
 *   same restaurant, and would cost a request per tab click.
 *
 *   404 IS NOT AN OUTAGE. A missing restaurant is a real, renderable answer with a
 *   route back; a backend that is down is a different fact and must not be navigated
 *   to a "not found" that blames the link.
 *
 *   THE PORTAL SAYS ONLY WHAT THE SERVER SAID. Payment mode, subscription and the
 *   owner's claim state are each reported as unconfigured or untracked, and the raw
 *   `readiness_not_configured` code never reaches the operator.
 */
describe('RestaurantDetailPage', () => {
  let harness: RouterTestingHarness;
  let api: StubApi;

  beforeEach(() => {
    api = new StubApi();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {
              path: 'restaurants/:id',
              component: RestaurantDetailPage,
              providers: [RestaurantWorkspaceStore],
              children: [
                { path: '', component: RestaurantOverviewTab },
                { path: 'readiness', component: RestaurantReadinessTab },
                { path: 'billing', component: RestaurantBillingTab },
                { path: 'support', component: RestaurantSupportTab },
                { path: 'activity', component: RestaurantActivityTab },
              ],
            },
            { path: 'restaurants', children: [] },
          ],
          withComponentInputBinding(),
        ),
        { provide: RESTAURANT_API, useValue: api },
      ],
    });
  });

  async function open(url = `/restaurants/${ID}`): Promise<void> {
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, RestaurantDetailPage);
  }

  function el(): HTMLElement {
    return harness.routeDebugElement?.nativeElement as HTMLElement;
  }
  function text(): string {
    return el().textContent ?? '';
  }
  function settle(): void {
    harness.detectChanges();
  }
  async function loaded(url?: string): Promise<void> {
    await open(url);
    settle();
    tick();
    settle();
  }

  // --- header ---------------------------------------------------------------------

  it('shows a deliberate workspace loading state before the read lands', fakeAsync(async () => {
    const pending = new Subject<RestaurantDetail>();
    api.answer = () => pending;

    await open();
    settle();

    expect(text()).toContain('Loading restaurant');
    expect(el().querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(text()).not.toContain('Ankole Grill House');

    pending.next(detail());
    pending.complete();
    settle();
    flush();
  }));

  it('puts the real name, location, lifecycle and identifier in the persistent header', fakeAsync(async () => {
    await loaded();

    const header = el().querySelector('header') as HTMLElement;
    expect(header.textContent).toContain('Ankole Grill House');
    expect(header.textContent).toContain('Kololo, Kampala');
    expect(header.textContent).toContain('Onboarding');
    expect(header.textContent)
      .withContext('the UUID is the only identity')
      .toContain(ID);
    // No invented business key.
    expect(header.textContent).not.toMatch(/REST-\d+/);
    flush();
  }));

  it('marks a TEST tenant in the header', fakeAsync(async () => {
    api.answer = () => of(detail({ is_test: true }));
    await loaded();

    const pills = Array.from(
      el().querySelectorAll('header app-status-pill span'),
    ).map((pill) => pill.textContent?.trim());
    expect(pills).toContain('Test');
    flush();
  }));

  it('keeps the tabs as children of one persistent header', fakeAsync(async () => {
    await loaded();

    const tabs = Array.from(el().querySelectorAll('nav a')).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toEqual([
      'Overview',
      'Readiness',
      'Billing',
      'Support',
      'Activity',
    ]);
    expect(
      el().querySelector('nav a[aria-current="page"]')?.textContent?.trim(),
    ).toBe('Overview');
    flush();
  }));

  // --- primary action -------------------------------------------------------------

  it('offers Review readiness while onboarding, as a real navigation', fakeAsync(async () => {
    await loaded();

    const action = Array.from(el().querySelectorAll('header a')).find(
      (link) => link.textContent?.trim() === 'Review readiness',
    ) as HTMLAnchorElement | undefined;
    expect(action)
      .withContext('present, and an anchor because it navigates')
      .toBeTruthy();

    action!.click();
    tick();
    settle();

    expect(TestBed.inject(Router).url).toBe(`/restaurants/${ID}/readiness`);
    flush();
  }));

  // A control for capability that does not exist yet teaches an operator to distrust
  // every control beside it. Delegated drill-in is step 5 and its cross-origin handoff
  // is unbuilt; there is no suspension review to open; restoration from offboarded is
  // re-onboarding, not a transition. So they are ABSENT, not disabled.
  for (const status of ['live', 'suspended', 'offboarded'] as const) {
    it(`ships NO primary action for ${status}`, fakeAsync(async () => {
      api.answer = () => of(detail({ status, needs_attention: false }));
      await loaded();

      const labels = Array.from(el().querySelectorAll('header a, header button')).map((node) =>
        node.textContent?.trim(),
      );
      for (const fake of ['Open workspace', 'Review suspension', 'Go live', 'Restore']) {
        expect(labels).withContext(`${status}: ${fake}`).not.toContain(fake);
      }
      // Only the two links the header genuinely has.
      expect(labels).toEqual(['← Restaurants', 'Overview', 'Readiness', 'Billing', 'Support', 'Activity']);
      flush();
    }));
  }

  // --- failure states -------------------------------------------------------------

  it('renders a 404 as "no such restaurant", with a route back', fakeAsync(async () => {
    api.answer = () =>
      throwError(
        () =>
          new WireError(404, { status: 404, message: 'Restaurant not found.' }),
      );
    await loaded();

    expect(text()).toContain('No such restaurant');
    expect(text()).not.toContain('Try again');
    const back = Array.from(el().querySelectorAll('a')).find(
      (link) => link.textContent?.trim() === 'Back to Restaurants',
    );
    expect(back).toBeTruthy();
    flush();
  }));

  it('renders a non-404 failure as retryable, and never as a 404', fakeAsync(async () => {
    let failing = true;
    api.answer = () =>
      failing ? throwError(() => new WireError(500, null)) : of(detail());

    await loaded();

    // A backend outage must not be dressed up as a bad link.
    expect(text()).not.toContain('No such restaurant');
    expect(text()).toContain('could not be loaded');
    expect(text()).toContain(REQUEST_ID);

    failing = false;
    Array.from(el().querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Try again')
      ?.click();
    tick();
    settle();

    expect(text()).toContain('Ankole Grill House');
    flush();
  }));

  it('clears the outage state once the workspace read succeeds', fakeAsync(async () => {
    const status = TestBed.inject(AdminServiceStatus);
    let failing = true;
    api.answer = () => (failing ? throwError(() => new WireError(500, null)) : of(detail()));

    await loaded();
    expect(status.unavailable()).toBeTrue();

    failing = false;
    Array.from(el().querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Try again')
      ?.click();
    tick();
    settle();

    // The store owns both halves of the outage report, because no interceptor runs in
    // mock mode to clear it on the way back up.
    expect(status.unavailable()).withContext('the banner must come down').toBeFalse();
    flush();
  }));

  // --- ONE read for the workspace -------------------------------------------------

  it('reads the restaurant ONCE for the header and Overview together', fakeAsync(async () => {
    await loaded();

    expect(api.detailCalls).toEqual([ID]);
    // Overview rendered from the parent's data, not from its own request.
    expect(text()).toContain('Miriam Nakato');
    flush();
  }));

  it('does not re-read when moving between tabs', fakeAsync(async () => {
    await loaded();
    expect(api.detailCalls.length).toBe(1);

    await harness.navigateByUrl(`/restaurants/${ID}/billing`);
    settle();
    tick();
    settle();

    expect(api.detailCalls.length).withContext('still one read').toBe(1);
    expect(text()).toContain('Ankole Grill House');
    flush();
  }));
});

/**
 * Overview renders the parent's data, through the same store instance. It is tested
 * through the real route tree rather than in isolation, because "does not issue its
 * own request" is only meaningful when it is mounted the way it actually ships.
 */
describe('RestaurantOverviewTab', () => {
  let harness: RouterTestingHarness;
  let api: StubApi;

  beforeEach(() => {
    api = new StubApi();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {
              path: 'restaurants/:id',
              component: RestaurantDetailPage,
              providers: [RestaurantWorkspaceStore],
              children: [{ path: '', component: RestaurantOverviewTab }],
            },
            { path: 'restaurants', children: [] },
          ],
          withComponentInputBinding(),
        ),
        { provide: RESTAURANT_API, useValue: api },
      ],
    });
  });

  function el(): HTMLElement {
    return harness.routeDebugElement?.nativeElement as HTMLElement;
  }
  function text(): string {
    return el().textContent ?? '';
  }
  async function loaded(): Promise<void> {
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/restaurants/${ID}`, RestaurantDetailPage);
    harness.detectChanges();
    tick();
    harness.detectChanges();
  }

  it('shows the needs-attention block in operator language, never a raw code', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Needs attention');
    expect(text()).toContain(
      'Go-live readiness checks are not configured yet.',
    );
    expect(text())
      .withContext('no snake_case reaches the operator')
      .not.toContain('readiness_not_configured');
    flush();
  }));

  it('links the attention block to the Readiness tab', fakeAsync(async () => {
    await loaded();

    const link = Array.from(el().querySelectorAll('a')).find(
      (anchor) => anchor.textContent?.trim() === 'Open readiness',
    ) as HTMLAnchorElement | undefined;
    expect(link?.getAttribute('href')).toBe(`/restaurants/${ID}/readiness`);
    flush();
  }));

  it('recedes rather than celebrating when nothing needs attention', fakeAsync(async () => {
    api.answer = () =>
      of(
        detail({
          status: 'live',
          needs_attention: false,
          readiness: {
            state: 'not_applicable',
            blocker_count: 0,
            blockers: [],
          },
        }),
      );
    await loaded();

    expect(text()).not.toContain('Needs attention');
    expect(text()).not.toMatch(/Everything (is )?good/i);
    flush();
  }));

  it('shows the owner, and says the claim is not tracked', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Miriam Nakato');
    expect(text()).toContain('miriam@ankolegrill.ug');
    expect(text()).toContain('256772140388');
    expect(text()).toContain('Not tracked yet');
    // An account existing is not a claim, and must never be rendered as one.
    expect(text()).not.toMatch(/\bClaimed\b/);
    expect(text()).not.toMatch(/\bInvited\b/);
    flush();
  }));

  it('handles a restaurant with no owner row', fakeAsync(async () => {
    api.answer = () => of(detail({ owner: null }));
    await loaded();

    expect(text()).toContain('No owner account is attached');
    flush();
  }));

  it('reports payment mode as not configured, inferring nothing', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Payment mode');
    expect(text()).toContain('Not configured');
    for (const invented of ['Cash only', 'Prepay', 'Mobile money', 'PSP']) {
      expect(text()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('reports the subscription as not configured and labels the legacy columns', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Legacy record');
    // `legacy_validity_flag` is true on this fixture. It is a bare boolean nothing
    // maintains, so it may never be restated as a billing status.
    expect(text()).toContain('Set');
    for (const invented of [
      'Paid',
      'Active subscription',
      'Current',
      'In good standing',
      'Trial',
    ]) {
      expect(text()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('shows the operational counts', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Tables');
    expect(text()).toContain('12');
    expect(text()).toContain('Usable tables');
    expect(text()).toContain('9');
    expect(text()).toContain('Dining areas');
    expect(text()).toContain('2');
    flush();
  }));

  it('shows the latest order in EAT, and marks a TEST order', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Latest order');
    expect(text()).toContain('Served');
    expect(text()).toContain('EAT');
    expect(text()).toContain('21 Aug 2026');

    const pills = Array.from(el().querySelectorAll('app-status-pill span')).map(
      (pill) => pill.textContent?.trim(),
    );
    // A rehearsal order is operationally real and commercially invisible; "a rehearsal
    // happened" and "a sale happened" are different statements.
    expect(pills).toContain('Test');
    flush();
  }));

  it('says so when there are no orders', fakeAsync(async () => {
    api.answer = () =>
      of(
        detail({
          operations: {
            table_count: 0,
            usable_table_count: 0,
            dining_area_count: 0,
            latest_order: null,
          },
        }),
      );
    await loaded();

    expect(text()).toContain('No orders yet.');
    flush();
  }));

  it('renders recent activity newest-first, translating known actions', fakeAsync(async () => {
    await loaded();

    const entries = Array.from(el().querySelectorAll('li')).map(
      (item) => item.textContent ?? '',
    );
    const activity = entries.filter((entry) => entry.includes('EAT'));

    expect(activity.length).toBe(3);
    expect(activity[0]).toContain('Lifecycle changed');
    expect(activity[1]).toContain('Lifecycle change refused');
    expect(activity[1])
      .withContext('a non-success result is called out')
      .toContain('Refused');
    // An unmapped action is humanised, never blank and never raw snake_case.
    expect(activity[2]).toContain('Some future thing');
    expect(activity[2]).toContain('Unattributed');
    expect(text()).not.toContain('admin.some.future_thing');
    flush();
  }));

  it('carries no forensic detail — that is the Activity screen', fakeAsync(async () => {
    await loaded();

    for (const entry of [
      'Request ID',
      'IP address',
      'User agent',
      'before_state',
    ]) {
      expect(text()).withContext(entry).not.toContain(entry);
    }
    flush();
  }));

  it('shows a restrained empty state when nothing has happened', fakeAsync(async () => {
    api.answer = () => of(detail({ recent_activity: [] }));
    await loaded();

    expect(text()).toContain('No control-plane activity recorded');
    flush();
  }));
});
