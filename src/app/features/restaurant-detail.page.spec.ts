import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import {
  Router,
  provideRouter,
  withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject, of, throwError } from 'rxjs';

import { AdminServiceStatus } from '../core/api/service-status';
import { ElevationCancelledError } from '../core/auth/elevation.service';
import { formatEat } from '../core/formatting/time';
import {
  RESTAURANT_API,
  RestaurantApi,
} from '../core/restaurants/restaurant.api';
import { RestaurantWorkspaceStore } from '../core/restaurants/restaurant-workspace.store';
import {
  CommercialMutationResult,
  CommercialSubscriptionTerms,
  CommercialSummary,
  EndSubscriptionTermsRequest,
  OnboardingSummary,
  PaymentCollectionMode,
  PaymentTiming,
  RecordSubscriptionTermsRequest,
  ReplaceSubscriptionTermsRequest,
  RestaurantDetail,
  RestaurantDirectoryPage,
  SetPaymentCollectionModeRequest,
  SetPaymentTimingRequest,
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

/** One recorded write, so a test can assert the EXACT body that was sent. */
interface RecordedWrite {
  readonly operation: 'timing' | 'collection' | 'record' | 'replace' | 'end';
  readonly restaurantId: string;
  readonly body: Record<string, unknown>;
}

class StubApi implements RestaurantApi {
  detailCalls: string[] = [];
  answer: () => Observable<RestaurantDetail> = () => of(detail());

  /** Every commercial write attempted, in order — axes and terms alike. */
  readonly writes: RecordedWrite[] = [];
  /** How the next write answers. Defaults to a successful, changed mutation. */
  writeAnswer: () => Observable<CommercialMutationResult> = () =>
    of({ changed: true, commercial: commercial({ timing: 'pay_after' }) });

  list(): Observable<RestaurantDirectoryPage> {
    throw new Error('the workspace must not read the directory');
  }
  detail(id: string): Observable<RestaurantDetail> {
    this.detailCalls.push(id);
    return this.answer();
  }

  setPaymentTiming(
    restaurantId: string,
    request: SetPaymentTimingRequest,
  ): Observable<CommercialMutationResult> {
    // Captured as a plain record so a test can assert on KEY PRESENCE — `expected_current`
    // being present-and-null is a different request from it being absent, and
    // `expected_terms_id` being absent from a RECORD body is the contract itself.
    this.writes.push({ operation: 'timing', restaurantId, body: { ...request } });
    return this.writeAnswer();
  }

  setPaymentCollectionMode(
    restaurantId: string,
    request: SetPaymentCollectionModeRequest,
  ): Observable<CommercialMutationResult> {
    this.writes.push({ operation: 'collection', restaurantId, body: { ...request } });
    return this.writeAnswer();
  }

  recordSubscriptionTerms(
    restaurantId: string,
    request: RecordSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    this.writes.push({ operation: 'record', restaurantId, body: { ...request } });
    return this.writeAnswer();
  }

  replaceSubscriptionTerms(
    restaurantId: string,
    request: ReplaceSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    this.writes.push({ operation: 'replace', restaurantId, body: { ...request } });
    return this.writeAnswer();
  }

  endSubscriptionTerms(
    restaurantId: string,
    request: EndSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    this.writes.push({ operation: 'end', restaurantId, body: { ...request } });
    return this.writeAnswer();
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
              children: [
                { path: '', component: RestaurantOverviewTab },
                // A REAL SIBLING TAB, mounted the way it ships. Overview is destroyed and
                // rebuilt when the operator switches to it while the workspace store
                // survives, and that asymmetry is exactly what the in-flight write state
                // has to be correct across — so the suite has to be able to navigate it.
                { path: 'readiness', component: RestaurantReadinessTab },
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
    const dd = dt?.nextElementSibling;
    // Every editable row carries its controls inside the same `dd`, so the VALUE is read
    // off its own element. Falling back to the whole `dd` keeps this working for the
    // rows that have no control at all (readiness).
    const value = dd?.querySelector('[data-axis-value], [data-terms-value]');
    return (value ?? dd)?.textContent?.trim() ?? '';
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

  /**
   * ══ THE SERVICE-CONFIGURATION CONTROLS (Step 3E.2) ══════════════════════════════
   *
   * These pin the behaviours that could let an operator corrupt commercial state — not
   * layout, not classes. The recurring theme is that the SERVER is authoritative and the
   * screen never gets ahead of it: no row moves before a 200, no token is recomputed
   * after an editor opens, no conflict is retried, and no local write can race another.
   */
  describe('service-configuration controls', () => {
    const REASON = 'Switching to table service';

    /** The controls offered on one row, in order, by their labels. */
    function rowControls(term: string): HTMLButtonElement[] {
      const terms = Array.from(commercialPanel()?.querySelectorAll('dt') ?? []);
      const dt = terms.find((node) => node.textContent?.trim() === term);
      return Array.from(dt?.nextElementSibling?.querySelectorAll('button') ?? []);
    }

    function controlLabels(term: string): (string | undefined)[] {
      return rowControls(term).map((button) => button.textContent?.trim());
    }

    /** The Change button for one axis, addressed through its row. */
    function changeButton(term: string): HTMLButtonElement | null {
      return rowControls(term)[0] ?? null;
    }

    function editor(): Element | null {
      return commercialPanel()?.querySelector('[data-commercial-editor]') ?? null;
    }

    function editorHeading(): string {
      return editor()?.querySelector('h3')?.textContent?.trim() ?? '';
    }

    /** The rendered value of one axis, read off its own element rather than the blob. */
    function axisValue(key: string): string {
      return (
        commercialPanel()?.querySelector(`[data-axis-value="${key}"]`)?.textContent?.trim() ?? ''
      );
    }

    function openEditor(term: string): void {
      changeButton(term)!.click();
      harness.detectChanges();
    }

    function chooseAndReason(value: string, reason = REASON): void {
      const radio = editor()!.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
      radio.click();
      const box = editor()!.querySelector<HTMLTextAreaElement>('[data-commercial-reason]')!;
      box.value = reason;
      box.dispatchEvent(new Event('input'));
      harness.detectChanges();
    }

    function saveButton(): HTMLButtonElement {
      return Array.from(editor()!.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Save change',
      )!;
    }

    // --- what the panel offers ----------------------------------------------------

    it('offers one control per service axis, and the terms controls the state allows', fakeAsync(async () => {
      // This asserted `changeButton('Subscription terms')` was NULL at Step 3E.2, when
      // terms were read-only. 3E.3 gives them their three operations — but never all
      // three at once: this fixture has no open terms, so Record is the only one.
      await loaded();

      expect(controlLabels('Payment timing')).toEqual(['Change']);
      expect(controlLabels('Collection mode')).toEqual(['Change']);
      expect(controlLabels('Subscription terms')).toEqual(['Record terms']);
      flush();
    }));

    it('shows the current canonical value on each axis', fakeAsync(async () => {
      api.answer = () =>
        of(detail({ commercial: commercial({ timing: 'pay_first', collection: 'offline' }) }));
      await loaded();

      expect(axisValue('payment_timing')).toBe('Pay first');
      expect(axisValue('payment_collection_mode')).toBe('Restaurant collects');
      flush();
    }));

    // --- one editor, one flight ---------------------------------------------------

    it('opens ONE editor at a time, and opening the other replaces it', fakeAsync(async () => {
      await loaded();

      openEditor('Payment timing');
      expect(editorHeading()).toBe('Payment timing');
      expect(commercialPanel()!.querySelectorAll('[data-commercial-editor]').length).toBe(1);

      openEditor('Collection mode');
      expect(editorHeading()).toBe('Collection mode');
      expect(commercialPanel()!.querySelectorAll('[data-commercial-editor]').length).toBe(1);
      flush();
    }));

    it('does not mutate the displayed value merely by opening an editor', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      await loaded();

      openEditor('Payment timing');
      chooseAndReason('pay_after');

      // Choosing an option is not deciding anything. The row still reports what the
      // server last confirmed.
      expect(axisValue('payment_timing')).toBe('Pay first');
      expect(api.writes.length).toBe(0);
      flush();
    }));

    it('keeps Save unavailable without a different value AND a substantive reason', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      await loaded();
      openEditor('Payment timing');

      expect(saveButton().disabled).withContext('nothing chosen').toBeTrue();

      chooseAndReason('pay_after', 'too short');
      expect(saveButton().disabled).withContext('reason below the bar').toBeTrue();

      chooseAndReason('pay_first', REASON);
      expect(saveButton().disabled).withContext('same value as stored').toBeTrue();

      chooseAndReason('pay_after', REASON);
      expect(saveButton().disabled).withContext('different value, real reason').toBeFalse();
      flush();
    }));

    // --- the request ---------------------------------------------------------------

    it('sends the EXACT loaded value as expected_current, and only that axis', fakeAsync(async () => {
      api.answer = () =>
        of(detail({ commercial: commercial({ timing: 'pay_first', collection: 'offline' }) }));
      await loaded();

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      expect(api.writes.length).toBe(1);
      const [write] = api.writes;
      expect(write.operation).toBe('timing');
      expect(write.restaurantId).toBe(ID);
      expect(write.body).toEqual({
        value: 'pay_after',
        expected_current: 'pay_first',
        reason: REASON,
      });
      // The OTHER axis is not in the request at all. Each endpoint writes one decision.
      expect(Object.keys(write.body)).not.toContain('payment_collection_mode');
      expect(Object.keys(write.body)).not.toContain('value_collection');
      flush();
    }));

    it('sends an EXPLICIT null for an unconfigured axis', fakeAsync(async () => {
      // "Nobody had configured this when I loaded it" is a real assertion, and the only
      // one that succeeds against a fresh restaurant. An omitted key asserts nothing.
      await loaded();

      openEditor('Collection mode');
      chooseAndReason('offline', 'Initial collection setup for launch');
      saveButton().click();
      harness.detectChanges();

      const [write] = api.writes;
      expect(Object.keys(write.body)).toContain('expected_current');
      expect(write.body['expected_current']).toBeNull();
      expect(JSON.stringify(write.body)).toContain('"expected_current":null');
      flush();
    }));

    // --- no optimistic UI ----------------------------------------------------------

    it('does NOT repaint the row while the write is in flight', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      const pending = new Subject<CommercialMutationResult>();
      await loaded();
      api.writeAnswer = () => pending;

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      // §16: a write is real once its audit row commits. Until then the screen says what
      // the server last confirmed, and the editor stays open.
      expect(axisValue('payment_timing')).toBe('Pay first');
      expect(editor()).not.toBeNull();
      expect(saveButton().disabled).withContext('duplicate submit is impossible').toBeTrue();

      pending.next({ changed: true, commercial: commercial({ timing: 'pay_after' }) });
      pending.complete();
      harness.detectChanges();

      expect(axisValue('payment_timing')).toBe('Pay after');
      flush();
    }));

    it('cannot start a second write while one is pending, on either axis', fakeAsync(async () => {
      const pending = new Subject<CommercialMutationResult>();
      await loaded();
      api.writeAnswer = () => pending;

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      // Both Change controls are unavailable. Each write returns the WHOLE canonical
      // object, so two in flight could land out of order and the older snapshot would
      // repaint the other axis.
      expect(changeButton('Payment timing')!.disabled).toBeTrue();
      expect(changeButton('Collection mode')!.disabled).toBeTrue();

      changeButton('Collection mode')!.click();
      harness.detectChanges();
      expect(editorHeading()).withContext('the pending editor is still the one open').toBe(
        'Payment timing',
      );

      saveButton().click();
      harness.detectChanges();
      expect(api.writes.length).withContext('still exactly one request').toBe(1);

      pending.next({ changed: true, commercial: commercial({ timing: 'pay_after' }) });
      pending.complete();
      harness.detectChanges();
      flush();
    }));

    it('SURVIVES A TAB ROUND-TRIP: no second writer after Overview is rebuilt', fakeAsync(async () => {
      // THE REGRESSION THIS EXISTS FOR. The tabs are SIBLING ROUTES under the workspace,
      // so switching to Readiness destroys Overview while the write keeps running — it is
      // deliberately not torn down with the component, because cancelling a subscription
      // does not un-send a request the server may still commit.
      //
      // With the in-flight flag held on the COMPONENT, the rebuilt instance read false and
      // would start a second write. Two whole-commercial snapshots could then land out of
      // order and the older one would repaint the newer axis change. The flag lives on the
      // route-scoped store instead, whose lifetime is the restaurant's.
      const pending = new Subject<CommercialMutationResult>();
      await loaded();
      api.writeAnswer = () => pending;

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();
      expect(api.writes.length).toBe(1);

      // Away to another tab, and back. The harness tracks the top-level routed
      // component — the persistent workspace shell — while the CHILD beneath it is
      // destroyed and rebuilt, which is precisely the lifetime difference under test.
      await harness.navigateByUrl(`/restaurants/${ID}/readiness`, RestaurantDetailPage);
      harness.detectChanges();
      expect(editor()).withContext('Overview is gone while on another tab').toBeNull();

      await harness.navigateByUrl(`/restaurants/${ID}`, RestaurantDetailPage);
      harness.detectChanges();

      // The write is still in flight, and the rebuilt tab knows it.
      expect(changeButton('Payment timing')!.disabled).withContext('timing').toBeTrue();
      expect(changeButton('Collection mode')!.disabled).withContext('collection').toBeTrue();

      changeButton('Payment timing')!.click();
      harness.detectChanges();
      expect(editor()).withContext('no editor opens while a write is in flight').toBeNull();
      expect(api.writes.length).withContext('still exactly one request').toBe(1);

      // And the original write still lands on the surviving workspace.
      pending.next({ changed: true, commercial: commercial({ timing: 'pay_after' }) });
      pending.complete();
      harness.detectChanges();

      expect(axisValue('payment_timing')).toBe('Pay after');
      expect(changeButton('Payment timing')!.disabled)
        .withContext('the slot is released even though the original component is gone')
        .toBeFalse();
      flush();
    }));

    // --- success -------------------------------------------------------------------

    it('adopts the canonical response, closes the editor, and confirms', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      await loaded();
      api.writeAnswer = () =>
        of({ changed: true, commercial: commercial({ timing: 'pay_after', collection: 'offline' }) });

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      // The WHOLE returned projection is adopted — including the other axis, which this
      // request never mentioned. The server's re-read is authoritative.
      expect(axisValue('payment_timing')).toBe('Pay after');
      expect(axisValue('payment_collection_mode')).toBe('Restaurant collects');
      expect(editor()).withContext('editor closed').toBeNull();
      expect(commercialText()).toContain('Payment timing recorded.');
      // No second GET merely to learn what the write already returned.
      expect(api.detailCalls.length).toBe(1);
      flush();
    }));

    it('ADVANCES the concurrency token for the next edit', fakeAsync(async () => {
      // Loaded null -> wrote pay_first. The NEXT edit must assert pay_first, not the
      // stale null it originally held.
      await loaded();
      api.writeAnswer = () => of({ changed: true, commercial: commercial({ timing: 'pay_first' }) });

      openEditor('Payment timing');
      chooseAndReason('pay_first', 'Initial service model setup');
      saveButton().click();
      harness.detectChanges();

      expect(api.writes[0].body['expected_current']).withContext('first assertion').toBeNull();

      openEditor('Payment timing');
      chooseAndReason('pay_after', 'Correcting to table service');
      saveButton().click();
      harness.detectChanges();

      expect(api.writes[1].body['expected_current']).toBe('pay_first');
      flush();
    }));

    it('accepts changed:false without claiming a new decision was written', fakeAsync(async () => {
      // The lost-response retry. The server committed the first time; this exact retry
      // is a successful no-op, and must not be described as a second write.
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      await loaded();
      const settled = commercial({ timing: 'pay_after' });
      api.writeAnswer = () => of({ changed: false, commercial: settled });

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      expect(axisValue('payment_timing')).withContext('canonical state adopted').toBe('Pay after');
      expect(commercialText()).toContain('Nothing was changed.');
      expect(commercialText()).not.toContain('Payment timing recorded.');
      // The set_at shown is the server's; nothing manufactured a fresh one.
      expect(commercialText()).toContain(formatEat(settled.payment_timing.set_at));
      flush();
    }));

    // --- failures ------------------------------------------------------------------

    it('keeps the form and the draft open on a 400, with the field error', fakeAsync(async () => {
      await loaded();
      api.writeAnswer = () =>
        throwError(() => ({
          status: 400,
          error: {
            status: 400,
            message: 'The request could not be applied.',
            errors: { reason: ['Please state a reason of at least 10 characters.'] },
          },
        }));

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      expect(editor()).withContext('form stays open').not.toBeNull();
      expect(
        editor()!.querySelector<HTMLTextAreaElement>('[data-commercial-reason]')!.value,
      ).withContext('draft preserved').toBe(REASON);
      expect(editor()!.textContent).toContain('at least 10 characters');
      flush();
    }));

    it('does NOT auto-retry a 409, reloads, and discards the stale editor', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      await loaded();
      expect(api.detailCalls.length).toBe(1);

      api.writeAnswer = () =>
        throwError(() => ({
          status: 409,
          error: {
            status: 409,
            message: 'Commercial configuration changed since it was loaded.',
            code: 'stale_service_configuration',
          },
        }));

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      // Exactly ONE attempt. Replaying with a fresh token would overwrite whatever the
      // other operator just decided — the thing expected_current exists to prevent.
      expect(api.writes.length).toBe(1);
      // The stale editor is gone, so another Save needs a fresh choice, a fresh reason
      // and a fresh token.
      expect(editor()).toBeNull();
      expect(text()).toContain('Configuration changed since you loaded it');
      // And the workspace was told to re-read.
      expect(api.detailCalls.length).withContext('reload requested').toBe(2);
      tick();
      flush();
    }));

    it('REFUSES A NEW DECISION until the post-conflict reload has landed', fakeAsync(async () => {
      // THE REGRESSION THIS EXISTS FOR. Handling a 409 releases the write slot and starts
      // a replacement GET — but the tab outlet stays mounted through the loading state,
      // so the panel goes on rendering the SUPERSEDED projection. Before this gate an
      // operator could reopen an editor in that window and capture the same stale token
      // a second time.
      //
      // `expected_current` still refuses that write server-side, so this was never a data
      // -integrity bypass. The invariant it broke is the recovery one: after a conflict
      // the operator must SEE the fresh canonical state before deciding again.
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      await loaded();

      api.writeAnswer = () =>
        throwError(() => ({
          status: 409,
          error: {
            status: 409,
            message: 'Commercial configuration changed since it was loaded.',
            code: 'stale_service_configuration',
          },
        }));

      // The reload is held open, so the in-flight window is observable rather than
      // instantaneous — which is precisely the window the defect lived in.
      const reload = new Subject<RestaurantDetail>();
      api.answer = () => reload;

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      expect(api.writes.length).toBe(1);
      expect(api.detailCalls.length).withContext('a replacement read was started').toBe(2);

      // MID-RELOAD. The stale projection is still on screen, and the controls are shut.
      expect(axisValue('payment_timing')).withContext('still the superseded value').toBe(
        'Pay first',
      );
      expect(changeButton('Payment timing')!.disabled).withContext('timing').toBeTrue();
      expect(changeButton('Collection mode')!.disabled).withContext('collection').toBeTrue();

      changeButton('Payment timing')!.click();
      harness.detectChanges();
      expect(editor()).withContext('no editor opens against superseded state').toBeNull();
      expect(api.writes.length).withContext('and no second write').toBe(1);

      // The copy does not claim a reload that has not happened yet, and says so while
      // it is happening.
      const midFlight = commercialPanel()!.textContent ?? '';
      expect(midFlight).toContain('Review the current value before trying again.');
      expect(midFlight).toContain('Reloading');
      expect(midFlight).not.toContain('has been reloaded');

      // The fresh read lands: another operator had moved the axis to pay_after.
      reload.next(detail({ commercial: commercial({ timing: 'pay_after' }) }));
      reload.complete();
      harness.detectChanges();

      expect(axisValue('payment_timing')).withContext('fresh canonical state').toBe('Pay after');
      expect(changeButton('Payment timing')!.disabled)
        .withContext('deciding is possible again')
        .toBeFalse();
      expect(commercialPanel()!.textContent).not.toContain('Reloading');
      flush();
    }));

    it('captures the FRESH token for the edit that follows a conflict', fakeAsync(async () => {
      // The consequence of the gate, and the reason it is worth having: the next
      // assertion an operator makes is against the value they were actually shown.
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_first' }) }));
      await loaded();

      api.writeAnswer = () =>
        throwError(() => ({
          status: 409,
          error: { status: 409, code: 'stale_service_configuration', message: 'stale' },
        }));
      // The conflict reload reveals what the other operator actually wrote.
      api.answer = () => of(detail({ commercial: commercial({ timing: 'pay_after' }) }));

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();
      tick();
      harness.detectChanges();

      expect(api.writes[0].body['expected_current'])
        .withContext('the first attempt asserted what it had loaded')
        .toBe('pay_first');

      // A fresh, deliberate decision against the reloaded state.
      api.writeAnswer = () =>
        of({ changed: true, commercial: commercial({ timing: 'pay_first' }) });
      openEditor('Payment timing');
      chooseAndReason('pay_first', 'Reverting after reviewing the conflict');
      saveButton().click();
      harness.detectChanges();

      expect(api.writes.length).toBe(2);
      expect(api.writes[1].body['expected_current'])
        .withContext('NOT the stale pay_first-era token — the reloaded one')
        .toBe('pay_after');
      flush();
    }));

    it('preserves the draft when re-authentication is cancelled', fakeAsync(async () => {
      await loaded();
      api.writeAnswer = () => throwError(() => new ElevationCancelledError());

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      // Nothing was sent, so nothing was decided — and making the operator retype a
      // reason they already wrote would be a tax on cancelling a prompt.
      expect(editor()).withContext('form stays open').not.toBeNull();
      expect(
        editor()!.querySelector<HTMLTextAreaElement>('[data-commercial-reason]')!.value,
      ).toBe(REASON);
      expect(editor()!.textContent).toContain('Re-authentication was cancelled');
      expect(editor()!.textContent).toContain('Nothing was changed');
      flush();
    }));

    it('does not claim an indeterminate outage failed to commit', fakeAsync(async () => {
      await loaded();
      api.writeAnswer = () =>
        throwError(() => ({ status: 0, error: null, message: 'Http failure response' }));

      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      // The write MAY have committed. The copy says exactly that, and the draft survives
      // so the operator can deliberately retry the same request — which, if the first one
      // landed, answers changed:false.
      expect(editor()!.textContent).toContain('not known whether this change was recorded');
      expect(
        editor()!.querySelector<HTMLTextAreaElement>('[data-commercial-reason]')!.value,
      ).toBe(REASON);
      flush();
    }));

    // --- truthfulness ---------------------------------------------------------------

    it('never calls offline cash-only, and never claims psp_online is connected', fakeAsync(async () => {
      await loaded();
      openEditor('Collection mode');
      const copy = editor()!.textContent ?? '';

      expect(copy).toContain('Restaurant collects');
      expect(copy).toContain('Dinify via PSP');
      // INITIATES, never collects or holds — the restaurant stays merchant of record.
      expect(copy).toContain('initiating the diner payment');
      expect(copy).toContain('merchant of record');
      for (const invented of [
        'Cash only',
        'cash only',
        'PSP connected',
        'Online payments active',
        'Dinify collects',
        'Dinify holds',
      ]) {
        expect(copy).withContext(invented).not.toContain(invented);
      }
      flush();
    }));

    it('keeps psp_online SELECTABLE, and warns rather than blocking', fakeAsync(async () => {
      // A legitimate commercial value. The safety mechanism is fail-closed readiness
      // later, not a control that refuses to record what an operator decided.
      await loaded();
      openEditor('Collection mode');

      const psp = editor()!.querySelector<HTMLInputElement>('input[value="psp_online"]')!;
      expect(psp.disabled).toBeFalse();

      chooseAndReason('psp_online', 'Moving to provider-initiated collection');
      expect(saveButton().disabled).withContext('Save is not blocked by the warning').toBeFalse();
      expect(editor()!.querySelector('[data-commercial-warning]')?.textContent).toContain(
        'cannot satisfy future go-live readiness',
      );
      flush();
    }));

    it('does not promise that payment timing changes current order behaviour', fakeAsync(async () => {
      // Nothing in the order or kitchen runtime consumes this value yet, so the copy
      // records a service model and claims no runtime consequence.
      await loaded();
      openEditor('Payment timing');
      const copy = editor()!.textContent ?? '';

      expect(copy).toContain('Settlement is expected before the kitchen fires the order.');
      for (const overclaim of [
        'immediately',
        'every order will',
        'takes effect now',
        'existing orders',
      ]) {
        expect(copy).withContext(overclaim).not.toContain(overclaim);
      }
      flush();
    }));

    it('leaves subscription terms untouched by a service-configuration write', fakeAsync(async () => {
      api.answer = () =>
        of(detail({ commercial: commercial({ timing: 'pay_first', terms: {} }) }));
      await loaded();
      expect(commercialRow('Subscription terms')).toContain('UGX 150,000 · every month');

      api.writeAnswer = () =>
        of({ changed: true, commercial: commercial({ timing: 'pay_after', terms: {} }) });
      openEditor('Payment timing');
      chooseAndReason('pay_after');
      saveButton().click();
      harness.detectChanges();

      expect(commercialRow('Subscription terms')).toContain('UGX 150,000 · every month');
      // The axis write touched ONE endpoint. Terms are a separate decision with a
      // separate token, and nothing about changing a service axis writes them.
      expect(api.writes.map((write) => write.operation)).toEqual(['timing']);
      // And the row still offers the operations its state allows — no more, no fewer.
      expect(controlLabels('Subscription terms')).toEqual(['Replace terms', 'End terms']);
      flush();
    }));
  });

  // ── SUBSCRIPTION TERMS: RECORD, REPLACE, END (spec §15 step 3E.3) ─────────────────
  //
  // What this block defends, in one sentence each:
  //
  //   THE CONTROLS FOLLOW THE STATE. Record only with none open, Replace and End only
  //   with one open, and none at all when the server sent no projection.
  //
  //   THE TOKEN IS A ROW IDENTITY. `expected_terms_id` is the UUID the read published,
  //   captured when the editor opened — and Record deliberately has none.
  //
  //   THE AMOUNT IS A STRING FROM THE KEYSTROKE TO THE WIRE, and the boundary is an EAT
  //   wall time serialised against Africa/Kampala rather than against the browser.
  //
  //   NOT ONE WORD IMPLIES MONEY MOVED. There is no invoice model, no receivable and no
  //   collection path behind any of these operations.

  describe('subscription-terms controls', () => {
    const TERMS_ID = '5d6e7f80-9a1b-4c2d-8e3f-000000000001';
    const REASON = 'Recording the price agreed at signing';

    /** The commercial state of a restaurant with the default open terms. */
    function withTerms(overrides: Partial<CommercialSubscriptionTerms> = {}): CommercialSummary {
      return commercial({ terms: overrides });
    }

    function control(term: string, label: string): HTMLButtonElement | null {
      const terms = Array.from(commercialPanel()?.querySelectorAll('dt') ?? []);
      const dt = terms.find((node) => node.textContent?.trim() === term);
      return (
        Array.from(dt?.nextElementSibling?.querySelectorAll('button') ?? []).find(
          (button) => button.textContent?.trim() === label,
        ) ?? null
      );
    }

    function open(label: string): void {
      control('Subscription terms', label)!.click();
      harness.detectChanges();
    }

    function editor(): HTMLElement | null {
      return commercialPanel()?.querySelector('[data-commercial-editor]') ?? null;
    }

    function set(hook: string, value: string): void {
      const field = editor()!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[${hook}]`)!;
      field.value = value;
      field.dispatchEvent(new Event('input'));
      harness.detectChanges();
    }

    function fieldValue(hook: string): string {
      return editor()!.querySelector<HTMLInputElement>(`[${hook}]`)!.value;
    }

    function submit(label: string): HTMLButtonElement {
      return Array.from(editor()!.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === label,
      )!;
    }

    /** Fill the record/replace form completely. Every field is stated; none is defaulted. */
    function fillTerms(
      overrides: {
        amount?: string;
        currency?: string;
        count?: string;
        unit?: string;
        effectiveFrom?: string;
        reason?: string;
      } = {},
    ): void {
      set('data-terms-amount', overrides.amount ?? '175000.00');
      set('data-terms-currency', overrides.currency ?? 'UGX');
      set('data-terms-count', overrides.count ?? '1');
      const unit = editor()!.querySelector<HTMLSelectElement>('[data-terms-unit]')!;
      unit.value = overrides.unit ?? 'month';
      unit.dispatchEvent(new Event('change'));
      set('data-terms-effective-from', overrides.effectiveFrom ?? '2026-08-01T00:00');
      set('data-commercial-reason', overrides.reason ?? REASON);
    }

    function lastBody(): Record<string, unknown> {
      return api.writes[api.writes.length - 1].body;
    }

    // --- what the form collects, and what it refuses to invent ---------------------

    it('states every commercial fact and DEFAULTS none of them', fakeAsync(async () => {
      // No silent UGX, and no "now". The backend has no currency default either, and a
      // moment the client filled in would be Dinify recording a commercial term nobody
      // chose — in the one field that decides which terms were in force.
      await loaded();
      open('Record terms');

      expect(fieldValue('data-terms-amount')).withContext('amount').toBe('');
      expect(fieldValue('data-terms-currency')).withContext('currency').toBe('');
      expect(fieldValue('data-terms-effective-from')).withContext('effective from').toBe('');
      expect(submit('Record terms').disabled).withContext('nothing stated yet').toBeTrue();
      flush();
    }));

    it('keeps Save unavailable until every fact AND a substantive reason are stated', fakeAsync(async () => {
      await loaded();
      open('Record terms');

      fillTerms({ reason: 'too short' });
      expect(submit('Record terms').disabled).withContext('reason below the bar').toBeTrue();

      fillTerms({ effectiveFrom: '', reason: REASON });
      expect(submit('Record terms').disabled).withContext('no boundary').toBeTrue();

      fillTerms({ count: '0' });
      expect(submit('Record terms').disabled).withContext('interval below 1').toBeTrue();

      fillTerms();
      expect(submit('Record terms').disabled).withContext('complete').toBeFalse();
      flush();
    }));

    it('labels the boundary EAT and serialises it against Africa/Kampala', fakeAsync(async () => {
      // THE DEFECT THIS DESIGNS OUT: `new Date('2026-08-01T00:00').toISOString()` reads
      // the wall time in the BROWSER'S zone, so an operator administering from London
      // would silently send 22:00 the previous day. The backend refuses naive timestamps,
      // so the bug arrives as a well-formed request with the wrong instant — not a 400.
      await loaded();
      open('Record terms');
      expect(editor()!.textContent).toContain('Effective from (EAT)');

      fillTerms({ effectiveFrom: '2026-08-01T00:00' });
      submit('Record terms').click();
      harness.detectChanges();

      expect(lastBody()['effective_from']).toBe('2026-08-01T00:00:00+03:00');
      flush();
    }));

    // --- the request ---------------------------------------------------------------

    it('RECORD sends the five facts and a reason, and NO expected_terms_id', fakeAsync(async () => {
      await loaded();
      open('Record terms');
      fillTerms({ amount: '150000.00' });
      submit('Record terms').click();
      harness.detectChanges();

      expect(api.writes.map((write) => write.operation)).toEqual(['record']);
      expect(lastBody()).toEqual({
        recurring_amount: '150000.00',
        currency: 'UGX',
        billing_interval_unit: 'month',
        billing_interval_count: 1,
        effective_from: '2026-08-01T00:00:00+03:00',
        reason: REASON,
      });
      // The operation means "record terms only if none are open" — a token here would be
      // a field nothing consults.
      expect(Object.keys(lastBody())).not.toContain('expected_terms_id');
      flush();
    }));

    it('sends the amount as the STRING that was typed, never parsed', fakeAsync(async () => {
      // A stored `"150000.50"` is a real recorded digit. `Number()` anywhere on this path
      // reintroduces the float the backend's strict field exists to refuse, and
      // `"0.00"` versus `0.0` is exactly the distinction that would be lost.
      await loaded();
      open('Record terms');
      fillTerms({ amount: '  150000.50  ' });
      submit('Record terms').click();
      harness.detectChanges();

      expect(lastBody()['recurring_amount']).toBe('150000.50');
      expect(typeof lastBody()['recurring_amount']).toBe('string');
      expect(JSON.stringify(lastBody())).toContain('"recurring_amount":"150000.50"');
      flush();
    }));

    it('REPLACE prefills the four immutable facts and NOT the boundary', fakeAsync(async () => {
      // Only what genuinely changes has to be retyped — but the boundary is a NEW
      // decision every time, and prefilling it would invite an operator to accept a date
      // they never chose.
      // A NON-DEFAULT interval, deliberately: with `month` and `1` the assertions would
      // pass against a form that prefilled nothing and merely kept its own defaults.
      api.answer = () =>
        of(
          detail({
            commercial: withTerms({
              recurring_amount: '1800000.00',
              currency: 'KES',
              billing_interval: { unit: 'year', count: 2 },
            }),
          }),
        );
      await loaded();
      open('Replace terms');

      expect(fieldValue('data-terms-amount')).toBe('1800000.00');
      expect(fieldValue('data-terms-currency')).toBe('KES');
      expect(fieldValue('data-terms-count')).toBe('2');
      expect(
        editor()!.querySelector<HTMLSelectElement>('[data-terms-unit]')!.value,
      ).withContext('the select really moved').toBe('year');
      expect(fieldValue('data-terms-effective-from')).withContext('never prefilled').toBe('');
      flush();
    }));

    it('REPLACE sends the loaded row id as expected_terms_id', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      open('Replace terms');
      fillTerms({ amount: '175000.00', reason: 'Uplift agreed for the new quarter' });
      submit('Replace terms').click();
      harness.detectChanges();

      expect(api.writes.map((write) => write.operation)).toEqual(['replace']);
      expect(lastBody()['expected_terms_id']).toBe(TERMS_ID);
      expect(typeof lastBody()['expected_terms_id']).toBe('string');
      flush();
    }));

    it('REPLACE refuses a submission whose commercial facts are unchanged', fakeAsync(async () => {
      // The backend compares FOUR facts and deliberately excludes `effective_from`, so a
      // replacement changing only the date is a silent `changed: false`. Re-dating an
      // unchanged price is a separate correction the domain does not offer, and the form
      // says so rather than encouraging the request.
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      open('Replace terms');

      set('data-terms-effective-from', '2026-08-20T09:00');
      set('data-commercial-reason', 'Correcting the effective date on the record');
      expect(submit('Replace terms').disabled).withContext('only the date differs').toBeTrue();
      expect(editor()!.querySelector('[data-terms-unchanged]')?.textContent).toContain(
        'Change the amount, currency or interval',
      );

      set('data-terms-amount', '175000.00');
      expect(submit('Replace terms').disabled).withContext('a real change').toBeFalse();
      expect(editor()!.querySelector('[data-terms-unchanged]')).toBeNull();
      flush();
    }));

    it('END sends exactly the token, the boundary and the reason', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      open('End terms');

      expect(editor()!.textContent).toContain('End time (EAT)');
      expect(fieldValue('data-terms-ended-at')).withContext('never defaulted to now').toBe('');

      set('data-terms-ended-at', '2026-08-20T09:00');
      set('data-commercial-reason', 'Restaurant is leaving the platform');
      submit('End terms').click();
      harness.detectChanges();

      expect(api.writes.map((write) => write.operation)).toEqual(['end']);
      expect(lastBody()).toEqual({
        expected_terms_id: TERMS_ID,
        ended_at: '2026-08-20T09:00:00+03:00',
        reason: 'Restaurant is leaving the platform',
      });
      flush();
    }));

    it('shows WHICH terms are being ended', fakeAsync(async () => {
      // The row the captured token names, as it read when the form opened — so the
      // operator is not trusting that the panel above still describes the same row.
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      open('End terms');

      expect(editor()!.querySelector('[data-terms-end-subject]')?.textContent).toContain(
        'UGX 150,000 · every month',
      );
      flush();
    }));

    // --- one editor, one flight, across ALL FIVE commercial writes -------------------

    it('shares ONE editor slot with the service axes', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();

      control('Payment timing', 'Change')!.click();
      harness.detectChanges();
      expect(commercialPanel()!.querySelectorAll('[data-commercial-editor]').length).toBe(1);

      open('Replace terms');
      expect(commercialPanel()!.querySelectorAll('[data-commercial-editor]').length).toBe(1);
      expect(editor()!.hasAttribute('data-terms-editor')).toBeTrue();

      open('End terms');
      expect(commercialPanel()!.querySelectorAll('[data-commercial-editor]').length).toBe(1);
      expect(editor()!.hasAttribute('data-terms-end-editor')).toBeTrue();

      control('Collection mode', 'Change')!.click();
      harness.detectChanges();
      expect(commercialPanel()!.querySelectorAll('[data-commercial-editor]').length).toBe(1);
      expect(editor()!.hasAttribute('data-terms-end-editor')).toBeFalse();
      flush();
    }));

    it('shuts every commercial control while a terms write is in flight', fakeAsync(async () => {
      // Each of the five returns the WHOLE canonical object, so two in flight could land
      // out of order and the older snapshot would repaint the other. One slot makes that
      // unrepresentable rather than unlikely.
      const pending = new Subject<CommercialMutationResult>();
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      api.writeAnswer = () => pending;

      open('Replace terms');
      fillTerms({ amount: '175000.00' });
      submit('Replace terms').click();
      harness.detectChanges();

      expect(control('Payment timing', 'Change')!.disabled).withContext('timing').toBeTrue();
      expect(control('Collection mode', 'Change')!.disabled).withContext('collection').toBeTrue();
      expect(control('Subscription terms', 'Replace terms')!.disabled).withContext('replace').toBeTrue();
      expect(control('Subscription terms', 'End terms')!.disabled).withContext('end').toBeTrue();

      control('Subscription terms', 'End terms')!.click();
      harness.detectChanges();
      expect(editor()!.hasAttribute('data-terms-editor'))
        .withContext('the pending editor is still the one open')
        .toBeTrue();
      expect(api.writes.length).withContext('still exactly one request').toBe(1);

      pending.next({ changed: true, commercial: withTerms({ recurring_amount: '175000.00' }) });
      pending.complete();
      harness.detectChanges();
      flush();
    }));

    it('does NOT repaint the terms row while the write is in flight', fakeAsync(async () => {
      const pending = new Subject<CommercialMutationResult>();
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      api.writeAnswer = () => pending;

      open('Replace terms');
      fillTerms({ amount: '175000.00' });
      submit('Replace terms').click();
      harness.detectChanges();

      // §16: a write is real once its audit row commits.
      expect(commercialRow('Subscription terms')).toContain('UGX 150,000');
      expect(submit('Replace terms').disabled).withContext('duplicate submit impossible').toBeTrue();

      pending.next({ changed: true, commercial: withTerms({ recurring_amount: '175000.00' }) });
      pending.complete();
      harness.detectChanges();

      expect(commercialRow('Subscription terms')).toContain('UGX 175,000');
      flush();
    }));

    // --- outcomes -------------------------------------------------------------------

    it('adopts the canonical response, closes the editor and confirms, per operation', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();

      api.writeAnswer = () =>
        of({ changed: true, commercial: withTerms({ recurring_amount: '175000.00' }) });
      open('Replace terms');
      fillTerms({ amount: '175000.00' });
      submit('Replace terms').click();
      harness.detectChanges();

      expect(editor()).withContext('editor closed').toBeNull();
      expect(commercialRow('Subscription terms')).toContain('UGX 175,000 · every month');
      expect(commercialText()).toContain('Subscription terms replaced.');
      // No second GET merely to learn what the write already returned.
      expect(api.detailCalls.length).toBe(1);
      flush();
    }));

    it('treats changed:false as a SUCCESS that decided nothing', fakeAsync(async () => {
      // The lost-response retry. The server answers a same-state request this way even
      // when the token has gone stale, so an exact resend is not a false conflict — and
      // must never be described as a second write.
      api.answer = () => of(detail({ commercial: commercial() }));
      await loaded();
      const settled = withTerms();
      api.writeAnswer = () => of({ changed: false, commercial: settled });

      open('Record terms');
      fillTerms({ amount: '150000.00' });
      submit('Record terms').click();
      harness.detectChanges();

      expect(commercialRow('Subscription terms')).toContain('UGX 150,000 · every month');
      expect(commercialText()).toContain('Nothing was changed.');
      expect(commercialText()).not.toContain('Subscription terms recorded.');
      flush();
    }));

    it('keeps the form and the draft open on a 400, with the field error', fakeAsync(async () => {
      await loaded();
      api.writeAnswer = () =>
        throwError(() => ({
          status: 400,
          error: {
            status: 400,
            message: 'The request could not be applied.',
            code: 'invalid_subscription_terms',
            errors: {
              recurring_amount: [
                'recurring_amount carries more precision than the stored scale of two decimal places.',
              ],
            },
          },
        }));

      open('Record terms');
      fillTerms({ amount: '150000.005' });
      submit('Record terms').click();
      harness.detectChanges();

      expect(editor()).withContext('form stays open').not.toBeNull();
      expect(fieldValue('data-terms-amount')).withContext('draft preserved').toBe('150000.005');
      expect(editor()!.textContent).toContain('more precision than the stored scale');
      flush();
    }));

    it('shows a 400 the form has no field for, rather than refusing silently', fakeAsync(async () => {
      // A 400 naming `expected_terms_id` is the server telling the operator something
      // real about their request. There is no input to hang it on, and dropping it would
      // leave a form that refuses with no explanation.
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      api.writeAnswer = () =>
        throwError(() => ({
          status: 400,
          error: {
            status: 400,
            message: 'The request could not be applied.',
            errors: { expected_terms_id: ['Enter a valid UUID.'] },
          },
        }));

      open('Replace terms');
      fillTerms({ amount: '175000.00' });
      submit('Replace terms').click();
      harness.detectChanges();

      expect(editor()!.textContent).toContain('Enter a valid UUID.');
      flush();
    }));

    it('does NOT auto-retry a 409, and states the SERVER’S reason for it', fakeAsync(async () => {
      // FOUR DISTINCT CONFLICTS, and only the server can tell them apart. "This restaurant
      // already has different open subscription terms" and "has no open subscription
      // terms" call for opposite next actions; one generic sentence would drop the
      // operator's remedy.
      api.answer = () => of(detail({ commercial: commercial() }));
      await loaded();
      expect(api.detailCalls.length).toBe(1);

      api.writeAnswer = () =>
        throwError(() => ({
          status: 409,
          error: {
            status: 409,
            message: 'This restaurant already has different open subscription terms.',
            code: 'subscription_terms_already_open',
          },
        }));

      open('Record terms');
      fillTerms({ amount: '150000.00' });
      submit('Record terms').click();
      harness.detectChanges();

      // Exactly ONE attempt. Replaying would overwrite whatever the other operator just
      // decided — the thing the concurrency check exists to prevent.
      expect(api.writes.length).toBe(1);
      expect(editor()).withContext('the stale editor is discarded').toBeNull();
      expect(commercialText()).toContain('already has different open subscription terms');
      expect(commercialText()).toContain('Review the current value before trying again.');
      expect(api.detailCalls.length).withContext('reload requested').toBe(2);
      tick();
      flush();
    }));

    it('REFUSES A NEW TERMS DECISION until the post-conflict reload has landed', fakeAsync(async () => {
      // The same recovery invariant the axes have, and it matters more here: the token is
      // a ROW ID, so an editor reopened against the superseded projection would capture a
      // row that has already been superseded.
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();

      api.writeAnswer = () =>
        throwError(() => ({
          status: 409,
          error: {
            status: 409,
            message: 'These are no longer the current subscription terms.',
            code: 'stale_subscription_terms',
          },
        }));
      const reload = new Subject<RestaurantDetail>();
      api.answer = () => reload;

      open('Replace terms');
      fillTerms({ amount: '175000.00' });
      submit('Replace terms').click();
      harness.detectChanges();

      expect(control('Subscription terms', 'Replace terms')!.disabled).toBeTrue();
      expect(control('Subscription terms', 'End terms')!.disabled).toBeTrue();
      control('Subscription terms', 'Replace terms')!.click();
      harness.detectChanges();
      expect(editor()).withContext('no editor opens against superseded state').toBeNull();
      expect(api.writes.length).withContext('and no second write').toBe(1);
      expect(commercialPanel()!.textContent).toContain('Reloading');

      const replacement = '9a8b7c60-1d2e-4f30-8a1b-000000000002';
      reload.next(
        detail({ commercial: withTerms({ id: replacement, recurring_amount: '200000.00' }) }),
      );
      reload.complete();
      harness.detectChanges();

      expect(commercialRow('Subscription terms')).toContain('UGX 200,000');
      expect(control('Subscription terms', 'Replace terms')!.disabled)
        .withContext('deciding is possible again')
        .toBeFalse();
      flush();
    }));

    it('captures the FRESH row id for the edit that follows a conflict', fakeAsync(async () => {
      const replacement = '9a8b7c60-1d2e-4f30-8a1b-000000000002';
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();

      api.writeAnswer = () =>
        throwError(() => ({
          status: 409,
          error: { status: 409, code: 'stale_subscription_terms', message: 'stale' },
        }));
      api.answer = () => of(detail({ commercial: withTerms({ id: replacement }) }));

      open('Replace terms');
      fillTerms({ amount: '175000.00' });
      submit('Replace terms').click();
      harness.detectChanges();
      tick();
      harness.detectChanges();

      expect(api.writes[0].body['expected_terms_id'])
        .withContext('the first attempt asserted the row it had loaded')
        .toBe(TERMS_ID);

      api.writeAnswer = () =>
        of({ changed: true, commercial: withTerms({ id: replacement, recurring_amount: '175000.00' }) });
      open('Replace terms');
      fillTerms({ amount: '175000.00', reason: 'Re-applying after reviewing the conflict' });
      submit('Replace terms').click();
      harness.detectChanges();

      expect(api.writes.length).toBe(2);
      expect(api.writes[1].body['expected_terms_id'])
        .withContext('NOT the superseded row — the reloaded one')
        .toBe(replacement);
      flush();
    }));

    it('discards the editor and re-reads on a 404', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      api.writeAnswer = () =>
        throwError(() => ({ status: 404, error: { status: 404, message: 'Restaurant not found.' } }));

      open('End terms');
      set('data-terms-ended-at', '2026-08-20T09:00');
      set('data-commercial-reason', 'Restaurant is leaving the platform');
      submit('End terms').click();
      harness.detectChanges();

      // Presenting an editable stale tenant would invite a write against something that
      // no longer exists.
      expect(editor()).toBeNull();
      expect(api.detailCalls.length).withContext('reload requested').toBe(2);
      tick();
      flush();
    }));

    it('preserves the draft when re-authentication is cancelled', fakeAsync(async () => {
      await loaded();
      api.writeAnswer = () => throwError(() => new ElevationCancelledError());

      open('Record terms');
      fillTerms({ amount: '150000.00' });
      submit('Record terms').click();
      harness.detectChanges();

      // Nothing was sent, so nothing was decided — and a five-field form is exactly the
      // one an operator would least like to retype for having cancelled a prompt.
      expect(editor()).withContext('form stays open').not.toBeNull();
      expect(fieldValue('data-terms-amount')).toBe('150000.00');
      expect(fieldValue('data-terms-effective-from')).toBe('2026-08-01T00:00');
      expect(editor()!.textContent).toContain('Re-authentication was cancelled');
      flush();
    }));

    it('does not claim an indeterminate outage failed to commit', fakeAsync(async () => {
      await loaded();
      api.writeAnswer = () =>
        throwError(() => ({ status: 0, error: null, message: 'Http failure response' }));

      open('Record terms');
      fillTerms({ amount: '150000.00' });
      submit('Record terms').click();
      harness.detectChanges();

      // The write MAY have committed. An exact retry of one that landed answers
      // changed:false, which is precisely why the backend supports same-state retry.
      expect(editor()!.textContent).toContain('not known whether this change was recorded');
      expect(fieldValue('data-terms-amount')).withContext('draft preserved').toBe('150000.00');
      flush();
    }));

    // --- the state machine, end to end ----------------------------------------------

    it('offers Record again once the terms have been ended', fakeAsync(async () => {
      // Ending leaves the restaurant with NO current terms. Nothing is auto-created to
      // fill the gap — deciding the next terms is a separate decision somebody has to
      // make — so the row goes back to offering exactly one control.
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      api.writeAnswer = () => of({ changed: true, commercial: commercial() });

      open('End terms');
      set('data-terms-ended-at', '2026-08-20T09:00');
      set('data-commercial-reason', 'Restaurant is leaving the platform');
      submit('End terms').click();
      harness.detectChanges();

      expect(commercialText()).toContain('Subscription terms ended.');
      expect(commercialRow('Subscription terms')).toBe('Not configured');
      expect(controlLabelsFor('Subscription terms')).toEqual(['Record terms']);
      flush();
    }));

    function controlLabelsFor(term: string): (string | undefined)[] {
      const terms = Array.from(commercialPanel()?.querySelectorAll('dt') ?? []);
      const dt = terms.find((node) => node.textContent?.trim() === term);
      return Array.from(dt?.nextElementSibling?.querySelectorAll('button') ?? []).map((button) =>
        button.textContent?.trim(),
      );
    }

    // --- truthfulness ----------------------------------------------------------------

    it('states what ending terms does, and claims nothing it cannot support', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();
      open('End terms');
      // The PROSE, without the button row — `Cancel` is the form's own dismiss control
      // and says nothing about what ending terms does.
      const copy = Array.from(editor()!.querySelectorAll('h3, p'))
        .map((node) => node.textContent ?? '')
        .join(' ')
        .toLowerCase();

      expect(copy).toContain('leaves the restaurant with no current subscription terms');
      expect(copy).toContain('historical terms are retained.');
      // There is no invoice model, no receivable and no collection path behind any of
      // these words. Dinify has never taken a subscription payment through this system.
      for (const invented of [
        'cancel',
        'stops billing',
        'refund',
        'revoke',
        'deactivate',
        'suspend',
        'charge',
        'unsubscribe',
        'delete',
      ]) {
        expect(copy).withContext(invented).not.toContain(invented);
      }
      flush();
    }));

    it('never turns recorded terms into an account status, in any editor', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: withTerms() }));
      await loaded();

      for (const label of ['Replace terms', 'End terms']) {
        open(label);
        const copy = editor()!.textContent ?? '';
        for (const verdict of ['Active', 'Paid', 'Current', 'Trial', 'In good standing', 'Invoice']) {
          expect(copy).withContext(`${label}: ${verdict}`).not.toContain(verdict);
        }
      }
      flush();
    }));

    it('says terms are recorded, not agreed', fakeAsync(async () => {
      // An administrator writing down a price is not an owner accepting one, and nothing
      // in this projection carries owner consent.
      await loaded();
      open('Record terms');
      const copy = editor()!.textContent ?? '';

      expect(copy).toContain('not an invoice, a payment, or proof that the owner agreed');
      // The negatives are about OWNER CONSENT specifically. "a future moment is not
      // accepted" is a true statement about the boundary field, so a bare "accepted"
      // would fail a correct sentence about a different fact.
      for (const overclaim of [
        'agreed price',
        'owner accepted',
        'accepted by',
        'signed by',
        'countersigned',
        'approved by',
      ]) {
        expect(copy).withContext(overclaim).not.toContain(overclaim);
      }
      flush();
    }));
  });

  // ── RESPONSIVE REACHABILITY OF COMMERCIAL ACTIONS ────────────────────────────────
  //
  // THE DEFECT THESE EXIST FOR, reproduced in a real browser during live UAT:
  //
  //   At a 814x1000 viewport, on a restaurant with open subscription terms, the
  //   Commercial card was 259px wide and its terms row needed 320px. `End terms` laid
  //   out at x 519→576 while the card ended at x 515 — four pixels past the edge,
  //   painted under the neighbouring card, with `document.scrollingElement` reporting NO
  //   horizontal overflow to scroll to it and `elementFromPoint` at the button's own
  //   centre returning a different element entirely. The action was in the DOM and the
  //   operator could not press it.
  //
  //   Sweeping the range showed it was never about one button or one width: every
  //   viewport from 768px to 949px stranded at least one control, and at 768px even a
  //   single 69px `Change` button on a service axis did not fit.
  //
  // TWO THINGS CHANGED, and each covers a different failure:
  //
  //   The card grid goes two-column at `lg` (1024px) rather than `md` (768px), because
  //   a 236–327px card cannot hold a commercial row at all. That is the root cause.
  //
  //   The three control-bearing rows WRAP. That is the guarantee: a row that can wrap
  //   cannot strand a control no matter how long a value, a currency code or a future
  //   control label becomes. Without it the fix would hold only for today's strings.
  //
  // KARMA HAS NO LAYOUT ENGINE — `getBoundingClientRect` in a detached test fixture
  // measures nothing meaningful — so these pin the STRUCTURE that makes single-line
  // overflow unrepresentable, not the pixels. The pixels were verified in Chromium at
  // the widths named above, before and after.

  describe('commercial actions at constrained widths', () => {
    /** The row container and the actions container for one commercial term. */
    function containers(term: string): { row: HTMLElement; actions: HTMLElement } {
      const panel = el().querySelector('[aria-labelledby="commercial-heading"]')!;
      const dt = [...panel.querySelectorAll('dt')].find((n) => n.textContent?.trim() === term)!;
      return { row: dt.parentElement as HTMLElement, actions: dt.nextElementSibling as HTMLElement };
    }

    /** Every commercial row that carries a control, whatever the terms state. */
    function controlBearingTerms(): string[] {
      const panel = el().querySelector('[aria-labelledby="commercial-heading"]')!;
      return [...panel.querySelectorAll('dt')]
        .filter((dt) => dt.nextElementSibling?.querySelector('button'))
        .map((dt) => dt.textContent!.trim());
    }

    it('goes two-column only at lg, never at md', fakeAsync(async () => {
      // THE ROOT CAUSE. At `md` each card is 236–327px and a commercial row needs more
      // than that, so the surplus overflowed the card — Tailwind's columns are
      // `minmax(0, 1fr)`, which will not grow to contain their content.
      await loaded();

      const grid = el().querySelector('[aria-labelledby="commercial-heading"]')!.closest('.grid')!;
      expect(grid.className).toContain('lg:grid-cols-2');
      expect(grid.className).withContext('md is where the cards are too narrow').not.toContain(
        'md:grid-cols-2',
      );
      flush();
    }));

    /** Every control-bearing row carries the wrap, whatever state the panel is in. */
    function expectEveryRowWraps(): void {
      const terms = controlBearingTerms();
      expect(terms).withContext('all three rows offer a control').toEqual([
        'Payment timing',
        'Collection mode',
        'Subscription terms',
      ]);
      for (const term of terms) {
        const { row, actions } = containers(term);
        expect(row.className).withContext(`${term}: row wraps`).toContain('flex-wrap');
        expect(actions.className).withContext(`${term}: actions wrap`).toContain('flex-wrap');
      }
    }

    it('lets EVERY control-bearing row wrap — no open terms', fakeAsync(async () => {
      // Asserted per row rather than on the terms row alone: the sweep found the service
      // axes stranded their own `Change` button at 768px, so all three carry the
      // guarantee. `flex` without `flex-wrap` is what forced one unbounded line.
      await loaded();
      expectEveryRowWraps();
      flush();
    }));

    it('lets EVERY control-bearing row wrap — open terms', fakeAsync(async () => {
      // The reproduced case: two controls beside a three-line value is the widest a
      // commercial row ever gets, and is the one that stranded End terms.
      api.answer = () => of(detail({ commercial: commercial({ terms: {} }) }));
      await loaded();
      expectEveryRowWraps();
      flush();
    }));

    it('keeps the actions right-aligned and space-filling, so wide desktop is unchanged', fakeAsync(async () => {
      // `grow` + `justify-end` reproduces exactly what `justify-between` did while the
      // line fits — measured byte-identical at 1280px and 1500px, before and after. The
      // second line only ever appears where the alternative was an unreachable control.
      api.answer = () => of(detail({ commercial: commercial({ terms: {} }) }));
      await loaded();

      const { actions } = containers('Subscription terms');
      expect(actions.className).toContain('grow');
      expect(actions.className).toContain('justify-end');
      expect(actions.className).toContain('text-right');
      flush();
    }));

    function labels(term: string): (string | undefined)[] {
      return [...containers(term).actions.querySelectorAll('button')].map((b) =>
        b.textContent?.trim(),
      );
    }

    /** One Change per axis — not two, and not a hidden duplicate for a breakpoint. */
    function expectOneChangePerAxis(): void {
      for (const axis of ['Payment timing', 'Collection mode']) {
        expect(labels(axis)).withContext(axis).toEqual(['Change']);
      }
    }

    it('still offers exactly the right controls — no open terms', fakeAsync(async () => {
      // The layout change must not have touched the state machine, and must not have
      // duplicated a control by rendering a second responsive copy of it.
      await loaded();
      expect(labels('Subscription terms')).toEqual(['Record terms']);
      expectOneChangePerAxis();
      flush();
    }));

    it('still offers exactly the right controls — open terms', fakeAsync(async () => {
      api.answer = () => of(detail({ commercial: commercial({ terms: {} }) }));
      await loaded();
      expect(labels('Subscription terms')).toEqual(['Replace terms', 'End terms']);
      expectOneChangePerAxis();
      flush();
    }));

    it('leaves the editor and mutation semantics untouched', fakeAsync(async () => {
      // A layout fix that quietly changed which editor opens, or let two open at once,
      // would be a far worse defect than the one it fixed.
      api.answer = () => of(detail({ commercial: commercial({ terms: {} }) }));
      await loaded();
      const panel = () => el().querySelector('[aria-labelledby="commercial-heading"]')!;

      const replace = [...containers('Subscription terms').actions.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Replace terms',
      )!;
      replace.click();
      harness.detectChanges();
      expect(panel().querySelectorAll('[data-commercial-editor]').length).toBe(1);

      const change = containers('Payment timing').actions.querySelector('button')!;
      change.click();
      harness.detectChanges();
      expect(panel().querySelectorAll('[data-commercial-editor]').length)
        .withContext('still one editor, not one per breakpoint')
        .toBe(1);
      expect(panel().querySelector('[data-terms-editor]'))
        .withContext('opening the axis replaced the terms editor')
        .toBeNull();
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

  // ── EXACTLY FIVE COMMERCIAL WRITES, AND NO OTHERS ────────────────────────────────

  it('offers the commercial controls for the state it is in, and NOTHING else', fakeAsync(async () => {
    await loadedWith(onboarding({ source: 'admin_created', invitation: { status: 'pending' } }));

    // This assertion was `toEqual([])` at Step 2C and `['Change', 'Change']` at 3E.2.
    // Each time the honest replacement has been a SHARPER check rather than a weaker
    // one: the exact set, in place of a count that has stopped being true.
    //
    // THIS FIXTURE HAS NO OPEN TERMS, so the terms row offers Record and nothing else.
    // Replace and End would be two controls whose only possible outcome is a 409.
    const buttons = Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Change', 'Change', 'Record terms']);
    for (const fake of [
      'Adopt',
      'Attest',
      'Record attestation',
      'Issue invitation',
      'Send invitation',
      'Create restaurant',
      'Assign owner',
      'Replace terms',
      'End terms',
      'Edit subscription',
      'Edit commercial',
      // The four words this domain does not have. A control offering any of them would
      // promise a capability with no model, no receivable and no collection path behind
      // it — see `TERMS_COPY` in `restaurant-tabs.pages.ts`.
      'Cancel subscription',
      'Issue invoice',
      'Take payment',
      'Mark paid',
    ]) {
      expect(text()).withContext(fake).not.toContain(fake);
    }
    flush();
  }));

  it('offers Replace and End — and NOT Record — once terms are open', fakeAsync(async () => {
    await loadedWith(onboarding(), { commercial: commercial({ terms: {} }) });

    const buttons = Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Change', 'Change', 'Replace terms', 'End terms']);
    // Recording BESIDE open terms would suggest a second concurrent set is possible.
    // The database's partial unique index says it is not.
    expect(text()).not.toContain('Record terms');
    flush();
  }));

  it('offers NO terms control at all when the server sent no commercial object', fakeAsync(async () => {
    // ABSENCE IS NOT "NOT CONFIGURED". Without a projection this screen does not know
    // whether terms are open, and a control that guesses is a control that acts on a
    // guess — the same defect class as a dead backend presenting as "Invalid credentials."
    await loadedWith(onboarding(), { commercial: undefined });

    const buttons = Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons).withContext('the axes keep their controls; terms offer none').toEqual([
      'Change',
      'Change',
    ]);
    for (const control of ['Record terms', 'Replace terms', 'End terms']) {
      expect(text()).withContext(control).not.toContain(control);
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
