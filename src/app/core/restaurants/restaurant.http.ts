import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { apiUrl, COMMERCIAL_ROUTES, RESTAURANT_ROUTES } from '../api/api.constants';
import { RestaurantApi } from './restaurant.api';
import {
  CommercialMutationResult,
  DEFAULT_PAGE_SIZE,
  DirectoryQuery,
  EndSubscriptionTermsRequest,
  RecordSubscriptionTermsRequest,
  ReplaceSubscriptionTermsRequest,
  RestaurantDetail,
  RestaurantDirectoryPage,
  SetPaymentCollectionModeRequest,
  SetPaymentTimingRequest,
} from './restaurant.model';

/** The admin plane wraps every success as `{status, message, data}`. */
interface Envelope<T> {
  readonly status: number;
  readonly data: T;
}

/**
 * The real restaurant transport. Seven named operations; no other endpoint is reachable
 * from here — two reads, two service-configuration writes and three subscription-terms
 * writes.
 *
 * Same-origin and relative, so the `__Host-` session cookie rides automatically and
 * `withCredentials` is deliberately absent. It goes through the ordinary `HttpClient`
 * stack, so both interceptors apply: a 401 clears the session and routes to /login, a
 * 5xx raises the outage state, and nothing here re-implements any of that.
 *
 * ── WHY IT SENDS SO LITTLE ────────────────────────────────────────────────────────
 *
 * The backend's query string is DENY-BY-DEFAULT: `parse_directory_params` rejects any
 * key outside `KNOWN_PARAMS` with a 400 rather than ignoring it. So this builds the
 * query from the typed `DirectoryQuery` and never from `location.search` — a
 * hand-edited URL carrying `?stats=live` must not become a request that fails, and a
 * parameter this application does not own must never be forwarded.
 *
 * A parameter AT ITS DEFAULT IS OMITTED, matching the URL codecs: `page=1` and
 * `page_size=25` are what the server already does, so sending them would only make
 * every request longer and every test fixture noisier.
 *
 * ── AND WHY IT NORMALISES NOTHING ─────────────────────────────────────────────────
 *
 * The envelope is unwrapped and the payload is handed on exactly as it arrived. A
 * null `location`, a null `last_activity_at`, a null `latest_order` and a null
 * `payment_mode` each mean something specific, and a transport that helpfully
 * substituted `''` or `0` would destroy the distinction the screens above are built
 * to render honestly.
 */
@Injectable()
export class RestaurantHttp implements RestaurantApi {
  private readonly http = inject(HttpClient);

  list(query: DirectoryQuery): Observable<RestaurantDirectoryPage> {
    return this.http
      .get<Envelope<RestaurantDirectoryPage>>(apiUrl(RESTAURANT_ROUTES.list), {
        params: directoryParams(query),
      })
      .pipe(map((response) => response.data));
  }

  detail(id: string): Observable<RestaurantDetail> {
    return this.http
      .get<Envelope<RestaurantDetail>>(apiUrl(RESTAURANT_ROUTES.detail(id)))
      .pipe(map((response) => response.data));
  }

  // --- service-configuration writes (Step 3E.2) ---------------------------------
  //
  // TWO NAMED METHODS, TWO NAMED ROUTES. The private `write` helper below is envelope
  // unwrapping and nothing else — it takes a fully-formed route and body, so it can
  // neither choose an endpoint nor reshape a request, and the public surface stays two
  // operations a reader can enumerate.
  //
  // THE REQUEST OBJECT IS PASSED THROUGH VERBATIM. Nothing here defaults
  // `expected_current`, coalesces it, drops it when null, trims the reason or adds a
  // field. A transport that "helpfully" filled in a missing concurrency assertion would
  // hand the caller an assertion it never made — which is precisely the overwrite this
  // whole mechanism exists to prevent.

  setPaymentTiming(
    restaurantId: string,
    request: SetPaymentTimingRequest,
  ): Observable<CommercialMutationResult> {
    return this.#write(COMMERCIAL_ROUTES.paymentTiming(restaurantId), request);
  }

  setPaymentCollectionMode(
    restaurantId: string,
    request: SetPaymentCollectionModeRequest,
  ): Observable<CommercialMutationResult> {
    return this.#write(COMMERCIAL_ROUTES.paymentCollectionMode(restaurantId), request);
  }

  /**
   * POST one already-built commercial request and unwrap the envelope.
   *
   * Ordinary `HttpClient`, so the whole existing security stack applies without being
   * restated: `csrfInterceptor` adds `X-CSRFToken` from the `__Host-` cookie, and
   * `errorClassifierInterceptor` owns the 401, the bounded CSRF refresh-and-replay and
   * — the one that matters most here — the 403 that means "elevate first", which opens
   * ONE dialog and replays THIS EXACT request once on success. Rebuilding the body
   * after elevation is impossible from here, which is the point.
   *
   * A REAL `#private` method, not a TypeScript `private` one. The latter is erased at
   * compile time and leaves a generic `write(route, body)` sitting on the instance —
   * which is exactly the generic mutation surface this slice is supposed not to have. A
   * hash-private method is unreachable at runtime, so the public API really is two named
   * operations rather than two named operations plus an unadvertised third.
   */
  recordSubscriptionTerms(
    restaurantId: string,
    request: RecordSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    return this.#write(COMMERCIAL_ROUTES.recordSubscriptionTerms(restaurantId), request);
  }

  replaceSubscriptionTerms(
    restaurantId: string,
    request: ReplaceSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    return this.#write(COMMERCIAL_ROUTES.replaceSubscriptionTerms(restaurantId), request);
  }

  endSubscriptionTerms(
    restaurantId: string,
    request: EndSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    return this.#write(COMMERCIAL_ROUTES.endSubscriptionTerms(restaurantId), request);
  }

  #write<T>(route: string, body: T): Observable<CommercialMutationResult> {
    return this.http
      .post<Envelope<CommercialMutationResult>>(apiUrl(route), body)
      .pipe(map((response) => response.data));
  }
}

/**
 * Encode the directory query. Exported so a spec can assert the mapping directly
 * rather than only through a mocked `HttpClient`.
 *
 * `attention` is spelled `true`/`false` — both are meaningful to the server
 * (`false` EXCLUDES the attention set rather than ignoring the filter), so a
 * `false` that was explicitly asked for is sent, while `null` means "no opinion"
 * and is omitted.
 */
export function directoryParams(query: DirectoryQuery): HttpParams {
  let params = new HttpParams();

  const search = query.search?.trim();
  if (search) params = params.set('search', search);
  if (query.status) params = params.set('status', query.status);
  if (query.attention !== null) params = params.set('attention', String(query.attention));
  if (query.page > 1) params = params.set('page', String(query.page));
  if (query.pageSize !== null && query.pageSize !== DEFAULT_PAGE_SIZE) {
    params = params.set('page_size', String(query.pageSize));
  }

  return params;
}
