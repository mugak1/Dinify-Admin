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
  CommercialSubscriptionTerms,
  CommercialSummary,
  OnboardingSummary,
  PaymentCollectionMode,
  PaymentTiming,
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

/**
 * THE SHAPE LIVE BABA HOUSE RETURNS, from the empirically accepted Step 2C backend.
 *
 * Tracked, adopted from before the domain existed, structurally consistent, NO control
 * evidence, and no invitation because none ever applied to it. It is used as the
 * default here because it is the commonest real shape and the easiest to render
 * wrongly — three of its five values are ones a helpful UI would upgrade.
 *
 * The SEMANTICS are the fixture. Baba House's own identifier is deliberately absent
 * from this file and from the application: nothing may branch on which restaurant it is.
 */
function onboarding(overrides: Partial<OnboardingSummary> = {}): OnboardingSummary {
  return {
    tracked: true,
    source: 'legacy_adopted',
    recorded_at: '2026-08-22T09:14:33+03:00',
    owner_relationship: { status: 'consistent' },
    owner_control: { status: 'not_established', evidence: null, evidence_at: null },
    invitation: { status: 'not_applicable' },
    ...overrides,
  };
}

/** The domain has no record of this restaurant. Every question unevaluated. */
const UNTRACKED: OnboardingSummary = {
  tracked: false,
  source: null,
  recorded_at: null,
  owner_relationship: { status: 'unavailable' },
  owner_control: { status: 'unavailable', evidence: null, evidence_at: null },
  invitation: { status: 'unavailable' },
};

/**
 * The canonical commercial projection, built the way the SERVER builds it — each axis's
 * `configured` derived from its value, `subscription_terms.configured` from whether an
 * open row exists. A builder that let a spec state `configured: true` beside a null
 * value would be asserting against a payload the backend cannot emit.
 */
