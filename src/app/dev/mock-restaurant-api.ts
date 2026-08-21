import { Injectable } from '@angular/core';
import { delay, Observable, of, throwError } from 'rxjs';

import { RestaurantApi } from '../core/restaurants/restaurant.api';
import {
  DirectoryQuery,
  RestaurantDetail,
  RestaurantDirectoryPage,
  RestaurantRow,
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
    const matching = source.filter((row) => matches(row, query));

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
    return this.ok(found);
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
