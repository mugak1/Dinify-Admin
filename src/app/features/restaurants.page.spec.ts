import { Component } from '@angular/core';
import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject, of, throwError } from 'rxjs';

import { AdminServiceStatus } from '../core/api/service-status';
import { RESTAURANT_API, RestaurantApi } from '../core/restaurants/restaurant.api';
import {
  CommercialMutationResult,
  CommercialSubscriptionTerms,
  CommercialSummary,
  DirectoryQuery,
  PaymentCollectionMode,
  PaymentTiming,
  RestaurantDetail,
  RestaurantDirectoryPage,
  RestaurantRow,
} from '../core/restaurants/restaurant.model';
import { RestaurantsPage, SEARCH_DEBOUNCE_MS } from './restaurants.page';

/** Not an `HttpErrorResponse`: everything must classify by duck-typing. */
class WireError extends Error {
  readonly headers = { get: (name: string) => (name === 'X-Request-ID' ? REQUEST_ID : null) };
  constructor(
    readonly status: number,
    readonly error: unknown = null,
  ) {
    super(`HTTP ${status}`);
  }
}

const REQUEST_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/**
 * The canonical commercial projection, built the way the SERVER builds it: each axis's
 * `configured` derived from its value, and `subscription_terms.configured` from whether
 * an open row exists. A builder that let a spec write `configured: true` beside a null
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
      set_at: settings.timing === undefined ? null : '2026-08-20T12:00:00+03:00',
    },
    payment_collection_mode: {
      configured: settings.collection !== undefined,
      value: settings.collection ?? null,
      set_at: settings.collection === undefined ? null : '2026-08-20T12:00:00+03:00',
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
              recorded_at: '2026-08-01T00:00:00+03:00',
              ...terms,
            },
    },
  };
}

function row(overrides: Partial<RestaurantRow> = {}): RestaurantRow {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'Kampala Bistro',
    location: 'Nakasero, Kampala',
    status: 'live',
    is_test: false,
    readiness: { state: 'not_applicable', blocker_count: 0, blockers: [] },
    commercial: commercial(),
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
    last_activity_at: '2026-08-19T15:42:00+03:00',
    needs_attention: false,
    ...overrides,
  };
}

const ONBOARDING = row({
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  name: 'Ankole Grill House',
  location: 'Kololo, Kampala',
  status: 'onboarding',
  readiness: { state: 'not_ready', blocker_count: 1, blockers: ['readiness_not_configured'] },
  open_issue_count: 2,
  needs_attention: true,
});

const TEST_TENANT = row({
  id: 'cccccccc-0000-4000-8000-000000000003',
  name: 'Dinify Demo Kitchen',
  is_test: true,
  location: null,
  last_activity_at: null,
});

function pageOf(
  results: readonly RestaurantRow[],
  pagination: Partial<RestaurantDirectoryPage['pagination']> = {},
): RestaurantDirectoryPage {
  return {
    results,
    pagination: {
      page: 1,
      page_size: 25,
      count: results.length,
      pages: 1,
      ...pagination,
    },
  };
}

/** Records every query it is asked for, and lets a test choose when each one answers. */
class StubApi implements RestaurantApi {
  readonly queries: DirectoryQuery[] = [];
  answer: (query: DirectoryQuery) => Observable<RestaurantDirectoryPage> = () =>
    of(pageOf([row(), ONBOARDING, TEST_TENANT]));

  list(query: DirectoryQuery): Observable<RestaurantDirectoryPage> {
    this.queries.push(query);
    return this.answer(query);
  }

  detail(): Observable<RestaurantDetail> {
    throw new Error('the directory must not read a detail');
  }

  // THE DIRECTORY IS READ-ONLY, and these throw rather than returning something
  // harmless so that any future write control added to `/restaurants` fails a test
  // instead of silently working. Writes belong inside the workspace, where the
  // restaurant's identity and context stay visible while the change is made.
  setPaymentTiming(): Observable<CommercialMutationResult> {
    throw new Error('the directory must not write commercial state');
  }

  setPaymentCollectionMode(): Observable<CommercialMutationResult> {
    throw new Error('the directory must not write commercial state');
  }
}

