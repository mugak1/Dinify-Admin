import { Injectable } from '@angular/core';
import { delay, Observable, of, throwError } from 'rxjs';

import { MIN_REASON_LENGTH } from '../core/api/api.constants';
import { RestaurantApi } from '../core/restaurants/restaurant.api';
import {
  CommercialAxis,
  CommercialMutationResult,
  CommercialSummary,
  DirectoryQuery,
  PaymentCollectionMode,
  PaymentTiming,
  RestaurantDetail,
  RestaurantDirectoryPage,
  RestaurantRow,
  SetPaymentCollectionModeRequest,
  SetPaymentTimingRequest,
} from '../core/restaurants/restaurant.model';
import { MockHttpError } from './mock-http-error';
import { MOCK_RESTAURANT_DETAILS, MOCK_RESTAURANT_ROWS } from './mock-restaurants.fixtures';

/**
 * A build marker.
 *
 * `scripts/check-mock-isolation.mjs` fails the build if this literal appears anywhere
 * in a production bundle. Emitted through `console.warn` below so a minifier cannot
 * drop it as dead weight — a marker that can be optimised away proves nothing.
 */
export const MOCK_RESTAURANTS_BUILD_MARKER = 'DINIFY_ADMIN_MOCK_RESTAURANTS_PRESENT';

/**
 * THE DIRECTORY LEVERS. Set one in the console and reload:
 *
 *   sessionStorage.setItem('dinify-admin.mock-restaurants', 'error')  // the read fails
 *   sessionStorage.setItem('dinify-admin.mock-restaurants', 'empty')  // no restaurants
 *   sessionStorage.removeItem('dinify-admin.mock-restaurants')        // back to normal
 *
 * 'error' answers 500 WITH an `X-Request-ID`, so the failure state, the request id and
 * the outage banner are all reviewable; 'empty' returns a well-formed empty page, so
 * the "no restaurants yet" state can be told apart from the failure one — which is the
 * whole point of keeping them separate.
 *
 * A 404 needs no lever: navigate to `/restaurants/<any-other-uuid>`.
 */
const LEVER_KEY = 'dinify-admin.mock-restaurants';

/**
 * THE COMMERCIAL WRITE LEVER. Set it in the console and the NEXT service-configuration
 * write answers 409 as though another operator had moved the axis first:
 *
 *   sessionStorage.setItem('dinify-admin.mock-commercial', 'stale')  // conflict once
 *   sessionStorage.removeItem('dinify-admin.mock-commercial')        // back to normal
 *
 * It clears itself after firing, so the reload-and-review path can be walked end to end
 * — conflict, reload, fresh token, successful retry — which is the whole behaviour worth
 * reviewing and the one a permanently-stuck lever would make impossible to finish.
 */
const COMMERCIAL_LEVER_KEY = 'dinify-admin.mock-commercial';

/** Latency, so the loading states are actually visible when reviewing. */
const LATENCY_MS = 380;

/**
 * The mock restaurant transport — DEVELOPMENT ONLY.
 *
 * `npm start` renders the directory and the workspace with NO backend running, which
 * is how the screens get reviewed before a deploy carries them. It implements only the
 * two-route `RestaurantApi`; the pages, the workspace store, the states, the labels
 * and the formatting are the SAME CODE in both modes.
 *
 * ── IT IS NOT A FALLBACK, AND MUST NEVER BECOME ONE ───────────────────────────────
 *
 * REAL FAILURE IS NOT MOCK DATA. This is chosen at build time by `DEV_PROVIDERS`, not
 * reached for when a request fails: a control plane that quietly substitutes fixtures
 * for an unreachable server shows an operator a portfolio that does not exist, and the
 * decisions they take from it are taken against fiction. The production build cannot
 * reach this file at all — `dev-tools.ts` is file-replaced.
 *
 * ── IT FILTERS AND PAGES SERVER-SIDE, ON PURPOSE ──────────────────────────────────
 *
 * `search`, `status`, `attention` and `page` are applied HERE rather than in the page,
 * mirroring `apply_directory_filters` and the endpoint's slicing. If the mock returned
 * everything and let the page filter, `npm start` would review a directory that works
 * differently from the deployed one — and the pagination arithmetic, which is the part
 * most likely to be wrong, would never be exercised at all.
 */
@Injectable()
export class MockRestaurantApi implements RestaurantApi {
  constructor() {
    console.warn(
      `[dinify-admin] ${MOCK_RESTAURANTS_BUILD_MARKER} — mock restaurant data is active; no backend is being contacted.`,
    );
  }

