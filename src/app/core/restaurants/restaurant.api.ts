import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import {
  CommercialMutationResult,
  CreateRestaurantRequest,
  DirectoryQuery,
  EndSubscriptionTermsRequest,
  OwnerInvitationCancelResult,
  OwnerInvitationReissueResult,
  OwnerInvitationRequest,
  RecordSubscriptionTermsRequest,
  ReplaceSubscriptionTermsRequest,
  RestaurantCreationResult,
  RestaurantDetail,
  RestaurantDirectoryPage,
  SetPaymentCollectionModeRequest,
  SetPaymentTimingRequest,
} from './restaurant.model';

/**
 * The restaurant port — a BOUNDED, ENUMERABLE set of operations.
 *
 * Two reads, two service-configuration writes (Step 3E.2), three subscription-terms
 * writes (Step 3E.3), one creation (Step 2G) and two owner-invitation writes (Step 2G).
 * Ten named operations, and a reader can list them.
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
 * STEP 2G ADDED THREE MORE, under the same discipline. `createRestaurant` is the one
 * thing on this plane that can mint a tenant, an owner identity and a claim credential
 * in one request; `reissueOwnerInvitation` and `cancelOwnerInvitation` are the two
 * halves of the credential lifecycle — named, separate, and never
 * `ownerInvitationAction(kind, …)`, `mutateInvitation`, `updateOwner` or `resend…`.
 * Rotating a credential and terminating one are opposite decisions, and the method
 * called is what makes the audit trail readable.
 *
 * STILL ABSENT, and must stay absent until the step that owns them:
 *
 *   Step 4     the lifecycle transition
 *   —          any owner search, any delivery of a claim code, any owner reassignment
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

  // --- restaurant creation (Step 2G, backend Step 2D) ---------------------------

  /**
   * Create ONE new canonical restaurant, its owner authority, its `admin_created`
   * provenance and the owner's initial claim credential — all six rows or none.
   *
   * `POST /restaurants/`: the collection route, elevation-gated, CSRF-protected,
   * audited exactly once. Answers 201 with the canonical detail projection, the owner
   * account's id and whether it was created, and the invitation with its RAW claim
   * token — returned here and never again. Creation ISSUES the credential; it does not
   * deliver it, and it does not establish owner control. The restaurant starts
   * `onboarding` and cannot go live until the readiness engine exists.
   *
   * A phone already in use is a 409 `owner_account_already_exists` naming only the
   * existing account's UUID. NOTHING here, and nothing above this port, ever turns
   * that into an automatic `mode: "existing"` request.
   *
   * A 5xx or a dead socket is INDETERMINATE: the server may have committed and the
   * credential in its response is then lost. Nothing on this side retries a creation
   * automatically; the operator reloads the directory and, if the restaurant exists,
   * reissues the invitation from its workspace.
   */
  createRestaurant(request: CreateRestaurantRequest): Observable<RestaurantCreationResult>;

  // --- owner invitation (Step 2G, backend Step 2E) -------------------------------
  //
  // TWO NAMED OPERATIONS, mirroring two named routes. `reissue`, NEVER `resend`: this
  // system delivers nothing, and a method promising a delivery event would put a claim
  // in the code that the platform cannot keep. Both take the exact invitation the
  // operator reviewed (`expected_invitation_id`) and a reason, and both are
  // elevation-gated and audited.

  /**
   * ROTATE this restaurant's owner claim credential.
   *
   * Supersedes whatever unresolved invitation the onboarding presents, mints a fresh
   * one for the CURRENT canonical owner, and returns its raw claim token EXACTLY ONCE
   * beside the canonical `onboarding` projection. Refused (409) when the head has moved
   * (`stale_owner_invitation`), when the current owner has already claimed
   * (`owner_control_already_established`), when the owner relationship has drifted,
   * and when there is no usable owner account to invite.
   *
   * A lost response leaves the platform holding a credential nobody knows. THE REMEDY
   * IS TO REISSUE AGAIN — which supersedes that unknown credential and mints a known
   * one — never to recover plaintext that was never stored.
   */
  reissueOwnerInvitation(
    restaurantId: string,
    request: OwnerInvitationRequest,
  ): Observable<OwnerInvitationReissueResult>;

  /**
   * TERMINATE this restaurant's exact unresolved owner claim credential.
   *
   * Stamps it cancelled and creates NO replacement — reopening later is a separate,
   * deliberate reissue. Never requires owner consistency: revoking a credential must
   * stay possible exactly when a tenant's state is messy. An exact retry answers
   * `changed: false`, which is a success. Touches nothing about the owner account, its
   * customer access, or its access to other restaurants.
   */
  cancelOwnerInvitation(
    restaurantId: string,
    request: OwnerInvitationRequest,
  ): Observable<OwnerInvitationCancelResult>;
}

export const RESTAURANT_API = new InjectionToken<RestaurantApi>('RESTAURANT_API');