function commercial(
  settings: {
    timing?: PaymentTiming;
    collection?: PaymentCollectionMode;
    terms?: Partial<CommercialSubscriptionTerms>;
  } = {},
): CommercialSummary {
  const terms = settings.terms;
  return {
    payment_timing: {
      configured: settings.timing !== undefined,
      value: settings.timing ?? null,
      set_at: settings.timing === undefined ? null : '2026-08-20T09:30:00+03:00',
    },
    payment_collection_mode: {
      configured: settings.collection !== undefined,
      value: settings.collection ?? null,
      set_at: settings.collection === undefined ? null : '2026-08-18T14:05:00+03:00',
    },
    subscription_terms: {
      configured: terms !== undefined,
      current:
        terms === undefined
          ? null
          : {
              id: '5d6e7f80-9a1b-4c2d-8e3f-000000000001',
              recurring_amount: '150000.00',
              currency: 'UGX',
              billing_interval: { unit: 'month', count: 1 },
              effective_from: '2026-08-01T00:00:00+03:00',
              recorded_at: '2026-08-03T11:20:00+03:00',
              ...terms,
            },
    },
  };
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
    commercial: commercial(),
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
      // The backend compatibility aliases, mirroring `onboarding`. Nothing in this
      // application renders them — see the Owner-panel specs at the end of this file.
      claim_tracked: true,
      claim_status: 'not_established',
    },
    onboarding: onboarding(),
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
 *   THE PORTAL SAYS ONLY WHAT THE SERVER SAID. The three canonical commercial facts —
 *   payment timing, payment collection mode and subscription terms — are each reported
 *   exactly as the server reports them, including when only some of them are configured;
 *   onboarding state is reported as tracked or not rather than guessed at; and the raw
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
  /**
   * The COMMERCIAL PANEL's text alone.
   *
   * The semantic negatives below have to be scoped, not page-wide: the Owner panel
   * legitimately renders "Account: Active" for an enabled owner account, and the
   * Operations panel legitimately renders a latest order whose status is "Paid". Both
   * are true statements about different objects. A page-wide search for those words
   * would fail on facts that are correct, and — worse — would have to be loosened to
   * pass, which is exactly how a real assertion turns into a decorative one.
   *
   * What is actually being proved is narrower and stronger: THE COMMERCIAL PANEL never
   * describes recorded terms with an account-status word.
   */
  function commercialPanel(): Element | null {
    return (harness.routeDebugElement?.nativeElement as HTMLElement).querySelector(
      '[aria-labelledby="commercial-heading"]',
    );
  }

  function commercialText(): string {
    return commercialPanel()?.textContent ?? '';
  }

  /**
   * ONE ROW of the commercial panel, addressed by its term.
   *
   * Sharper than searching the panel, and the sharpness matters: the panel also carries
   * the Readiness row, which legitimately reads "Not configured" because the go-live
   * seam fails closed until Step 3. A panel-wide negative for that phrase would fail on
   * a correct statement about a different fact — so the assertions that care about ONE
   * commercial fact address that fact directly.
   */
  function commercialRow(term: string): string {
    const terms = Array.from(commercialPanel()?.querySelectorAll('dt') ?? []);
    const dt = terms.find((node) => node.textContent?.trim() === term);
    return dt?.nextElementSibling?.textContent?.trim() ?? '';
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

  it('shows the owner as identity and contact facts only', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Miriam Nakato');
    expect(text()).toContain('miriam@ankolegrill.ug');
    expect(text()).toContain('256772140388');
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

  /**
   * ══ THE COMMERCIAL PANEL (Step 3E.1) ════════════════════════════════════════════
   *
   * Three INDEPENDENT canonical facts get three rows. The panel reads `commercial` and
   * nothing else above the fence; the legacy columns stay below it, subordinate and
   * labelled, and are never a fallback.
   */
  it('gives each canonical commercial fact its own row', fakeAsync(async () => {
    await loaded();

    expect(text()).toContain('Payment timing');
    expect(text()).toContain('Collection mode');
    expect(text()).toContain('Subscription terms');

    // The old ambiguous label is gone: the backend has two axes, not one "mode".
    expect(text()).not.toContain('Payment mode');
    flush();
  }));

  it('reports each unconfigured axis as not configured, inferring nothing', fakeAsync(async () => {
    await loaded();

    expect(commercialText()).toContain('Not configured');
    // Never inferred from `require_order_prepayments`, table configuration, transaction
    // tender, lifecycle state or `is_test`.
    for (const invented of ['Cash only', 'Prepay', 'Mobile money', 'PSP connected']) {
      expect(commercialText()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('renders both service axes with their set_at timestamps in EAT', fakeAsync(async () => {
    api.answer = () =>
      of(detail({ commercial: commercial({ timing: 'pay_first', collection: 'offline' }) }));
    await loaded();

    expect(text()).toContain('Pay first');
    expect(text()).toContain('Restaurant collects');
    // `set_at` = when the configuration DECISION was recorded. Named precisely, and
    // EAT-labelled like every other timestamp in this application.
    expect(text()).toContain('Set');
    expect(text()).toContain('EAT');
    expect(text()).toContain('20 Aug 2026');
    flush();
  }));

  it('does not describe offline as cash-only, degraded or unfinished', fakeAsync(async () => {
    api.answer = () => of(detail({ commercial: commercial({ collection: 'offline' }) }));
    await loaded();

    // A permanent, first-class mode: Dinify does not initiate the payment and the
    // restaurant collects through whatever tender it likes.
    expect(commercialText()).toContain('Dinify does not initiate the diner payment');
    for (const invented of ['Cash only', 'cash only', 'Degraded', 'Fallback', 'Pre-launch']) {
      expect(commercialText()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('does not claim psp_online means a provider is connected', fakeAsync(async () => {
    api.answer = () => of(detail({ commercial: commercial({ collection: 'psp_online' }) }));
    await loaded();

    expect(commercialText()).toContain('Dinify via PSP');
    // The mode records an INTENTION. This platform has no PSP integration at all.
    expect(commercialText()).toContain('does not confirm that a provider is connected');
    for (const invented of ['PSP connected', 'Payments live', 'Ready to collect']) {
      expect(commercialText()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('renders recorded TERMS with effective_from and recorded_at, precisely named', fakeAsync(async () => {
    api.answer = () => of(detail({ commercial: commercial({ terms: {} }) }));
    await loaded();

    expect(commercialText()).toContain('UGX 150,000 · every month');
    // The two timestamps answer DIFFERENT questions and are labelled as such:
    // `effective_from` is when the terms became commercially applicable, `recorded_at`
    // is when Dinify wrote them down. Neither is agreed, signed, activated or paid.
    expect(commercialText()).toContain('Effective from');
    expect(commercialText()).toContain('Recorded');
    for (const invented of ['Agreed', 'Signed', 'Activated', 'Paid']) {
      expect(commercialText()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('NEVER RENDERS OPEN TERMS AS AN ACCOUNT STATUS', fakeAsync(async () => {
    // The panel used to read `has_commercial_subscription ? 'Active' : 'Not configured'`.
    // An open terms row means somebody at Dinify wrote down a price — not that an
    // invoice exists, not that anything was collected, not that anyone agreed.
    api.answer = () => of(detail({ commercial: commercial({ terms: {} }) }));
    await loaded();

    expect(commercialText()).toContain('Recorded terms only');
    for (const invented of ['Active', 'Paid', 'Current account', 'In good standing', 'Trial', 'Subscribed']) {
      expect(commercialText()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('renders zero-priced terms as a real price', fakeAsync(async () => {
    api.answer = () =>
      of(detail({ commercial: commercial({ terms: { recurring_amount: '0.00' } }) }));
    await loaded();

    expect(commercialText()).toContain('UGX 0 · every month');
    for (const invented of ['Free', 'Waived', 'No subscription']) {
      expect(commercialText()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  it('keeps a stored decimal fraction on screen', fakeAsync(async () => {
    api.answer = () =>
      of(detail({ commercial: commercial({ terms: { recurring_amount: '87500.50' } }) }));
    await loaded();

    expect(commercialText()).toContain('UGX 87,500.50');
    expect(commercialText()).not.toContain('UGX 87,500 ·');
    flush();
  }));

  it('keeps the legacy record present, labelled and SUBORDINATE', fakeAsync(async () => {
    await loaded();

    expect(commercialText()).toContain('Legacy record');
    expect(commercialText()).toContain('Superseded columns');
    // It exists for reconciliation and says so, rather than reading as a second opinion
    // on the canonical rows above it.
    expect(commercialText()).toContain('the state above is authoritative');
    for (const invented of ['Paid', 'Active subscription', 'In good standing', 'Trial']) {
      expect(commercialText()).withContext(invented).not.toContain(invented);
    }
    flush();
  }));

  /**
   * ══ THE COMPATIBILITY CUT-OVER'S MOST IMPORTANT PROOF, ON THE WORKSPACE ═════════
   *
   * Same two directions the directory spec proves, asserted here on the Overview panel,
   * because "the directory is right and the workspace is wrong" is exactly the drift a
   * shared label layer exists to prevent — and a test that only covered one screen would
   * not catch it.
   */
  describe('canonical commercial state OUTRANKS the compatibility fields', () => {
    const CONTRADICTORY_LEGACY = {
      source: 'legacy_restaurant_fields',
      has_commercial_subscription: false,
      legacy_validity_flag: true,
      legacy_expiry_at: '2026-12-31T00:00:00+03:00',
      preferred_method: 'monthly',
    };

    it('CASE A — canonical configured, legacy says unconfigured: canonical wins', fakeAsync(async () => {
      api.answer = () =>
        of(
          detail({
            commercial: commercial({
              timing: 'pay_first',
              collection: 'offline',
              terms: { recurring_amount: '150000.00' },
            }),
            // Frozen legacy fields, contradicting all of the above — the real wire shape.
            payment_mode: null,
            payment_mode_configured: false,
            subscription: { ...CONTRADICTORY_LEGACY, legacy_validity_flag: false },
          }),
        );
      await loaded();

      expect(commercialRow('Payment timing')).toContain('Pay first');
      expect(commercialRow('Collection mode')).toContain('Restaurant collects');
      expect(commercialRow('Subscription terms')).toContain('UGX 150,000 · every month');

      // THE SPECIFIC FAILURE THIS GUARDS: a commercial row falling back to the frozen
      // legacy booleans and reporting a fully-configured restaurant as unconfigured.
      // Asserted per row, because Readiness sits in the same panel and says "Not
      // configured" truthfully — the seam fails closed until Step 3.
      for (const row of ['Payment timing', 'Collection mode', 'Subscription terms']) {
        expect(commercialRow(row)).withContext(row).not.toContain('Not configured');
      }
      flush();
    }));

    it('CASE B — canonical unconfigured, legacy validity TRUE: never Active', fakeAsync(async () => {
      api.answer = () =>
        of(detail({ commercial: commercial(), subscription: CONTRADICTORY_LEGACY }));
      await loaded();

      for (const row of ['Payment timing', 'Collection mode', 'Subscription terms']) {
        expect(commercialRow(row)).withContext(row).toBe('Not configured');
      }
      for (const invented of ['Active', 'Paid', 'Current account', 'In good standing', 'Trial', 'Subscribed']) {
        expect(commercialText()).withContext(invented).not.toContain(invented);
      }
      // And no note claiming terms exist, because none do.
      expect(commercialText()).not.toContain('Recorded terms only');
      flush();
    }));

    it('shows terms recorded while both service axes are still undecided', fakeAsync(async () => {
      // The three facts are independent, and one may not suppress another.
      api.answer = () =>
        of(detail({ commercial: commercial({ terms: { recurring_amount: '87500.50' } }) }));
      await loaded();

      expect(commercialRow('Subscription terms')).toContain('UGX 87,500.50 · every month');
      expect(commercialRow('Payment timing')).toBe('Not configured');
      expect(commercialRow('Collection mode')).toBe('Not configured');
      flush();
    }));
  });

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

/**
 * THE ONBOARDING PANEL — the Step 2C projection, rendered.
 *
 * ── WHAT THESE SPECS ARE DEFENDING ────────────────────────────────────────────────
 *
 * The backend can now distinguish five separate things about how a restaurant came to
 * be here and who controls it. Every failure mode of this panel is the same shape:
 * ANSWERING ONE OF THOSE QUESTIONS WITH ANOTHER'S VALUE, in a direction that reassures.
 *
 *   - reading structural CONSISTENCY as established CONTROL;
 *   - reading an administrator's ATTESTATION as the owner having claimed the account;
 *   - reading a legacy tenant's `not_applicable` invitation as one that is merely
 *     `not_issued`, inventing a step that never applied to it;
 *   - reading a STALE attestation as current control;
 *   - reading an UNTRACKED restaurant as one that was evaluated and found wanting.
 *
 * Each of those would put a sentence on the operator's screen that the database cannot
 * support, on the panel they use to decide whether it is safe to hand a tenant its own
 * account. So the tests below read the rendered DEFINITION ROWS, not just page text.
 */
describe('RestaurantOverviewTab — onboarding', () => {
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
  function panel(heading: string): HTMLElement {
    const found = el().querySelector(`section[aria-labelledby="${heading}-heading"]`);
    expect(found).withContext(`the ${heading} panel is mounted`).toBeTruthy();
    return found as HTMLElement;
  }
  /** The onboarding panel's five rows, as `term -> value`. */
  function rows(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of Array.from(panel('onboarding').querySelectorAll('dl > div'))) {
      const term = row.querySelector('dt')?.textContent?.trim() ?? '';
      out[term] = row.querySelector('dd')?.textContent?.trim() ?? '';
    }
    return out;
  }
  function onboardingText(): string {
    return panel('onboarding').textContent ?? '';
  }

  async function loadedWith(record: OnboardingSummary, extra: Partial<RestaurantDetail> = {}) {
    api.answer = () => of(detail({ onboarding: record, ...extra }));
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/restaurants/${ID}`, RestaurantDetailPage);
    harness.detectChanges();
    tick();
    harness.detectChanges();
  }

  // ── THE LIVE BABA HOUSE SHAPE ────────────────────────────────────────────────────

  describe('a tracked legacy adoption with no control evidence (live Baba House)', () => {
    /** `is_test: true`, exactly as the accepted live payload reports it. */
    async function babaHouse(): Promise<void> {
      await loadedWith(onboarding(), { is_test: true, status: 'live', needs_attention: false });
    }

    it('renders all five rows in operator English', fakeAsync(async () => {
      await babaHouse();

      expect(rows()).toEqual({
        Source: 'Pre-existing restaurant',
        // The ADMIN RECORD's timestamp, EAT-labelled — not the restaurant's own.
        'Recorded in Admin': '09:14 EAT · 22 Aug 2026',
        'Owner relationship': 'Consistent',
        'Owner control': 'Not established',
        Invitation: 'Not applicable',
      });
      flush();
    }));

    it('marks the TEST tenant', fakeAsync(async () => {
      await babaHouse();

      const pills = Array.from(el().querySelectorAll('app-status-pill span')).map((pill) =>
        pill.textContent?.trim(),
      );
      expect(pills).toContain('Test');
      flush();
    }));

    it('explains what "pre-existing" means, without implying a creation date', fakeAsync(async () => {
      await babaHouse();

      expect(onboardingText()).toContain(
        'This restaurant existed before the Admin onboarding record was introduced.',
      );
      for (const wrong of ['Imported', 'Migrated', 'Created on']) {
        expect(onboardingText()).withContext(wrong).not.toContain(wrong);
      }
      // `created_at` is 2 May 2026 on this fixture and `recorded_at` is 22 Aug 2026.
      // The panel states the second and never labels it as the first.
      expect(onboardingText()).not.toContain('May 2026');
      flush();
    }));

    it('says only that no control evidence is recorded', fakeAsync(async () => {
      await babaHouse();

      expect(onboardingText()).toContain('No owner-control evidence is recorded yet.');
      // NO INVITATION APPLIES to a legacy adoption, so nothing may blame one.
      expect(onboardingText()).not.toContain('has not claimed');
      expect(onboardingText()).not.toContain('Owner invitation pending');
      flush();
    }));

    it('shows NO machine value, and none of the old or invented claims', fakeAsync(async () => {
      await babaHouse();

      for (const raw of [
        'legacy_adopted',
        'not_established',
        'not_applicable',
        'owner_membership_mismatch',
        'invitation_redeemed',
        'consistent',
      ]) {
        expect(text()).withContext(raw).not.toContain(raw);
      }
      for (const wrong of [
        'Owner invitation pending',
        'Owner claimed',
        'Owner claim',
        'Not tracked yet',
      ]) {
        expect(text()).withContext(wrong).not.toContain(wrong);
      }
      flush();
    }));

    it('does not celebrate the consistent relationship', fakeAsync(async () => {
      await babaHouse();

      // §10: a completed or ordinary state RECEDES. Consistency is quiet — no note, and
      // no warning treatment either, because nothing is wrong.
      const relationship = panel('onboarding').querySelectorAll('dl > div')[2];
      expect(relationship.querySelector('dd')?.className).not.toContain('warning');
      expect(onboardingText()).not.toMatch(/Everything (is )?good/i);
      expect(onboardingText()).not.toContain('Onboarding complete');
      flush();
    }));
  });

  // ── LEGACY ATTESTATION ───────────────────────────────────────────────────────────

  describe('a valid legacy attestation', () => {
    const ATTESTED = onboarding({
      owner_control: {
        status: 'attested',
        evidence: 'legacy_attestation',
        evidence_at: '2026-06-02T08:30:00+03:00',
      },
    });

    it('reads as Established, by ADMINISTRATIVE ATTESTATION, in EAT', fakeAsync(async () => {
      await loadedWith(ATTESTED);

      expect(rows()['Owner control']).toBe('Established');
      expect(onboardingText()).toContain('Recorded by administrative attestation');
      expect(onboardingText()).toContain('08:30 EAT · 2 Jun 2026');
      flush();
    }));

    it('never describes an attestation as a redemption or a claim', fakeAsync(async () => {
      await loadedWith(ATTESTED);

      // The evidence is a platform operator's assertion. Calling it either of these
      // would turn an internal judgement into proof the owner did something.
      expect(onboardingText()).not.toContain('Owner invitation redeemed');
      expect(onboardingText()).not.toContain('Owner claimed');
      expect(onboardingText()).not.toMatch(/\bclaimed\b/i);
      flush();
    }));

    it('leaves the invitation row saying what it actually says', fakeAsync(async () => {
      await loadedWith(ATTESTED);

      // Established control does not retro-fit an invitation onto a legacy tenant.
      expect(rows()['Invitation']).toBe('Not applicable');
      flush();
    }));
  });

  describe('a stale attestation', () => {
    const STALE = onboarding({
      owner_control: {
        status: 'stale_attestation',
        evidence: 'legacy_attestation',
        evidence_at: '2026-06-02T08:30:00+03:00',
      },
    });

    it('reads as Stale evidence, never as established', fakeAsync(async () => {
      await loadedWith(STALE);

      expect(rows()['Owner control']).toBe('Stale evidence');
      expect(rows()['Owner control']).not.toBe('Established');
      flush();
    }));

    it('explains that the evidence applies to a PREVIOUS owner', fakeAsync(async () => {
      await loadedWith(STALE);

      expect(onboardingText()).toContain(
        'The recorded owner-control attestation applies to a previous owner and does not ' +
          'establish control for the current owner.',
      );
      flush();
    }));

    it('shows the stale evidence rather than hiding it', fakeAsync(async () => {
      await loadedWith(STALE);

      // Hiding it would leave "Stale evidence" pointing at nothing, and would quietly
      // discard the only record of what was once asserted.
      expect(onboardingText()).toContain('Recorded by administrative attestation');
      expect(onboardingText()).toContain('08:30 EAT · 2 Jun 2026');
      flush();
    }));

    it('uses warning treatment ON TOP OF wording that stands without colour', fakeAsync(async () => {
      await loadedWith(STALE);

      const control = panel('onboarding').querySelectorAll('dl > div')[3];
      expect(control.querySelector('dd')?.className).toContain('text-admin-warning');
      // §22: the state is legible with no colour at all — the label says "Stale" and a
      // sentence says why. Colour is emphasis, never the signal.
      expect(control.querySelector('dd')?.textContent?.trim()).toBe('Stale evidence');
      flush();
    }));

    it('offers no repair action — this slice writes nothing', fakeAsync(async () => {
      await loadedWith(STALE);

      expect(panel('onboarding').querySelectorAll('button').length).toBe(0);
      for (const fake of ['Re-attest', 'Attest', 'Clear', 'Fix', 'Resolve', 'Repair']) {
        expect(onboardingText()).withContext(fake).not.toContain(fake);
      }
      flush();
    }));
  });

  // ── OWNER RELATIONSHIP ───────────────────────────────────────────────────────────

  describe('owner relationship', () => {
    const CASES = [
      ['consistent', 'Consistent', null],
      ['missing_owner_membership', 'Owner access missing', 'The owner of record does not currently hold active owner access.'],
      ['multiple_owner_memberships', 'Multiple active owners', 'More than one active user currently holds the owner role.'],
      ['owner_membership_mismatch', 'Owner mismatch', 'The owner of record and the active owner-role user do not match.'],
      ['unavailable', 'Not tracked', null],
    ] as const;

    for (const [status, label, note] of CASES) {
      it(`renders ${status} as "${label}", never as the raw code`, fakeAsync(async () => {
        await loadedWith(onboarding({ owner_relationship: { status } }));

        expect(rows()['Owner relationship']).toBe(label);
        expect(text()).not.toContain(status);
        if (note) expect(onboardingText()).toContain(note);
        flush();
      }));
    }

    for (const status of [
      'missing_owner_membership',
      'multiple_owner_memberships',
      'owner_membership_mismatch',
    ] as const) {
      it(`keeps the rest of Overview intact when the relationship is ${status}`, fakeAsync(async () => {
        await loadedWith(onboarding({ owner_relationship: { status } }));

        // An inconsistency is a fact to render, not a reason to withhold the screen.
        expect(text()).toContain('Miriam Nakato');
        expect(text()).toContain('Tables');
        expect(text()).toContain('Latest order');
        expect(text()).toContain('Recent activity');
        flush();
      }));

      it(`offers no repair action for ${status}, and infers no correct identity`, fakeAsync(async () => {
        await loadedWith(onboarding({ owner_relationship: { status } }));

        expect(panel('onboarding').querySelectorAll('button, a').length).toBe(0);
        for (const fake of ['Reassign', 'Fix owner', 'Resolve', 'Choose owner', 'Remove']) {
          expect(onboardingText()).withContext(fake).not.toContain(fake);
        }
        flush();
      }));
    }
  });

  // ── ADMIN-CREATED INVITATIONS ────────────────────────────────────────────────────

  describe('invitation, for an admin-created restaurant', () => {
    const CASES = [
      ['not_issued', 'Not issued'],
      ['pending', 'Pending'],
      ['expired', 'Expired'],
      ['consumed', 'Redeemed'],
      ['cancelled', 'Cancelled'],
      ['superseded', 'Superseded'],
    ] as const;

    for (const [status, label] of CASES) {
      it(`renders ${status} as "${label}"`, fakeAsync(async () => {
        await loadedWith(
          onboarding({ source: 'admin_created', invitation: { status } }),
        );

        expect(rows()['Source']).toBe('Created by Dinify Admin');
        expect(rows()['Invitation']).toBe(label);
        expect(text()).not.toContain(status);
        flush();
      }));
    }

    // LOAD-BEARING, and the reason these two are asserted separately rather than
    // through one shared label: "there was never an invitation to send" and "one is
    // owed and has not been sent yet" are different states of the world. Reading the
    // first as the second invents a missing step for every tenant that predates the
    // domain — which is every restaurant Dinify had before Step 2C.
    it('reads a legacy adoption as Not applicable', fakeAsync(async () => {
      await loadedWith(onboarding({ source: 'legacy_adopted' }));

      expect(rows()['Invitation']).toBe('Not applicable');
      expect(rows()['Invitation']).not.toBe('Not issued');
      flush();
    }));

    it('reads an uninvited admin-created restaurant as Not issued', fakeAsync(async () => {
      await loadedWith(
        onboarding({ source: 'admin_created', invitation: { status: 'not_issued' } }),
      );

      expect(rows()['Invitation']).toBe('Not issued');
      expect(rows()['Invitation']).not.toBe('Not applicable');
      flush();
    }));

    it('says nothing about a pre-existing restaurant when one was created here', fakeAsync(async () => {
      await loadedWith(onboarding({ source: 'admin_created', invitation: { status: 'pending' } }));

      expect(onboardingText()).not.toContain('existed before the Admin onboarding record');
      flush();
    }));

    it('offers no invitation controls anywhere', fakeAsync(async () => {
      await loadedWith(onboarding({ source: 'admin_created', invitation: { status: 'expired' } }));

      expect(panel('onboarding').querySelectorAll('button, a, input, select').length).toBe(0);
      for (const fake of ['Resend', 'Re-issue', 'Reissue', 'Send invitation', 'Invite', 'Cancel invitation']) {
        expect(text()).withContext(fake).not.toContain(fake);
      }
      flush();
    }));
  });

  describe('a redeemed invitation', () => {
    const REDEEMED = onboarding({
      source: 'admin_created',
      owner_control: {
        status: 'invitation_redeemed',
        evidence: 'invitation_redeemed',
        evidence_at: '2026-07-14T16:05:00+03:00',
      },
      invitation: { status: 'consumed' },
    });

    it('reads as Established, evidenced by the OWNER redeeming it, in EAT', fakeAsync(async () => {
      await loadedWith(REDEEMED);

      expect(rows()['Owner control']).toBe('Established');
      expect(onboardingText()).toContain('Owner invitation redeemed');
      expect(onboardingText()).toContain('16:05 EAT · 14 Jul 2026');
      // This one IS an observed act by the owner, so it must not be described as an
      // administrator's assertion.
      expect(onboardingText()).not.toContain('administrative attestation');
      flush();
    }));

    it('keeps the invitation and the control state as SEPARATE rows', fakeAsync(async () => {
      await loadedWith(REDEEMED);

      // Related facts, not one fact. Collapsing them into a single "Onboarding
      // complete" would hide the case where an invitation is consumed and control has
      // since gone stale under a change of owner.
      expect(rows()['Owner control']).toBe('Established');
      expect(rows()['Invitation']).toBe('Redeemed');
      expect(Object.keys(rows()).length).toBe(5);
      expect(onboardingText()).not.toContain('Onboarding complete');
      flush();
    }));
  });

  // ── UNTRACKED ────────────────────────────────────────────────────────────────────

  describe('a restaurant the onboarding domain has no record of', () => {
    it('answers every question with "Not tracked", and none with a verdict', fakeAsync(async () => {
      await loadedWith(UNTRACKED);

      expect(rows()).toEqual({
        Source: 'Not tracked',
        'Recorded in Admin': '—',
        'Owner relationship': 'Not tracked',
        'Owner control': 'Not tracked',
        Invitation: 'Not tracked',
      });
      flush();
    }));

    it('states only that it is not represented in the domain', fakeAsync(async () => {
      await loadedWith(UNTRACKED);

      expect(onboardingText()).toContain(
        'This restaurant has not yet been represented in the Admin onboarding domain.',
      );
      // These questions were NOT EVALUATED. Calling an absence of data a fault is the
      // same defect class as a dead backend presenting as "Invalid credentials."
      for (const wrong of [
        'Not established',
        'Not issued',
        'Inconsistent',
        'incomplete',
        'failed',
        'unclaimed',
      ]) {
        expect(onboardingText()).withContext(wrong).not.toContain(wrong);
      }
      flush();
    }));

    it('carries no provenance copy and no evidence line', fakeAsync(async () => {
      await loadedWith(UNTRACKED);

      expect(onboardingText()).not.toContain('existed before the Admin onboarding record');
      expect(onboardingText()).not.toContain('administrative attestation');
      expect(onboardingText()).not.toContain('No owner-control evidence is recorded yet.');
      flush();
    }));

    it('renders the rest of Overview normally', fakeAsync(async () => {
      await loadedWith(UNTRACKED);

      expect(text()).toContain('Miriam Nakato');
      expect(text()).toContain('Commercial');
      expect(text()).toContain('Operations');
      flush();
    }));
  });

  // ── THE OWNER PANEL, AFTER STEP 2C ───────────────────────────────────────────────

  describe('the Owner panel', () => {
    it('still shows identity, contact and account state', fakeAsync(async () => {
      await loadedWith(onboarding());

      const owner = panel('owner');
      const terms = Array.from(owner.querySelectorAll('dt')).map((t) => t.textContent?.trim());
      expect(terms).toEqual(['Name', 'Email', 'Phone', 'Account']);
      expect(owner.textContent).toContain('Miriam Nakato');
      expect(owner.textContent).toContain('miriam@ankolegrill.ug');
      expect(owner.textContent).toContain('256772140388');
      expect(owner.textContent).toContain('Active');
      flush();
    }));

    it('no longer carries the obsolete "Owner claim" row or its copy', fakeAsync(async () => {
      await loadedWith(onboarding());

      // It was fed by the compatibility aliases and said "Not tracked yet" for
      // everyone. For a legacy adoption both halves of that are now wrong, and the
      // Onboarding panel answers the question properly.
      expect(panel('owner').textContent).not.toContain('Owner claim');
      expect(text()).not.toContain('There is no owner-invitation record yet');
      expect(text()).not.toContain('Not tracked yet');
      flush();
    }));

    it('renders the owner-control state in ONE place only', fakeAsync(async () => {
      await loadedWith(onboarding());

      // The alias on this fixture is `claim_status: 'not_established'`. If the Owner
      // panel ever renders it again, the operator reads the same state twice — once
      // as raw snake_case.
      expect(panel('owner').textContent).not.toContain('Not established');
      expect(panel('onboarding').textContent).toContain('Not established');
      expect(text()).not.toContain('not_established');
      flush();
    }));

    it('handles a restaurant with no owner row while still rendering onboarding', fakeAsync(async () => {
      await loadedWith(onboarding(), { owner: null });

      expect(panel('owner').textContent).toContain('No owner account is attached');
      expect(rows()['Owner control']).toBe('Not established');
      flush();
    }));
  });

  // ── NO WRITES ANYWHERE ───────────────────────────────────────────────────────────

  it('introduces no consequential action on the whole tab', fakeAsync(async () => {
    await loadedWith(onboarding({ source: 'admin_created', invitation: { status: 'pending' } }));

    // The only interactive things Overview has ever had are navigation links. Step 2C
    // is a read slice: no adopt, no attest, no invite, no create, no lifecycle control.
    const buttons = Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons).toEqual([]);
    for (const fake of [
      'Adopt',
      'Attest',
      'Record attestation',
      'Issue invitation',
      'Send invitation',
      'Create restaurant',
      'Assign owner',
    ]) {
      expect(text()).withContext(fake).not.toContain(fake);
    }
    flush();
  }));

  it('keeps the semantic definition-list structure the rest of Overview uses', fakeAsync(async () => {
    await loadedWith(onboarding());

    // §22: a real <section> with a real <h2>, and a <dl> of <dt>/<dd> pairs — so the
    // panel is navigable and the terms are announced with their values.
    const onboardingPanel = panel('onboarding');
    expect(onboardingPanel.tagName).toBe('SECTION');
    expect(onboardingPanel.querySelector('h2')?.textContent?.trim()).toBe('Onboarding');
    expect(onboardingPanel.querySelector('h2')?.id).toBe('onboarding-heading');
    expect(onboardingPanel.querySelectorAll('dl').length).toBe(1);
    expect(onboardingPanel.querySelectorAll('dt').length).toBe(5);
    expect(onboardingPanel.querySelectorAll('dd').length).toBe(5);
    flush();
  }));

  it('renders every timestamp as labelled EAT, never a bare ISO string', fakeAsync(async () => {
    await loadedWith(
      onboarding({
        owner_control: {
          status: 'attested',
          evidence: 'legacy_attestation',
          evidence_at: '2026-06-02T08:30:00+03:00',
        },
      }),
    );

    expect(rows()['Recorded in Admin']).toContain('EAT');
    expect(onboardingText()).toContain('EAT');
    expect(onboardingText()).not.toContain('2026-08-22T09:14:33');
    expect(onboardingText()).not.toContain('2026-06-02T08:30:00');
    expect(onboardingText()).not.toContain('GMT');
    flush();
  }));
});