  list(query: DirectoryQuery): Observable<RestaurantDirectoryPage> {
    const lever = sessionStorage.getItem(LEVER_KEY);
    if (lever === 'error') return this.fail();

    const source = lever === 'empty' ? [] : MOCK_RESTAURANT_ROWS;
    const matching = source
      .filter((row) => matches(row, query))
      // The overlay reaches the DIRECTORY too, because on the real backend it would:
      // both reads project the same server-side state, so a mock where a recorded
      // change was visible on the workspace but not in the row would review a portal
      // that cannot exist. No cache is involved — this is the read path fetching
      // current state, exactly as the deployed one does.
      .map((row) => ({ ...row, commercial: this.commercialFor(row.id, row.commercial) }));

    const pageSize = query.pageSize ?? 25;
    const count = matching.length;
    // Ceiling division, and at least 1 — the endpoint never reports 0 pages, so the
    // portal always has a page to render and never divides by it.
    const pages = Math.max(1, Math.ceil(count / pageSize));
    const offset = (query.page - 1) * pageSize;

    return this.ok({
      results: matching.slice(offset, offset + pageSize),
      pagination: { page: query.page, page_size: pageSize, count, pages },
    });
  }

  detail(id: string): Observable<RestaurantDetail> {
    if (sessionStorage.getItem(LEVER_KEY) === 'error') return this.fail();

    const found = MOCK_RESTAURANT_DETAILS.get(id);
    if (!found) {
      // The endpoint's own body, verbatim: `{status, message}`, not `{detail}`.
      return throwError(
        () => new MockHttpError(404, { status: 404, message: 'Restaurant not found.' }),
      ).pipe(delay(LATENCY_MS));
    }
    return this.ok({ ...found, commercial: this.commercialFor(id, found.commercial) });
  }

  // --- service-configuration writes (Step 3E.2) ---------------------------------
  //
  // THE SAME COMPONENTS CALL THESE IN BOTH MODES. There is no mock-only UI path: the
  // Overview panel, the editor, the token capture, the 409 handling and the store
  // adoption are the same code against a real backend, and this is what makes them
  // reviewable with `npm start`.
  //
  // WHAT IS DELIBERATELY NOT HERE: any authentication or elevation simulation. The real
  // endpoints are elevation-gated, but elevation is the interceptor's and
  // `ElevationService`'s job and both already have their own tests; a second
  // re-authentication implementation living in a fixture would be a second thing to keep
  // correct and would prove nothing about the real one.

  setPaymentTiming(
    restaurantId: string,
    request: SetPaymentTimingRequest,
  ): Observable<CommercialMutationResult> {
    return this.writeAxis(restaurantId, request, PAYMENT_TIMINGS, (commercial, axis) => ({
      ...commercial,
      payment_timing: axis as CommercialAxis<PaymentTiming>,
    }));
  }

  setPaymentCollectionMode(
    restaurantId: string,
    request: SetPaymentCollectionModeRequest,
  ): Observable<CommercialMutationResult> {
    return this.writeAxis(restaurantId, request, COLLECTION_MODES, (commercial, axis) => ({
      ...commercial,
      payment_collection_mode: axis as CommercialAxis<PaymentCollectionMode>,
    }));
  }