@Component({ selector: 'app-detail-stub', template: 'detail' })
class DetailStub {}

/**
 * THE DIRECTORY. What these specs defend, in one sentence each:
 *
 *   LOADING, EMPTY AND FAILED ARE THREE DIFFERENT ANSWERS. "No restaurants match" is
 *   a real answer an operator will act on; a failed read is not an answer at all, and
 *   rendering it as an empty table is the same confident-false-statement defect as a
 *   dead backend presenting as "Invalid credentials.".
 *
 *   THE URL IS THE SOURCE OF TRUTH. Every filter round-trips, so Home's
 *   needs-attention links can address a filtered directory and a refresh keeps what
 *   was on screen.
 *
 *   A STALE RESPONSE CANNOT WIN. An older in-flight read must never repaint over a
 *   newer one, or the rows stop matching what the controls say.
 */
describe('RestaurantsPage', () => {
  let harness: RouterTestingHarness;
  let api: StubApi;
  let status: AdminServiceStatus;

  beforeEach(() => {
    api = new StubApi();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'restaurants', component: RestaurantsPage },
          { path: 'restaurants/:id', component: DetailStub },
        ]),
        { provide: RESTAURANT_API, useValue: api },
      ],
    });
    status = TestBed.inject(AdminServiceStatus);
  });

  async function open(url = '/restaurants'): Promise<RestaurantsPage> {
    harness = await RouterTestingHarness.create();
    return harness.navigateByUrl(url, RestaurantsPage);
  }

  function text(): string {
    return (harness.routeDebugElement?.nativeElement as HTMLElement).textContent ?? '';
  }
  function el(): HTMLElement {
    return harness.routeDebugElement?.nativeElement as HTMLElement;
  }
  function rows(): HTMLElement[] {
    return Array.from(el().querySelectorAll('[data-row]'));
  }
  function settle(): void {
    harness.detectChanges();
  }

  // --- states ---------------------------------------------------------------------

  it('shows a deliberate loading state before any answer arrives', fakeAsync(async () => {
    const pending = new Subject<RestaurantDirectoryPage>();
    api.answer = () => pending;

    await open();
    settle();

    expect(text()).toContain('Loading restaurants');
    expect(el().querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(el().querySelector('table')).withContext('no table yet').toBeNull();

    pending.next(pageOf([row()]));
    pending.complete();
    settle();
    flush();
  }));

  it('renders a row per restaurant once the read lands', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    expect(rows().length).toBe(3);
    expect(text()).toContain('Kampala Bistro');
    expect(text()).toContain('Ankole Grill House');
  }));

  it('renders the lifecycle pill, never a lifecycle string in a cell', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    const live = Array.from(rows()[0].querySelectorAll('app-status-pill span')).map((pill) =>
      pill.textContent?.trim(),
    );
    const onboarding = Array.from(rows()[1].querySelectorAll('app-status-pill span')).map((pill) =>
      pill.textContent?.trim(),
    );
    expect(live).toEqual(['Live']);
    expect(onboarding).toEqual(['Onboarding']);

    // The badge is a plain span, never a control: §16 says badges are status.
    const badge = rows()[0].querySelector('app-status-pill span');
    expect(badge?.hasAttribute('tabindex')).toBeFalse();
    expect(badge?.hasAttribute('role')).toBeFalse();
    flush();
  }));

  it('gives a TEST tenant the solid TEST pill', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    // Rows arrive in the server's order: Kampala Bistro, Ankole, Dinify Demo Kitchen.
    const testRow = rows()[2];
    const pills = Array.from(testRow.querySelectorAll('app-status-pill span'));
    const test = pills.find((pill) => pill.textContent?.trim() === 'Test');
    expect(test).withContext('the TEST pill is present').toBeTruthy();
    expect(test?.getAttribute('class')).toContain('bg-state-test');
    expect(test?.getAttribute('class'))
      .withContext('solid, not a sixth soft pill')
      .not.toContain('-soft');
    flush();
  }));

  it('renders readiness as Not configured, never as a failed checklist', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    // The seam fails closed until Step 3, so this is a statement about the ENGINE.
    expect(rows()[1].textContent).toContain('Not configured');
    expect(text()).not.toContain('readiness_not_configured');
    flush();
  }));

  it('renders readiness as Not applicable outside onboarding, never as Ready', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    expect(rows()[0].textContent).toContain('Not applicable');
    expect(rows()[0].textContent).not.toContain('Ready');
    flush();
  }));

  /**
   * ══ THE COMMERCIAL COLUMNS (Step 3E.1) ══════════════════════════════════════════
   *
   * Column 3 is Payment — BOTH canonical service axes in one dense cell — and column 4
   * is Subscription terms. Both read `commercial`, and neither reads a legacy field.
   */
  describe('the commercial columns', () => {
    /** `[payment, subscriptionTerms]` for the first row of a one-row page. */
    async function commercialCells(commercial: CommercialSummary): Promise<(string | undefined)[]> {
      api.answer = () => of(pageOf([row({ commercial })]));
      await open();
      settle();
      flush();
      settle();
      const cells = Array.from(rows()[0].querySelectorAll('td')).map((cell) =>
        cell.textContent?.trim(),
      );
      return [cells[3], cells[4]];
    }

    it('names the columns Payment and Subscription terms', fakeAsync(async () => {
      await open();
      settle();
      flush();
      settle();

      const headers = Array.from(el().querySelectorAll('th')).map((th) => th.textContent?.trim());
      // "Payment mode" lost its second word because there is no longer ONE mode to
      // name — the backend has a timing axis and a custody axis, and this column
      // reports both. "Subscription" became "Subscription terms" because terms are
      // what the row holds; a status is what it does not.
      expect(headers).toContain('Payment');
      expect(headers).not.toContain('Payment mode');
      expect(headers).toContain('Subscription terms');
      flush();
    }));

    it('stays at SEVEN columns — two facts do not buy an eighth', fakeAsync(async () => {
      await open();
      settle();
      flush();
      settle();

      expect(el().querySelectorAll('th').length).toBe(7);
      flush();
    }));

    it('renders both axes when both are configured', fakeAsync(async () => {
      const [payment] = await commercialCells(
        commercial({ timing: 'pay_first', collection: 'offline' }),
      );
      expect(payment).toBe('Pay first · Restaurant collects');
      flush();
    }));

    it('KEEPS PARTIAL CONFIGURATION VISIBLE in the cell', fakeAsync(async () => {
      const [timingOnly] = await commercialCells(commercial({ timing: 'pay_first' }));
      expect(timingOnly).toBe('Pay first · Collection not configured');
      flush();
    }));

    it('keeps a collection-only restaurant visible too', fakeAsync(async () => {
      const [collectionOnly] = await commercialCells(commercial({ collection: 'psp_online' }));
      expect(collectionOnly).toBe('Timing not configured · Dinify via PSP');
      flush();
    }));

    it('says Not configured only when NEITHER axis is decided', fakeAsync(async () => {
      const [payment] = await commercialCells(commercial());
      expect(payment).toBe('Not configured');
      flush();
    }));

    it('renders recorded TERMS, not a status word', fakeAsync(async () => {
      const [, terms] = await commercialCells(commercial({ terms: {} }));
      expect(terms).toBe('UGX 150,000 · every month');
      flush();
    }));

    it('renders a count greater than one with plural grammar', fakeAsync(async () => {
      const [, terms] = await commercialCells(
        commercial({
          terms: {
            recurring_amount: '300000.00',
            billing_interval: { unit: 'month', count: 2 },
          },
        }),
      );
      expect(terms).toBe('UGX 300,000 · every 2 months');
      flush();
    }));

    it('keeps a stored fraction and a zero price intact', fakeAsync(async () => {
      const [, fraction] = await commercialCells(
        commercial({ terms: { recurring_amount: '87500.50' } }),
      );
      expect(fraction).toBe('UGX 87,500.50 · every month');
      flush();
    }));

    it('renders zero-priced terms as a price, not as an absence', fakeAsync(async () => {
      const [, zero] = await commercialCells(commercial({ terms: { recurring_amount: '0.00' } }));
      expect(zero).toBe('UGX 0 · every month');
      expect(zero).not.toBe('Not configured');
      flush();
    }));

    it('says Not configured when there is no open terms row', fakeAsync(async () => {
      const [, terms] = await commercialCells(commercial());
      expect(terms).toBe('Not configured');
      flush();
    }));
  });

  /**
   * ══ THE COMPATIBILITY CUT-OVER'S MOST IMPORTANT PROOF ═══════════════════════════
   *
   * The wire carries BOTH contracts and they disagree BY DESIGN. The server freezes
   * `payment_mode` null / `payment_mode_configured` false / `has_commercial_subscription`
   * false, while `legacy_validity_flag` still varies and defaults TRUE. So for any
   * restaurant with real commercial state the two contracts contradict each other on
   * every read, and the portal has to follow exactly one of them.
   *
   * These fixtures make the contradiction explicit in both directions and assert on the
   * VISIBLE cell — not on a helper — because the failure being designed out is a screen
   * that quietly reads the wrong field.
   */
  describe('canonical commercial state OUTRANKS the compatibility fields', () => {
    async function cellsFor(overrides: Partial<RestaurantRow>): Promise<(string | undefined)[]> {
      api.answer = () => of(pageOf([row(overrides)]));
      await open();
      settle();
      flush();
      settle();
      return Array.from(rows()[0].querySelectorAll('td')).map((cell) => cell.textContent?.trim());
    }

    it('CASE A — canonical configured, legacy says unconfigured: canonical wins', fakeAsync(async () => {
      const cells = await cellsFor({
        // Canonical: fully configured, with real terms.
        commercial: commercial({
          timing: 'pay_first',
          collection: 'offline',
          terms: { recurring_amount: '150000.00' },
        }),
        // Legacy, contradicting it on every field — exactly what the server sends.
        payment_mode: null,
        payment_mode_configured: false,
        subscription: {
          source: 'legacy_restaurant_fields',
          has_commercial_subscription: false,
          legacy_validity_flag: false,
          legacy_expiry_at: null,
          preferred_method: 'per_order',
        },
      });

      expect(cells[3]).withContext('payment follows canonical').toBe('Pay first · Restaurant collects');
      expect(cells[4]).withContext('terms follow canonical').toBe('UGX 150,000 · every month');

      // The specific failure: the row reporting "Not configured" because the frozen
      // legacy booleans said so, for a restaurant that is fully configured.
      expect(cells[3]).not.toBe('Not configured');
      expect(cells[4]).not.toBe('Not configured');
      flush();
    }));

    it('CASE B — canonical unconfigured, legacy validity TRUE: never Active', fakeAsync(async () => {
      const cells = await cellsFor({
        // Canonical: all three facts unconfigured.
        commercial: commercial(),
        // Legacy, tempting the portal to claim a billing status.
        payment_mode: null,
        payment_mode_configured: false,
        subscription: {
          source: 'legacy_restaurant_fields',
          has_commercial_subscription: false,
          // Defaults true, nothing maintains it, and it is not evidence of an invoice.
          legacy_validity_flag: true,
          legacy_expiry_at: '2026-12-31T00:00:00+03:00',
          preferred_method: 'monthly',
        },
      });

      expect(cells[3]).toBe('Not configured');
      expect(cells[4]).toBe('Not configured');

      // An operator who reads "Paid" stops chasing an invoice that was never raised.
      // Scoped to the ROW, not the page: a page-wide search would collide with words
      // that are legitimately true elsewhere, and would then have to be loosened to
      // pass — which is how a real assertion becomes a decorative one.
      const visible = rows()[0].textContent ?? '';
      for (const invented of ['Active', 'Paid', 'Current account', 'Trial', 'In good standing']) {
        expect(visible).withContext(invented).not.toContain(invented);
      }
      flush();
    }));

    it('shows terms even when both service axes are still undecided', fakeAsync(async () => {
      // The three facts are independent. A price on record before anyone settled how
      // diners pay is a real state, and neither cell may suppress the other.
      const cells = await cellsFor({
        commercial: commercial({ terms: { recurring_amount: '87500.50' } }),
      });

      expect(cells[3]).toBe('Not configured');
      expect(cells[4]).toBe('UGX 87,500.50 · every month');
      flush();
    }));
  });

  it('renders the open-issue count with tabular numerals', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    const issues = Array.from(rows()[1].querySelectorAll('td'))[5];
    expect(issues.textContent?.trim()).toBe('2');
    expect(issues.getAttribute('class')).toContain('tabular-figures');
    flush();
  }));

  it('labels last activity as EAT, and renders an em dash when there is none', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    const withActivity = Array.from(rows()[0].querySelectorAll('td'))[6].textContent ?? '';
    expect(withActivity).toContain('EAT');
    expect(withActivity).toContain('19 Aug 2026');

    const without = Array.from(rows()[2].querySelectorAll('td'))[6].textContent?.trim();
    expect(without).toBe('—');
    flush();
  }));

  // --- row activation -------------------------------------------------------------

  it('opens the workspace on click', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    const router = TestBed.inject(Router);
    rows()[0].click();
    tick();

    expect(router.url).toBe(`/restaurants/${row().id}`);
    flush();
  }));

  it('opens the workspace on Enter', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    const router = TestBed.inject(Router);
    rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    tick();

    expect(router.url).toBe(`/restaurants/${ONBOARDING.id}`);
    flush();
  }));

  it('opens the workspace on Space', fakeAsync(async () => {
    await open();
    settle();
    flush();
    settle();

    const router = TestBed.inject(Router);
    rows()[2].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    tick();

    expect(router.url).toBe(`/restaurants/${TEST_TENANT.id}`);
    flush();
  }));

  // --- filters --------------------------------------------------------------------

  it('reads status and attention out of the entry URL and sends them', fakeAsync(async () => {
    await open('/restaurants?status=onboarding&attention=true');
    settle();
    flush();

    expect(api.queries.at(-1)).toEqual(
      jasmine.objectContaining({ status: 'onboarding', attention: true, page: 1 }),
    );
  }));

  it('reads search out of the entry URL and sends it', fakeAsync(async () => {
    await open('/restaurants?search=nile');
    settle();
    flush();

    expect(api.queries.at(-1)?.search).toBe('nile');
    const input = el().querySelector<HTMLInputElement>('#restaurant-search');
    expect(input?.value).withContext('the box shows what the URL says').toBe('nile');
  }));

  it('round-trips the lifecycle filter into the URL', fakeAsync(async () => {
    const page = await open();
    settle();
    flush();

    const select = el().querySelector<HTMLSelectElement>('#status-filter');
    select!.value = 'suspended';
    select!.dispatchEvent(new Event('change'));
    tick();
    settle();
    flush();

    expect(TestBed.inject(Router).url).toContain('status=suspended');
    expect(api.queries.at(-1)?.status).toBe('suspended');
    expect(page).toBeTruthy();
  }));

  it('round-trips the attention filter into the URL', fakeAsync(async () => {
    await open();
    settle();
    flush();

    const checkbox = el().querySelector<HTMLInputElement>('#attention-filter');
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change'));
    tick();
    settle();
    flush();

    expect(TestBed.inject(Router).url).toContain('attention=true');
    expect(api.queries.at(-1)?.attention).toBeTrue();
  }));

  it('debounces typing: one request, not one per keystroke', fakeAsync(async () => {
    await open();
    settle();
    flush();
    const before = api.queries.length;

    const input = el().querySelector<HTMLInputElement>('#restaurant-search');
    for (const value of ['n', 'ni', 'nil', 'nile']) {
      input!.value = value;
      input!.dispatchEvent(new Event('input'));
      tick(SEARCH_DEBOUNCE_MS / 4);
    }

    expect(api.queries.length).withContext('nothing yet').toBe(before);

    tick(SEARCH_DEBOUNCE_MS);
    settle();
    flush();

    expect(api.queries.length).toBe(before + 1);
    expect(api.queries.at(-1)?.search).toBe('nile');
    expect(TestBed.inject(Router).url).toContain('search=nile');
  }));

  it('returns to page 1 when the filter changes', fakeAsync(async () => {
    await open('/restaurants?page=3');
    settle();
    flush();
    expect(api.queries.at(-1)?.page).toBe(3);

    const select = el().querySelector<HTMLSelectElement>('#status-filter');
    select!.value = 'live';
    select!.dispatchEvent(new Event('change'));
    tick();
    settle();
    flush();

    // Page 3 of a filter that has just changed is almost always empty, and an empty
    // page reads as "nothing matches".
    expect(api.queries.at(-1)?.page).toBe(1);
    expect(TestBed.inject(Router).url).not.toContain('page=');
  }));

  // --- quick views ----------------------------------------------------------------

  it('selects All when nothing is filtered', fakeAsync(async () => {
    await open();
    settle();
    flush();

    expect(selectedView()).toBe('All');
  }));

  it('selects Needs attention for ?attention=true, and sets it when clicked', fakeAsync(async () => {
    await open('/restaurants?attention=true');
    settle();
    flush();
    expect(selectedView()).toBe('Needs attention');

    clickView('All');
    tick();
    settle();
    flush();
    expect(TestBed.inject(Router).url).toBe('/restaurants');

    clickView('Needs attention');
    tick();
    settle();
    flush();
    expect(TestBed.inject(Router).url).toContain('attention=true');
    expect(api.queries.at(-1)?.attention).toBeTrue();
    expect(api.queries.at(-1)?.status).toBeNull();
  }));

  it('selects Onboarding for ?status=onboarding, and clears attention when clicked', fakeAsync(async () => {
    await open('/restaurants?attention=true');
    settle();
    flush();

    clickView('Onboarding');
    tick();
    settle();
    flush();

    expect(selectedView()).toBe('Onboarding');
    expect(api.queries.at(-1)?.status).toBe('onboarding');
    expect(api.queries.at(-1)?.attention).withContext('not combined').toBeNull();
  }));

  it('never shows All as selected while a status filter is set', fakeAsync(async () => {
    await open('/restaurants?status=suspended');
    settle();
    flush();

    // A selected view that does not describe the URL is worse than none: the control
    // then reports the operator's last click instead of what they are looking at.
    expect(selectedView()).toBe('Custom');
  }));

  function selectedView(): string | undefined {
    const selected = el().querySelector('[role="tab"][aria-selected="true"]');
    return selected?.textContent?.trim();
  }
  function clickView(label: string): void {
    const tab = Array.from(el().querySelectorAll<HTMLElement>('button[role="tab"]')).find(
      (button) => button.textContent?.trim() === label,
    );
    tab?.click();
  }

  it('drops a pending search when a quick view supersedes it', fakeAsync(async () => {
    await open();
    settle();
    flush();

    const input = el().querySelector<HTMLInputElement>('#restaurant-search');
    input!.value = 'nile';
    input!.dispatchEvent(new Event('input'));
    tick(SEARCH_DEBOUNCE_MS / 2);

    // Inside the debounce window, the operator picks a quick view instead.
    clickView('Onboarding');
    tick();
    settle();
    flush();

    // Let the superseded timer's deadline pass.
    tick(SEARCH_DEBOUNCE_MS * 2);
    settle();
    flush();

    expect(TestBed.inject(Router).url).not.toContain('search=');
    expect(api.queries.at(-1)?.search).toBeNull();
    expect(api.queries.at(-1)?.status).toBe('onboarding');
    // The chosen view must still be the chosen view.
    expect(selectedView()).toBe('Onboarding');
    flush();
  }));

  it('drops a pending search when Clear filters supersedes it', fakeAsync(async () => {
    await open('/restaurants?status=live');
    settle();
    flush();

    const input = el().querySelector<HTMLInputElement>('#restaurant-search');
    input!.value = 'nile';
    input!.dispatchEvent(new Event('input'));
    tick(SEARCH_DEBOUNCE_MS / 2);

    clearFilters();
    tick();
    settle();
    flush();
    tick(SEARCH_DEBOUNCE_MS * 2);
    settle();
    flush();

    expect(TestBed.inject(Router).url).toBe('/restaurants');
    expect(api.queries.at(-1)?.search).toBeNull();
    flush();
  }));

  // --- pagination -----------------------------------------------------------------

  it('reports the range and page from the server metadata', fakeAsync(async () => {
    api.answer = () => of(pageOf([row(), ONBOARDING], { page: 2, count: 34, pages: 2 }));
    await open('/restaurants?page=2');
    settle();
    flush();
    settle();

    expect(text()).toContain('26–27 of 34');
    expect(text()).toContain('Page 2 of 2');
    flush();
  }));

  it('disables Previous on the first page and Next on the last', fakeAsync(async () => {
    api.answer = () => of(pageOf([row()], { page: 1, count: 30, pages: 2 }));
    await open();
    settle();
    flush();
    settle();

    expect(pageButton('Previous')?.disabled).toBeTrue();
    expect(pageButton('Next')?.disabled).toBeFalse();

    api.answer = () => of(pageOf([row()], { page: 2, count: 30, pages: 2 }));
    pageButton('Next')!.click();
    tick();
    settle();
    flush();
    settle();

    expect(TestBed.inject(Router).url).toContain('page=2');
    expect(api.queries.at(-1)?.page).toBe(2);
    expect(pageButton('Previous')?.disabled).toBeFalse();
    expect(pageButton('Next')?.disabled).toBeTrue();
    flush();
  }));

  function pageButton(label: string): HTMLButtonElement | undefined {
    return Array.from(el().querySelectorAll<HTMLButtonElement>('nav button')).find(
      (button) => button.textContent?.trim() === label,
    );
  }

  // --- empty and failure ----------------------------------------------------------

  it('says "no restaurants yet" when nothing is filtered and nothing exists', fakeAsync(async () => {
    api.answer = () => of(pageOf([]));
    await open();
    settle();
    flush();
    settle();

    expect(text()).toContain('No restaurants yet.');
    expect(text()).not.toContain('Clear filters');
    flush();
  }));

  it('says the filters matched nothing, and offers to clear them', fakeAsync(async () => {
    api.answer = () => of(pageOf([]));
    await open('/restaurants?status=offboarded');
    settle();
    flush();
    settle();

    expect(text()).toContain('No restaurants match these filters.');
    expect(text()).toContain('Clear filters');

    clearFilters();
    tick();
    settle();
    flush();

    expect(TestBed.inject(Router).url).toBe('/restaurants');
    flush();
  }));

  /**
   * A page past the end is NOT an empty portfolio. The server answers a well-formed
   * page number it cannot reach with an empty `results` and an honest `count`, so
   * reading that as "No restaurants yet" would tell the operator something false
   * about the whole platform — the same defect class as a dead backend reading
   * "Invalid credentials.".
   */
  it('does not call a page past the end an empty portfolio', fakeAsync(async () => {
    api.answer = () => of(pageOf([], { page: 999, count: 34, pages: 2 }));
    await open('/restaurants?page=999');
    settle();
    flush();
    settle();

    expect(text()).not.toContain('No restaurants yet.');
    expect(text()).not.toContain('No restaurants match these filters.');
    expect(text()).toContain('past the end');
    expect(text()).toContain('34 restaurants');
    expect(text()).toContain('2 pages');
    flush();
  }));

  it('offers a way back to the last page that holds rows', fakeAsync(async () => {
    api.answer = () => of(pageOf([], { page: 999, count: 34, pages: 2 }));
    await open('/restaurants?page=999');
    settle();
    flush();
    settle();

    api.answer = () => of(pageOf([row()], { page: 2, count: 34, pages: 2 }));
    Array.from(el().querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Go to the last page')
      ?.click();
    tick();
    settle();
    flush();
    settle();

    expect(api.queries.at(-1)?.page).toBe(2);
    expect(TestBed.inject(Router).url).toContain('page=2');
    expect(rows().length).toBe(1);
    flush();
  }));

  it('still calls a genuinely empty page empty, filtered or not', fakeAsync(async () => {
    // count === 0 is the real "nothing here" — it must not be swallowed by the
    // beyond-the-end branch.
    api.answer = () => of(pageOf([], { page: 1, count: 0, pages: 1 }));
    await open();
    settle();
    flush();
    settle();

    expect(text()).toContain('No restaurants yet.');
    expect(text()).not.toContain('past the end');
    flush();
  }));

  it('never renders a reversed range for a page with no rows', fakeAsync(async () => {
    api.answer = () => of(pageOf([], { page: 999, count: 34, pages: 2 }));
    await open('/restaurants?page=999');
    settle();
    flush();
    settle();

    // The naive arithmetic gives "24951–34 of 34".
    expect(text()).not.toContain('24951');
    flush();
  }));

  it('renders a FAILURE as a failure, never as an empty directory', fakeAsync(async () => {
    api.answer = () => throwError(() => new WireError(500, { status: 500, message: 'boom' }));
    await open();
    settle();
    flush();
    settle();

    expect(text()).toContain('could not be loaded');
    expect(text()).not.toContain('No restaurants yet.');
    expect(el().querySelector('table')).withContext('no table at all').toBeNull();
    expect(text()).withContext('the request id, for the report').toContain(REQUEST_ID);
    flush();
  }));

  it('raises the shared outage state for a 5xx, so the shell banner appears too', fakeAsync(async () => {
    api.answer = () => throwError(() => new WireError(500, { status: 500, message: 'boom' }));
    await open();
    settle();
    flush();
    settle();

    // No interceptor runs in mock mode, so the page classifies transport failure
    // itself through the shared implementation.
    expect(status.unavailable()).toBeTrue();
    expect(status.requestId()).toBe(REQUEST_ID);
    flush();
  }));

  it('retries on demand, and recovers', fakeAsync(async () => {
    let failing = true;
    api.answer = () =>
      failing ? throwError(() => new WireError(500, null)) : of(pageOf([row()]));

    await open();
    settle();
    flush();
    settle();
    const attempts = api.queries.length;
    expect(text()).toContain('could not be loaded');

    failing = false;
    retry();
    tick();
    settle();
    flush();
    settle();

    expect(api.queries.length).toBe(attempts + 1);
    expect(rows().length).toBe(1);
    expect(text()).not.toContain('could not be loaded');
    flush();
  }));

  it('clears the outage state once a retry succeeds', fakeAsync(async () => {
    let failing = true;
    api.answer = () =>
      failing ? throwError(() => new WireError(500, null)) : of(pageOf([row()]));

    await open();
    settle();
    flush();
    settle();
    expect(status.unavailable()).toBeTrue();

    failing = false;
    retry();
    tick();
    settle();
    flush();
    settle();

    // No interceptor runs in mock mode, so the page owns BOTH halves of the report.
    // Without the success half the shell banner keeps claiming the control plane is
    // down long after it answered.
    expect(status.unavailable()).withContext('the banner must come down').toBeFalse();
    expect(status.requestId()).toBeNull();
    flush();
  }));

  function clearFilters(): void {
    Array.from(el().querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Clear filters')
      ?.click();
  }
  function retry(): void {
    Array.from(el().querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Try again')
      ?.click();
  }

  // --- race safety ----------------------------------------------------------------

  it('never lets an older response overwrite a newer one', fakeAsync(async () => {
    const slow = new Subject<RestaurantDirectoryPage>();
    const fast = new Subject<RestaurantDirectoryPage>();

    api.answer = (query) => (query.status === null ? slow : fast);

    await open();
    settle();

    // Narrow the filter while the first read is still in flight.
    const select = el().querySelector<HTMLSelectElement>('#status-filter');
    select!.value = 'live';
    select!.dispatchEvent(new Event('change'));
    tick();
    settle();

    fast.next(pageOf([TEST_TENANT]));
    settle();
    expect(rows().length).toBe(1);
    expect(text()).toContain('Dinify Demo Kitchen');

    // The stale read finally answers. `switchMap` unsubscribed it, so nothing lands.
    slow.next(pageOf([row(), ONBOARDING, TEST_TENANT]));
    settle();

    expect(rows().length).withContext('the newer result still stands').toBe(1);
    expect(text()).not.toContain('Ankole Grill House');
    flush();
  }));
});
