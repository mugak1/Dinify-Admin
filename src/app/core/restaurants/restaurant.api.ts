import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import {
  CommercialMutationResult,
  DirectoryQuery,
  EndSubscriptionTermsRequest,
  RecordSubscriptionTermsRequest,
  ReplaceSubscriptionTermsRequest,
  RestaurantDetail,
  RestaurantDirectoryPage,
  SetPaymentCollectionModeRequest,
  SetPaymentTimingRequest,
} from './restaurant.model';

/**
 * The restaurant port — a BOUNDED, ENUMERABLE set of operations.
 *
 * Two reads, two service-configuration writes (Step 3E.2) and three subscription-terms
 * writes (Step 3E.3). Seven named operations, and a reader can list them.
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
 * IT GREW EXACTLY TWO WRITES IN STEP 3E.2, AND THE SHAPE OF THAT GROWTH IS THE POINT.
 * Step 3E.1 migrated this application onto the backend's canonical `commercial` object
 * and deliberately added no way to change it; reading the authoritative domain
 * correctly comes first, and exposing writes against that exact truth comes second.
 *
 * The two writes are NAMED, SEPARATE OPERATIONS, mirroring the two named endpoints —
 * not `setCommercialField(field, ...)`, not `mutateCommercial`, not `setAxis`, and
 * emphatically not a generic `post(url, body)`. Payment timing is a SERVICE-MODEL
 * decision and payment collection mode is a CUSTODY decision; they have different
 * vocabularies, different consequences and plausibly different future write authority,
 * and a parameterised method would make "what did this operator change?" a question
 * about an argument rather than about which operation was called.
 *
 * STILL ABSENT, and must stay absent until the step that owns them:
 *
 *   Step 4     the lifecycle transition
 *
 * ── WHAT THE PORT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It does not read the CSRF cookie, set `X-CSRFToken`, call `/auth/elevate/`, inspect
 * the client's elevation timestamp or preflight anything. Those POSTs go through the
 * ordinary `HttpClient` stack, so the existing interceptors supply CSRF, the bounded
 * refresh-and-replay, 401 handling, ONE elevation prompt and ONE replay of the
 * ORIGINAL request. A second, commercial-specific re-authentication path would be a
 * second thing to keep correct, and the server is authoritative either way.
 */
export interface RestaurantApi {
  /** The directory page for `query`. Only `KNOWN_PARAMS` are ever sent. */
  list(query: DirectoryQuery): Observable<RestaurantDirectoryPage>;

  /** One restaurant: the workspace header and Overview. 404 when missing or deleted. */
  detail(id: string): Observable<RestaurantDetail>;

  /**
   * Record this restaurant's PAYMENT TIMING — `pay_first` | `pay_after`.
   *
   * A service-model decision: must settlement be recorded before the kitchen may fire
   * the order, or does the order fire immediately and the tab settle at the end? It
   * says nothing about custody, tender or provider.
   *
   * Elevation-gated, audited, and asserted against `request.expected_current`. Answers
   * 409 when the axis moved since it was loaded, and success with `changed: false` when
   * the requested value is already stored.
   */
  setPaymentTiming(
    restaurantId: string,
    request: SetPaymentTimingRequest,
  ): Observable<CommercialMutationResult>;

  /**
   * Record this restaurant's PAYMENT COLLECTION MODE — `offline` | `psp_online`.
   *
   * A custody decision: does Dinify initiate the diner payment through a licensed
   * provider on the restaurant's behalf, or does the restaurant collect it itself?
   *
   * `psp_online` PERFORMS EXACTLY ONE COMMERCIAL CONFIGURATION MUTATION. It contacts no
   * provider, creates no merchant record, validates no onboarding, initiates no payment
   * and proves no readiness — there is no PSP integration on the platform at all.
   *
   * Same gating, audit, concurrency and same-state semantics as the timing write.
   */
  setPaymentCollectionMode(
    restaurantId: string,
    request: SetPaymentCollectionModeRequest,
  ): Observable<CommercialMutationResult>;

  // --- subscription terms (Step 3E.3) ------------------------------------------
  //
  // THREE NAMED OPERATIONS, mirroring three named routes. Never
  // `mutateSubscriptionTerms(action, …)`, never `setSubscriptionTerms`, never an
  // `action` argument: recording first terms, superseding the open ones and closing
  // them have different preconditions, different concurrency tokens and different
  // histories left behind, and the method called is what makes an audit trail readable.
  //
  // These record the recurring SOFTWARE-SUBSCRIPTION terms a restaurant pays DINIFY.
  // Recording them charges nobody, raises no invoice, and proves nothing about the
  // owner having accepted them.

  /**
   * Record the restaurant's terms, when it has none open.
   *
   * NO CONCURRENCY TOKEN, deliberately — the precondition is ABSENCE, enforced under
   * the restaurant lock. Identical open terms answer success with `changed: false`; any
   * difference is a 409 `subscription_terms_already_open`.
   *
   * Also the route for reopening after a previous set was ended, subject to the
   * monotonic timeline rule: terms may not begin before the previous set ended.
   */
  recordSubscriptionTerms(
    restaurantId: string,
    request: RecordSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult>;

  /**
   * Supersede the exact currently-open terms named by `expected_terms_id`.
   *
   * NOT AN EDIT. The outgoing row is closed at exactly the replacement's
   * `effective_from` and a new immutable row becomes current; the superseded row stays
   * in history. A replacement whose four commercial facts are unchanged is a no-op —
   * re-dating unchanged terms is a different, out-of-scope correction.
   */
  replaceSubscriptionTerms(
    restaurantId: string,
    request: ReplaceSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult>;

  /**
   * Close the exact currently-open terms, leaving the restaurant with none.
   *
   * Creates no replacement and deletes no history. An exact retry is a no-op ONLY while
   * nothing has been opened since — if it has, the server answers 409, because the
   * operation's stated postcondition no longer holds.
   */
  endSubscriptionTerms(
    restaurantId: string,
    request: EndSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult>;
}

export const RESTAURANT_API = new InjectionToken<RestaurantApi>('RESTAURANT_API');
