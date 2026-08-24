import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import { DirectoryQuery, RestaurantDetail, RestaurantDirectoryPage } from './restaurant.model';

/**
 * The restaurant READ port — two routes, and nothing else.
 *
 * The second seam in this application that talks to a server, and it is shaped like
 * the first (`ADMIN_AUTH`) on purpose. A port plus a token is what keeps `npm start`
 * reviewable with no backend running: `src/app/dev` implements this interface, and
 * everything above it — the directory page, the workspace store, the states, the
 * formatting — is the same code in both modes. What gets reviewed is the real flow.
 *
 * IT IS DELIBERATELY NOT A GENERAL `ApiService`. A port names what it can reach, so
 * the set of endpoints this repo can call stays enumerable; a generic client that
 * takes a URL makes every future screen free to invent its own contract.
 *
 * IT IS STILL A READ PORT, AND STEP 3E.1 DELIBERATELY LEFT IT ONE. That step migrated
 * this application onto the backend's canonical `commercial` object — payment timing,
 * payment collection mode and subscription terms — but added no way to CHANGE any of
 * them. Reading the authoritative domain correctly comes first; exposing writes against
 * that exact truth comes second, which is the whole reason the two are separate steps.
 *
 * So there is no `setPaymentTiming`, no `setPaymentCollectionMode`, no
 * `recordSubscriptionTerms` / `replaceSubscriptionTerms` / `endSubscriptionTerms`, no
 * generic `post()` and no generic `ApiService` — and there must not be one until the
 * step that owns it lands:
 *
 *   Step 3E.2  the service-configuration controls (timing, collection mode)
 *   Step 3E.3  the subscription-terms controls
 *   Step 4     the lifecycle transition
 *
 * Each needs things this slice does not have: elevation, a written reason, and the
 * optimistic-concurrency assertion the read already carries the tokens for
 * (`payment_timing.value`, `payment_collection_mode.value`,
 * `subscription_terms.current.id` are what a writer sends back as `expected_*`).
 */
export interface RestaurantApi {
  /** The directory page for `query`. Only `KNOWN_PARAMS` are ever sent. */
  list(query: DirectoryQuery): Observable<RestaurantDirectoryPage>;

  /** One restaurant: the workspace header and Overview. 404 when missing or deleted. */
  detail(id: string): Observable<RestaurantDetail>;
}

export const RESTAURANT_API = new InjectionToken<RestaurantApi>('RESTAURANT_API');