  /**
   * One axis write, applying the SERVER'S OWN RULES in the server's own order.
   *
   * Refusals first (vocabulary, reason, then concurrency), then the same-state no-op,
   * then the real mutation — because a request that is malformed is refused before its
   * concurrency assertion is even considered, and a same-state retry succeeds even when
   * that assertion has gone stale.
   */
  private writeAxis(
    restaurantId: string,
    request: { value: string; expected_current: string | null; reason: string },
    vocabulary: readonly string[],
    apply: (commercial: CommercialSummary, axis: CommercialAxis<string>) => CommercialSummary,
  ): Observable<CommercialMutationResult> {
    const found = MOCK_RESTAURANT_DETAILS.get(restaurantId);
    if (!found) {
      return this.throwLater(404, { status: 404, message: 'Restaurant not found.' });
    }

    // The serializer's closed `ChoiceField`s, both of them. `expected_current` is
    // REQUIRED and separately nullable: an explicit null is a legal assertion, an
    // omitted key is not — and `undefined` reaching here is exactly what an omitted key
    // looks like after `JSON.stringify` has dropped it.
    if (!vocabulary.includes(request.value)) {
      return this.invalid({ value: [`"${request.value}" is not a valid choice.`] });
    }
    if (request.expected_current === undefined) {
      return this.invalid({ expected_current: ['This field is required.'] });
    }
    if (request.expected_current !== null && !vocabulary.includes(request.expected_current)) {
      return this.invalid({
        expected_current: [`"${request.expected_current}" is not a valid choice.`],
      });
    }

    // `trim_whitespace=True` then `allow_blank=False`, then the house minimum.
    const reason = request.reason.trim();
    if (!reason) return this.invalid({ reason: ['This field may not be blank.'] });
    if (reason.length < MIN_REASON_LENGTH) {
      return this.invalid({
        reason: [`Please state a reason of at least ${MIN_REASON_LENGTH} characters.`],
      });
    }

    const commercial = this.commercialFor(restaurantId, found.commercial);
    const current = this.axisOf(commercial, vocabulary).value;

    // SAME STATE IS A SUCCESSFUL NO-OP, and it is checked BEFORE the concurrency
    // assertion — deliberately, mirroring the writer. A lost response followed by an
    // exact retry must not become a false conflict, and must not re-stamp `set_at`.
    if (current === request.value) {
      this.consumeStaleLever();
      return this.ok({ changed: false, commercial });
    }

    // The lever, and the real assertion. Either way the caller is told to reload and
    // look again rather than being allowed to overwrite what somebody else decided.
    if (this.consumeStaleLever() || current !== request.expected_current) {
      return this.throwLater(409, {
        status: 409,
        message: 'Commercial configuration changed since it was loaded.',
        code: 'stale_service_configuration',
      });
    }

    const next = apply(commercial, {
      configured: true,
      value: request.value,
      // A REAL mutation, so a real new timestamp — the one case where the mock advances
      // a clock, because `set_at` moving is the observable consequence of the write.
      set_at: new Date().toISOString(),
    });
    this.written.set(restaurantId, next);
    return this.ok({ changed: true, commercial: next });
  }

  /**
   * The commercial state for one restaurant: whatever a write last produced, else the
   * fixture's own.
   *
   * The overlay is what makes `npm start` honest about the consequence of a write —
   * navigate away, come back, and the value is still what was recorded. The fixtures
   * themselves stay immutable.
   */
  private readonly written = new Map<string, CommercialSummary>();

  private commercialFor(id: string, fallback: CommercialSummary): CommercialSummary {
    return this.written.get(id) ?? fallback;
  }

  /** Which axis a vocabulary belongs to. Keeps the two writers one implementation. */
  private axisOf(
    commercial: CommercialSummary,
    vocabulary: readonly string[],
  ): CommercialAxis<string> {
    return vocabulary === PAYMENT_TIMINGS
      ? commercial.payment_timing
      : commercial.payment_collection_mode;
  }

  /** True once if the conflict lever is armed, then disarms it. */
  private consumeStaleLever(): boolean {
    if (sessionStorage.getItem(COMMERCIAL_LEVER_KEY) !== 'stale') return false;
    sessionStorage.removeItem(COMMERCIAL_LEVER_KEY);
    return true;
  }

  private invalid<T>(errors: Record<string, readonly string[]>): Observable<T> {
    return this.throwLater(400, {
      status: 400,
      message: 'The request could not be applied.',
      errors,
    });
  }

  private throwLater<T>(status: number, body: unknown): Observable<T> {
    return throwError(() => new MockHttpError(status, body)).pipe(delay(LATENCY_MS));
  }

  private ok<T>(value: T): Observable<T> {
    return of(value).pipe(delay(LATENCY_MS));
  }

  private fail<T>(): Observable<T> {
    return throwError(
      () =>
        new MockHttpError(
          500,
          { status: 500, message: 'The admin service failed to answer.' },
          '2f1a9d44-7c05-4c2f-9c9e-0b3ab5f1d602',
        ),
    ).pipe(delay(LATENCY_MS));
  }
}

/** The two closed vocabularies, exactly as `commercial_app.models` spells them. */
const PAYMENT_TIMINGS: readonly string[] = ['pay_first', 'pay_after'];
const COLLECTION_MODES: readonly string[] = ['offline', 'psp_online'];

/** `apply_directory_filters`, in the same order and with the same semantics. */
function matches(row: RestaurantRow, query: DirectoryQuery): boolean {
  const search = query.search?.trim().toLowerCase();
  if (search) {
    const haystack = `${row.name} ${row.location ?? ''}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  if (query.status && row.status !== query.status) return false;
  // `false` EXCLUDES the attention set rather than ignoring the filter, matching the
  // server's `.exclude(attention_filter())`.
  if (query.attention !== null && row.needs_attention !== query.attention) return false;
  return true;
}
