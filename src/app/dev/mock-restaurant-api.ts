import { Injectable } from '@angular/core';
import { delay, Observable, of, throwError } from 'rxjs';

import { MIN_REASON_LENGTH } from '../core/api/api.constants';
import { RestaurantApi } from '../core/restaurants/restaurant.api';
import {
  BLOCKER_READINESS_NOT_CONFIGURED,
  CommercialAxis,
  CommercialMutationResult,
  CommercialSubscriptionTerms,
  CommercialSummary,
  CreateRestaurantRequest,
  DirectoryQuery,
  EndSubscriptionTermsRequest,
  OnboardingSummary,
  OwnerInvitationCancelResult,
  OwnerInvitationProjection,
  OwnerInvitationReissueResult,
  OwnerInvitationRequest,
  PaymentCollectionMode,
  PaymentTiming,
  RecordSubscriptionTermsRequest,
  ReplaceSubscriptionTermsRequest,
  RestaurantCreationResult,
  RestaurantDetail,
  RestaurantDirectoryPage,
  RestaurantOwner,
  RestaurantRow,
  SetPaymentCollectionModeRequest,
  SetPaymentTimingRequest,
} from '../core/restaurants/restaurant.model';
import { MockHttpError } from './mock-http-error';
import {
  compareRows,
  MOCK_OWNER_ACCOUNTS,
  MOCK_OWNER_INVITATION_TTL_MS,
  MOCK_RESTAURANT_DETAILS,
  MOCK_RESTAURANT_ROWS,
  MockOwnerAccount,
} from './mock-restaurants.fixtures';

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
 * THE COMMERCIAL WRITE LEVER. Set it in the console and the NEXT commercial write —
 * either service-configuration axis, or any of the three subscription-terms operations
 * — answers 409 as though another operator had moved underneath it:
 *
 *   sessionStorage.setItem('dinify-admin.mock-commercial', 'stale')  // conflict once
 *   sessionStorage.removeItem('dinify-admin.mock-commercial')        // back to normal
 *
 * It clears itself after firing, so the reload-and-review path can be walked end to end
 * — conflict, reload, fresh token, successful retry — which is the whole behaviour worth
 * reviewing and the one a permanently-stuck lever would make impossible to finish.
 *
 * IT IS CONSUMED ON A NO-OP TOO, and never turns one into a conflict. An exact retry
 * succeeds even when the world has moved, which is the property that keeps a lost
 * response from becoming a false conflict; a lever that overrode it would be reviewing
 * behaviour the server does not have.
 */
const COMMERCIAL_LEVER_KEY = 'dinify-admin.mock-commercial';

/**
 * THE CREATION LEVER. Set it in the console and the NEXT `createRestaurant` answers as
 * though the admin service had died mid-request:
 *
 *   sessionStorage.setItem('dinify-admin.mock-create', 'lost')  // COMMITS, then answers 500
 *   sessionStorage.setItem('dinify-admin.mock-create', 'down')  // answers 500, commits nothing
 *   sessionStorage.removeItem('dinify-admin.mock-create')       // back to normal
 *
 * From where the client stands both are ONE outcome — INDETERMINATE, because a 5xx says
 * nothing about whether the transaction committed — and the two settings exist so both
 * truths behind it can be reviewed. After 'lost' the restaurant IS in the directory, and
 * the claim code its creation minted was never shown to anyone, so the workspace's
 * Readiness tab has to offer a reissue; after 'down' there is nothing to find. Neither is
 * a "creation failed", the page must never say so, and the lever is how that copy gets
 * reviewed. Both clear themselves after firing.
 *
 * Conflicts need no lever: state an owner phone the corpus already holds (Ankole Grill
 * House's owner is 256772140388) for `owner_account_already_exists`, or a restaurant
 * name and location that already exist for `restaurant_already_exists`.
 */
const CREATE_LEVER_KEY = 'dinify-admin.mock-create';
const CREATE_LEVER_VALUES = ['lost', 'down'] as const;

/**
 * THE INVITATION LEVER, for the NEXT reissue or cancel:
 *
 *   sessionStorage.setItem('dinify-admin.mock-invitation', 'stale')  // 409, once
 *   sessionStorage.setItem('dinify-admin.mock-invitation', 'lost')   // COMMITS, then 500
 *   sessionStorage.setItem('dinify-admin.mock-invitation', 'down')   // 500, commits nothing
 *   sessionStorage.removeItem('dinify-admin.mock-invitation')        // back to normal
 *
 * 'stale' is the concurrency conflict — another operator moved the invitation first —
 * and walks the same reload-and-review path as the commercial lever. 'lost' is the
 * outcome that matters most on a REISSUE: the credential was rotated and the response
 * carrying the new raw code never arrived, so the canonical read shows a newer head
 * nobody has seen and the only remedy is to reissue AGAIN. 'down' leaves the invitation
 * exactly as it was. All three clear themselves after firing, and none of them ever
 * overrides a no-op: cancelling an already-cancelled invitation succeeds with
 * `changed: false` whatever the lever says, because that is what the server does.
 */
const INVITATION_LEVER_KEY = 'dinify-admin.mock-invitation';
const INVITATION_LEVER_VALUES = ['stale', 'lost', 'down'] as const;

/** Latency, so the loading states are actually visible when reviewing. */
const LATENCY_MS = 380;

/**
 * `actor_display` for the mock session: the operator has no first or last name on the
 * mock, so the backend's rule falls through to the email, exactly as it would.
 */
const MOCK_ACTOR = 'operator@dinifyapp.com';

/** The endpoint's curated sentences for the two invitation conflicts raised in three places. */
const STALE_INVITATION_MESSAGE = 'The owner invitation changed since it was loaded.';
const OWNER_CONSISTENCY_MESSAGE =
  "This restaurant's owner of record and owner authority disagree. Resolve that before issuing a new claim credential.";

/** A newborn tenant's commercial state: nothing decided, nothing recorded. */
const UNCONFIGURED_COMMERCIAL: CommercialSummary = {
  payment_timing: { configured: false, value: null, set_at: null },
  payment_collection_mode: { configured: false, value: null, set_at: null },
  subscription_terms: { configured: false, current: null },
};

/**
 * The mock restaurant transport — DEVELOPMENT ONLY.
 *
 * `npm start` renders the directory and the workspace with NO backend running, which
 * is how the screens get reviewed before a deploy carries them. It implements the whole
 * `RestaurantApi` — two reads, two service-configuration writes, three
 * subscription-terms writes, restaurant creation and the two owner-invitation writes;
 * the pages, the workspace store, the states, the labels and the formatting are the
 * SAME CODE in both modes.
 *
 * ── IT MINTS CLAIM CODES AND KEEPS NONE OF THEM ───────────────────────────────────
 *
 * Creation and reissue each answer with a raw claim code, generated fresh from the
 * browser's CSPRNG for that one response. The mock stores no plaintext and no hash,
 * because nothing here ever verifies a redemption — and a credential lying in a
 * fixture map is exactly the shape of thing production code could one day read by
 * accident. What it DOES keep is the canonical projection: the invitation's id, its
 * window and its status, which is all the real read publishes too.
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

    const source = lever === 'empty' ? [] : this.rows();
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

    const found = this.findDetail(id);
    if (!found) {
      // The endpoint's own body, verbatim: `{status, message}`, not `{detail}`.
      return throwError(
        () => new MockHttpError(404, { status: 404, message: 'Restaurant not found.' }),
      ).pipe(delay(LATENCY_MS));
    }
    return this.ok(this.projectDetail(found));
  }

  /**
   * The directory corpus: the fixtures plus every restaurant CREATED this session, in
   * the endpoint's own `('name', 'id')` order. A created tenant is a ROW here and a
   * DETAIL in the workspace, projected from ONE record exactly as the server projects
   * both reads from one queryset — so `npm start` cannot show a restaurant that exists
   * in one place and not the other. The row is projected DOWN from the detail, never
   * the detail up from the row: the directory contract carries no onboarding, owner or
   * activity, and must not gain them by accident.
   */
  private rows(): readonly RestaurantRow[] {
    if (this.created.size === 0) return MOCK_RESTAURANT_ROWS;
    return [...MOCK_RESTAURANT_ROWS, ...[...this.created.values()].map(toRow)].sort(compareRows);
  }

  private findDetail(id: string): RestaurantDetail | undefined {
    return this.created.get(id) ?? MOCK_RESTAURANT_DETAILS.get(id);
  }

  /**
   * One restaurant's canonical detail with every overlay a write has produced this
   * session applied ON THE READ PATH — commercial state, the onboarding projection, and
   * the owner-claim compatibility aliases the backend derives from it. Nothing is
   * cached: this is the read fetching current state, exactly as the deployed one does.
   */
  private projectDetail(found: RestaurantDetail): RestaurantDetail {
    const onboarding = this.onboardingFor(found.id, found.onboarding);
    return {
      ...found,
      commercial: this.commercialFor(found.id, found.commercial),
      onboarding,
      owner: found.owner === null ? null : withClaimAliases(found.owner, onboarding),
    };
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
    const found = this.findDetail(restaurantId);
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

  // --- subscription-terms writes (Step 3E.3) ------------------------------------
  //
  // THREE OPERATIONS, THE SERVER'S OWN RULES IN THE SERVER'S OWN ORDER. Shape first,
  // then the clock, then the state — because a malformed body is refused before its
  // concurrency assertion is considered, and an exact retry succeeds even when that
  // assertion has gone stale.
  //
  // IT KEEPS A HISTORY, NOT JUST THE CURRENT ROW, and that is what makes the retry and
  // timeline rules reviewable at all: `record` refuses terms beginning before the last
  // closure, `replace` recognises a completed replacement by the OLD row's `ended_at`,
  // and `end` distinguishes "already ended" from "already ended and something new has
  // since opened". None of those questions can be answered from `current` alone.

  recordSubscriptionTerms(
    restaurantId: string,
    request: RecordSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    const context = this.termsContext(restaurantId);
    if (!context.ok) return context.error;

    const fields = this.normaliseTerms(request);
    if ('invalid' in fields) return fields.invalid;
    const reason = this.checkReason(request.reason);
    if (reason) return reason;

    const future = this.refuseFuture(fields.effective_from, 'effective_from');
    if (future) return future;

    const { commercial, history } = context;
    const open = history.find((row) => row.ended_at === null) ?? null;
    // Read ONCE, after validation and before any state check, so every path disarms it
    // exactly once — a lever left armed by a refusal would fire on an unrelated write.
    const forced = this.consumeStaleLever();

    if (open !== null) {
      // AN EXACT RETRY IS A SUCCESSFUL NO-OP — every commercial fact AND the boundary
      // equal to the open row. The lever deliberately does NOT override it: an exact
      // retry succeeds even when the world has moved, which is the property that keeps a
      // lost response from becoming a false conflict.
      if (this.sameFacts(open, fields) && open.effective_from === fields.effective_from) {
        return this.ok({ changed: false, commercial });
      }
      return this.conflict(
        'subscription_terms_already_open',
        'This restaurant already has different open subscription terms.',
      );
    }

    // THE MONOTONIC TIMELINE. New terms may not begin before the previous set closed,
    // or "which terms were in force on the 20th?" would have two answers.
    const latestEnd = this.latestEnd(history);
    if (latestEnd !== null && fields.effective_from < latestEnd) {
      return this.invalid({
        effective_from: [
          'These terms would begin before the previous terms ended, leaving two overlapping sets in force.',
        ],
      });
    }

    if (forced) {
      return this.conflict(
        'subscription_terms_already_open',
        'This restaurant already has different open subscription terms.',
      );
    }

    const recorded: MockTermsRow = {
      id: this.nextTermsId(),
      ...fields,
      recorded_at: new Date().toISOString(),
      ended_at: null,
    };
    return this.commitTerms(restaurantId, commercial, [...history, recorded], recorded);
  }

  replaceSubscriptionTerms(
    restaurantId: string,
    request: ReplaceSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    const context = this.termsContext(restaurantId);
    if (!context.ok) return context.error;

    const fields = this.normaliseTerms(request);
    if ('invalid' in fields) return fields.invalid;
    const reason = this.checkReason(request.reason);
    if (reason) return reason;

    const future = this.refuseFuture(fields.effective_from, 'effective_from');
    if (future) return future;

    const { commercial, history } = context;
    const forced = this.consumeStaleLever();
    const expected = history.find((row) => row.id === request.expected_terms_id) ?? null;
    // 409 rather than 404, exactly as the endpoint maps it: this route's target is the
    // RESTAURANT, so an id that no longer resolves means the caller's view is stale —
    // and an id belonging to another tenant is answered identically, so the response
    // cannot be used to probe for other restaurants' terms.
    if (expected === null) {
      return this.conflict(
        'subscription_terms_not_found',
        'Subscription terms changed since they were loaded.',
      );
    }

    const open = history.find((row) => row.ended_at === null) ?? null;
    if (open === null) {
      return this.conflict(
        'no_open_subscription_terms',
        'This restaurant has no open subscription terms.',
      );
    }

    if (open.id !== expected.id) {
      // THE EXACT-RETRY PROOF, and it is deliberately narrow: the named row is ended AT
      // the requested boundary, the open row began at that same instant, and its facts
      // are the requested ones. Anything weaker — "some open row happens to have this
      // amount" — would let a genuinely stale caller believe their change landed when
      // it was somebody else's.
      const alreadyDone =
        expected.ended_at === fields.effective_from &&
        open.effective_from === fields.effective_from &&
        this.sameFacts(open, fields);
      // The lever never overrides an exact retry, for the same reason it never overrides
      // a no-op above.
      if (alreadyDone) return this.ok({ changed: false, commercial });
      return this.conflict(
        'stale_subscription_terms',
        'Subscription terms changed since they were loaded.',
      );
    }

    if (forced) {
      return this.conflict(
        'stale_subscription_terms',
        'Subscription terms changed since they were loaded.',
      );
    }

    // UNCHANGED FACTS ARE A NO-OP, compared WITHOUT `effective_from`. Writing a
    // historical row purely to re-date unchanged terms would fabricate a change that
    // never happened; re-dating a current record is a separate correction the domain
    // deliberately does not offer.
    if (this.sameFacts(open, fields)) {
      return this.ok({ changed: false, commercial });
    }

    if (fields.effective_from < open.effective_from) {
      return this.invalid({
        effective_from: ['Replacement terms cannot take effect before the terms they replace.'],
      });
    }

    // CLOSE THEN INSERT, at exactly the same instant — no gap in which the restaurant
    // had no terms and no overlap in which it had two.
    const replacement: MockTermsRow = {
      id: this.nextTermsId(),
      ...fields,
      recorded_at: new Date().toISOString(),
      ended_at: null,
    };
    const next = history.map((row) =>
      row.id === open.id ? { ...row, ended_at: fields.effective_from } : row,
    );
    return this.commitTerms(restaurantId, commercial, [...next, replacement], replacement);
  }

  endSubscriptionTerms(
    restaurantId: string,
    request: EndSubscriptionTermsRequest,
  ): Observable<CommercialMutationResult> {
    const context = this.termsContext(restaurantId);
    if (!context.ok) return context.error;

    const endedAt = this.normaliseMoment(request.ended_at, 'ended_at');
    if (typeof endedAt !== 'string') return endedAt.invalid;
    const reason = this.checkReason(request.reason);
    if (reason) return reason;

    const future = this.refuseFuture(endedAt, 'ended_at');
    if (future) return future;

    const { commercial, history } = context;
    const forced = this.consumeStaleLever();
    const expected = history.find((row) => row.id === request.expected_terms_id) ?? null;
    if (expected === null) {
      return this.conflict(
        'subscription_terms_not_found',
        'Subscription terms changed since they were loaded.',
      );
    }

    const open = history.find((row) => row.ended_at === null) ?? null;

    // THE RETRY CHECK COMES BEFORE THE OPEN-ROW REQUIREMENT, and must: after a
    // successful end there is no open row at all, so asking "is this the open row?"
    // first would refuse a resend of the request that just succeeded.
    //
    // BUT IT IS CONDITIONAL ON NOTHING HAVING OPENED SINCE. If another operator recorded
    // fresh terms after the end, "already done" would report success for an operation
    // whose stated postcondition — this restaurant now has no open terms — is no longer
    // true, and would slip past the token entirely.
    if (expected.ended_at !== null && expected.ended_at === endedAt) {
      if (open === null) return this.ok({ changed: false, commercial });
      // The ENDPOINT'S curated sentence, not the domain's. `domain_error_body` replaces
      // every 409 message with one of four fixed strings — the domain's names the row
      // that is actually open, which a conflict response must never disclose.
      return this.conflict(
        'stale_subscription_terms',
        'Subscription terms changed since they were loaded.',
      );
    }

    if (open === null) {
      return this.conflict(
        'no_open_subscription_terms',
        'This restaurant has no open subscription terms.',
      );
    }
    if (open.id !== expected.id || forced) {
      return this.conflict(
        'stale_subscription_terms',
        'Subscription terms changed since they were loaded.',
      );
    }
    if (endedAt < open.effective_from) {
      return this.invalid({ ended_at: ['Terms cannot end before they took effect.'] });
    }

    const next = history.map((row) => (row.id === open.id ? { ...row, ended_at: endedAt } : row));
    return this.commitTerms(restaurantId, commercial, next, null);
  }


  // --- restaurant creation (Step 2G, backend Step 2D) ---------------------------
  //
  // THE SERVER'S OWN RULES IN THE SERVER'S OWN ORDER: the request contract first (every
  // field problem reported at once, nested as DRF nests them), then the domain's own
  // refusals (a phone that cannot be canonicalised, an email that is not one), then the
  // owner conflicts, then the duplicate-restaurant conflict — and only then the six-row
  // commit. A collision NEVER becomes a silent reuse: the phone conflict names the
  // existing account's UUID and nothing else, and it is the PAGE's job to turn that into
  // a deliberate `mode: "existing"` request, exactly as against the real endpoint.

  createRestaurant(request: CreateRestaurantRequest): Observable<RestaurantCreationResult> {
    const errors = creationErrors(request);
    if (errors !== null) {
      return this.throwLater(400, {
        status: 400,
        message: 'The restaurant could not be created.',
        errors,
      });
    }

    const name = collapse(request.restaurant.name);
    const location = collapse(request.restaurant.location);
    const spec = request.owner;

    let account: MockOwnerAccount;
    let ownerCreated: boolean;
    if (spec.mode === 'new') {
      // `normalise_msisdn` is the domain's, and its refusal is a DOMAIN 400 attributed
      // to the field it names — the same nested shape as a serializer refusal, so one
      // field never has two error shapes depending on which layer refused it.
      const phone = normaliseMsisdn(spec.phone_number);
      if (typeof phone !== 'string') {
        return this.domainInvalid('invalid_owner_phone', ['owner', 'phone_number'], phone.error);
      }
      const email = normaliseEmail(spec.email);
      if (email !== null && !EMAIL_SHAPE.test(email)) {
        return this.domainInvalid('invalid_owner_email', ['owner', 'email'], 'Enter a valid email address.');
      }

      // A PHONE ALREADY IN USE IS A CONFLICT, NEVER A REUSE. The body carries the
      // existing account's UUID — the one fact that lets an operator look it up with
      // the reads they already have — and no name, phone or email.
      const clash = this.ownerAccounts.find((known) => known.phone_number === phone);
      if (clash) {
        return this.conflict(
          'owner_account_already_exists',
          'An account already uses that phone number. Review it and, if it is the intended owner, create the restaurant with that account instead.',
          { owner_user_id: clash.id },
        );
      }
      // The EMAIL conflict deliberately names no account: pointing at one would invite
      // exactly the "email identifies the owner" inference the contract refuses.
      if (email !== null && this.ownerAccounts.some((known) => known.email?.toLowerCase() === email)) {
        return this.conflict(
          'owner_email_already_in_use',
          'Another account already uses that email address.',
        );
      }
      account = {
        id: this.nextOwnerId(),
        // `.strip().title()` — the repository's convention for a person's name.
        name: `${titleCase(collapse(spec.first_name))} ${titleCase(collapse(spec.last_name))}`,
        email,
        phone_number: phone,
        is_active: true,
      };
      ownerCreated = true;
    } else {
      const userId = spec.user_id.trim().toLowerCase();
      const found = this.ownerAccounts.find((known) => known.id.toLowerCase() === userId) ?? null;
      // 409, NOT 404: the caller is an authenticated administrator who named that UUID,
      // and a 404 on this route would say the wrong thing was missing.
      if (found === null) {
        return this.conflict(
          'owner_account_not_found',
          'No account with that id. Check the owner account id and try again.',
          { owner_user_id: userId },
        );
      }
      // AN EXISTING OWNER IS NEVER MODIFIED OR REACTIVATED — reactivating somebody's
      // account is a separate decision with its own actor and reason.
      if (!found.is_active) {
        return this.conflict(
          'owner_account_inactive',
          'That account is deactivated. Reactivating it is a separate decision; this request did not make it.',
          { owner_user_id: found.id },
        );
      }
      account = found;
      ownerCreated = false;
    }

    // ANY OWNER, case-insensitively, among non-deleted restaurants — the strongest
    // truthful duplicate statement the platform makes. Creation is not adoption: a
    // duplicate is REFUSED, never answered by handing back what somebody else created.
    const duplicate =
      [...this.created.values(), ...MOCK_RESTAURANT_DETAILS.values()].find(
        (record) =>
          record.name.toLowerCase() === name.toLowerCase() &&
          (record.location ?? '').toLowerCase() === location.toLowerCase(),
      ) ?? null;
    if (duplicate !== null) {
      return this.conflict(
        'restaurant_already_exists',
        'A restaurant with that name and location already exists.',
        { restaurant_id: duplicate.id },
      );
    }

    const lever = consumeLever(CREATE_LEVER_KEY, CREATE_LEVER_VALUES);
    if (lever === 'down') return this.fail();

    // THE COMMIT. One captured instant for the tenant, its provenance and its
    // credential's window, exactly as the service captures one `now`.
    const now = new Date();
    const nowIso = now.toISOString();
    const restaurantId = this.nextRestaurantId();
    const invitation = this.mintInvitation(now);
    const onboarding: OnboardingSummary = {
      tracked: true,
      source: 'admin_created',
      recorded_at: nowIso,
      owner_relationship: { status: 'consistent' },
      // CREATION DOES NOT ESTABLISH OWNER CONTROL. The invitation is issued, not
      // redeemed, and nothing here may say otherwise.
      owner_control: { status: 'not_established', evidence: null, evidence_at: null },
      invitation: invitation.projection,
    };
    const record: RestaurantDetail = {
      id: restaurantId,
      commercial: UNCONFIGURED_COMMERCIAL,
      name,
      location,
      // RESTAURANT STARTS `onboarding`, and cannot go live: the readiness seam fails
      // closed, so the newborn tenant needs attention from its first second.
      status: 'onboarding',
      is_test: request.restaurant.is_test,
      readiness: { state: 'not_ready', blocker_count: 1, blockers: [BLOCKER_READINESS_NOT_CONFIGURED] },
      subscription: {
        source: 'legacy_restaurant_fields',
        has_commercial_subscription: false,
        legacy_validity_flag: true,
        legacy_expiry_at: null,
        preferred_method: 'per_order',
      },
      payment_mode: null,
      payment_mode_configured: false,
      last_activity_at: nowIso,
      needs_attention: true,
      allowed_transitions: ['live', 'offboarded'],
      created_at: nowIso,
      owner: withClaimAliases({ ...account, claim_tracked: true, claim_status: null }, onboarding),
      onboarding,
      support: { open_issue_count: 0 },
      operations: {
        table_count: 0,
        usable_table_count: 0,
        dining_area_count: 0,
        latest_order: null,
      },
      // The one audit row creation writes, as the activity strip will show it.
      recent_activity: [
        {
          id: this.nextActivityId(),
          timestamp: nowIso,
          action: 'admin.restaurant.created',
          result: 'success',
          actor: MOCK_ACTOR,
        },
      ],
    };
    this.created.set(restaurantId, record);
    if (ownerCreated) this.ownerAccounts.push(account);

    // 'lost': the six rows are committed and the response carrying the claim code is
    // not delivered. Exactly the case the service documents as unrecoverable by design
    // — the remedy is a reissue from the workspace, never plaintext recovery.
    if (lever === 'lost') return this.fail();

    const result: RestaurantCreationResult = {
      restaurant: record,
      owner_account: { id: account.id, created: ownerCreated },
      owner_invitation: { ...invitation.issued, claim_token: mintClaimToken() },
    };
    return this.ok(result);
  }

  // --- owner invitation (Step 2G, backend Step 2E) -------------------------------
  //
  // TWO OPERATIONS, THE SERVER'S OWN ORDER: the target is resolved BEFORE the body is
  // read (so a bad body cannot become an existence oracle), then the request contract,
  // then the head is resolved and the concurrency token asserted against it, then each
  // operation's own preconditions against the state as found. `reissue`, never
  // `resend`: nothing is delivered, here or on the server.

  reissueOwnerInvitation(
    restaurantId: string,
    request: OwnerInvitationRequest,
  ): Observable<OwnerInvitationReissueResult> {
    const context = this.invitationContext(restaurantId, request);
    if (!context.ok) return context.error;
    const { found, onboarding } = context;

    // The refusal asks whether the CURRENT owner's control is established — the same
    // evidence rule the read publishes — never whether some invitation was ever consumed.
    if (onboarding.owner_control.status === 'invitation_redeemed') {
      return this.conflict(
        'owner_control_already_established',
        "This restaurant's owner has already claimed it.",
      );
    }
    // It ALWAYS binds to the current canonical owner, who must exist and be usable…
    if (found.owner === null) {
      return this.conflict(
        'owner_account_not_found',
        'This restaurant has no usable owner account to invite.',
      );
    }
    if (!found.owner.is_active) {
      return this.conflict('owner_account_inactive', 'The owner account is deactivated.');
    }
    // …and the two answers to "who owns this?" must agree before authority is minted.
    // Validates, never repairs: the drift is left exactly as it was.
    if (onboarding.owner_relationship.status !== 'consistent') {
      return this.conflict(onboarding.owner_relationship.status, OWNER_CONSISTENCY_MESSAGE);
    }

    const lever = consumeLever(INVITATION_LEVER_KEY, INVITATION_LEVER_VALUES);
    if (lever === 'stale') return this.conflict('stale_owner_invitation', STALE_INVITATION_MESSAGE);
    if (lever === 'down') return this.fail();

    // ROTATION: the unresolved head (if any) is superseded and a fresh credential is
    // minted for the current owner with a fresh window. A cancelled or consumed head is
    // left exactly as it was — history is evidence. The read only ever publishes the
    // head, so the projection simply moves to the new pending invitation.
    const minted = this.mintInvitation(new Date());
    const next: OnboardingSummary = { ...onboarding, invitation: minted.projection };
    this.onboardingWritten.set(found.id, next);

    // 'lost': rotated, and the only response that would ever carry the new code is
    // gone. The canonical read now shows a head nobody has seen; reissue again.
    if (lever === 'lost') return this.fail();

    const result: OwnerInvitationReissueResult = {
      changed: true,
      onboarding: next,
      owner_invitation: { ...minted.issued, claim_token: mintClaimToken() },
    };
    return this.ok(result);
  }

  cancelOwnerInvitation(
    restaurantId: string,
    request: OwnerInvitationRequest,
  ): Observable<OwnerInvitationCancelResult> {
    const context = this.invitationContext(restaurantId, request);
    if (!context.ok) return context.error;
    const { found, onboarding, head } = context;

    // THE EXACT RETRY: already cancelled, nothing written, `changed: false`. The lever
    // is consumed and never overrides it — an exact retry succeeds whatever the lever
    // says, because that is what the server does.
    if (head.status === 'cancelled') {
      consumeLever(INVITATION_LEVER_KEY, INVITATION_LEVER_VALUES);
      return this.ok<OwnerInvitationCancelResult>({ changed: false, onboarding });
    }
    // Consumed or superseded: terminal, and neither is a cancellation.
    if (head.status === 'consumed' || head.status === 'superseded') {
      return this.conflict(
        'owner_invitation_already_resolved',
        'This owner invitation has already resolved and cannot be cancelled.',
      );
    }

    const lever = consumeLever(INVITATION_LEVER_KEY, INVITATION_LEVER_VALUES);
    if (lever === 'stale') return this.conflict('stale_owner_invitation', STALE_INVITATION_MESSAGE);
    if (lever === 'down') return this.fail();

    // Pending, expired or verification-locked — all unresolved, all cancellable. Two
    // columns and nothing else: the id and the window are unchanged, no replacement is
    // minted, and the owner account is untouched.
    const next: OnboardingSummary = { ...onboarding, invitation: { ...head, status: 'cancelled' } };
    this.onboardingWritten.set(found.id, next);
    if (lever === 'lost') return this.fail();
    return this.ok<OwnerInvitationCancelResult>({ changed: true, onboarding: next });
  }

  /**
   * Everything both invitation writes need, or the refusal they get instead — in the
   * endpoint's order: 404 for a missing target, 400 for a malformed body, then the four
   * head-resolution conflicts shared by reissue and cancel. `expected_invitation_id`
   * asserts IDENTITY, not status: it must name the head the read currently presents,
   * and a numeric token is a 400, never manufactured into a 409.
   */
  private invitationContext(
    restaurantId: string,
    request: OwnerInvitationRequest,
  ): MockInvitationContext {
    const found = this.findDetail(restaurantId);
    if (!found) {
      return {
        ok: false,
        error: this.throwLater(404, { status: 404, message: 'Restaurant not found.' }),
      };
    }

    const errors: Record<string, readonly string[]> = {};
    const expected: unknown = request.expected_invitation_id;
    if (typeof expected !== 'string') {
      errors['expected_invitation_id'] = ['Send the invitation id as a UUID string.'];
    } else if (!isUuid(expected)) {
      errors['expected_invitation_id'] = ['Enter a valid UUID.'];
    }
    const reason = String(request.reason ?? '').trim();
    if (!reason) errors['reason'] = ['This field may not be blank.'];
    else if (reason.length < MIN_REASON_LENGTH) {
      errors['reason'] = [`Please state a reason of at least ${MIN_REASON_LENGTH} characters.`];
    }
    if (Object.keys(errors).length > 0) return { ok: false, error: this.invalid(errors) };

    const onboarding = this.onboardingFor(found.id, found.onboarding);
    if (!onboarding.tracked) {
      return {
        ok: false,
        error: this.conflict(
          'onboarding_not_tracked',
          'This restaurant is not represented in the Admin onboarding domain.',
        ),
      };
    }
    // Provenance is never converted: a legacy adoption has no invitation, ever.
    if (onboarding.source !== 'admin_created') {
      return {
        ok: false,
        error: this.conflict(
          'owner_invitation_not_applicable',
          'This restaurant did not enter Dinify through a claim flow, so it has no owner invitation.',
        ),
      };
    }
    const head = onboarding.invitation;
    if (head.id === null) {
      return {
        ok: false,
        error: this.conflict('owner_invitation_not_issued', 'This restaurant has no owner invitation.'),
      };
    }
    if (head.id.toLowerCase() !== (expected as string).trim().toLowerCase()) {
      return { ok: false, error: this.conflict('stale_owner_invitation', STALE_INVITATION_MESSAGE) };
    }
    return { ok: true, found, onboarding, head: { ...head, id: head.id } };
  }

  /**
   * One credential's PROJECTION and its ISSUED shape, from one captured instant:
   * `issued_at = now`, `expires_at = now + TTL`, status pending. The raw code is NOT
   * minted here — it is minted by the caller, for the one response that carries it,
   * so this helper can never be the thing that leaves a credential in a field.
   */
  private mintInvitation(now: Date): {
    readonly projection: OwnerInvitationProjection;
    readonly issued: { readonly id: string; readonly issued_at: string; readonly expires_at: string };
  } {
    const issued = {
      id: this.nextInvitationId(),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + MOCK_OWNER_INVITATION_TTL_MS).toISOString(),
    };
    return { projection: { status: 'pending', ...issued }, issued };
  }

  private onboardingFor(id: string, fallback: OnboardingSummary): OnboardingSummary {
    return this.onboardingWritten.get(id) ?? fallback;
  }

  /** The domain's field-attributed 400 for creation, nested the way DRF nests it. */
  private domainInvalid<T>(code: string, path: readonly string[], message: string): Observable<T> {
    const errors: Record<string, unknown> = {};
    let cursor = errors;
    path.slice(0, -1).forEach((segment) => {
      const nested: Record<string, unknown> = {};
      cursor[segment] = nested;
      cursor = nested;
    });
    cursor[path[path.length - 1]] = [message];
    return this.throwLater(400, {
      status: 400,
      message: 'The restaurant could not be created.',
      code,
      errors,
    });
  }

  /**
   * Minted ids carry a leading `f` in their last group, and every seeded id in the
   * fixtures carries a leading `0` there — so a minted handle can never collide with a
   * seeded one, however many are minted in a session.
   */
  private nextRestaurantId(): string {
    this.createdSequence += 1;
    return `9a7f1cf0-4b2e-4f3a-9c1d-f${String(this.createdSequence).padStart(11, '0')}`;
  }

  private nextOwnerId(): string {
    this.ownerSequence += 1;
    return `1f2e3d4c-5b6a-4978-8899-f${String(this.ownerSequence).padStart(11, '0')}`;
  }

  private nextInvitationId(): string {
    this.invitationSequence += 1;
    return `4d5e6f70-8192-4a3b-9c4d-f${String(this.invitationSequence).padStart(11, '0')}`;
  }

  private nextActivityId(): string {
    this.activitySequence += 1;
    return `3b4c5d6e-7f80-4192-a3b4-f${String(this.activitySequence).padStart(11, '0')}`;
  }

  private createdSequence = 0;
  private ownerSequence = 0;
  private invitationSequence = 0;
  private activitySequence = 0;

  /** Restaurants created this session, keyed by id. Fixtures themselves stay immutable. */
  private readonly created = new Map<string, RestaurantDetail>();

  /** The invitation lifecycle's overlay on the onboarding projection, per restaurant. */
  private readonly onboardingWritten = new Map<string, OnboardingSummary>();

  /**
   * Every owner account the mock knows — the fixtures' owners plus the ones creation
   * minted this session — so a phone collision is judged against exactly the accounts
   * a reviewer can see, and a second creation naming a just-created phone collides too.
   */
  private readonly ownerAccounts: MockOwnerAccount[] = [...MOCK_OWNER_ACCOUNTS];

  // --- the terms rules, one implementation each ---------------------------------

  /**
   * The restaurant's commercial state and terms history, or a 404.
   *
   * The history is seeded from the fixture's `current` row the first time a restaurant
   * is written to. The fixture knows nothing of ended rows, so a seeded history has no
   * closures in it — which is truthful rather than convenient: `npm start` starts from
   * "whatever the read says is open", and everything before that is genuinely unknown.
   */
  private termsContext(restaurantId: string): MockTermsContext {
    const found = this.findDetail(restaurantId);
    if (!found) {
      return {
        ok: false,
        error: this.throwLater(404, { status: 404, message: 'Restaurant not found.' }),
      };
    }
    const commercial = this.commercialFor(restaurantId, found.commercial);
    return { ok: true, commercial, history: this.historyFor(restaurantId, commercial) };
  }

  private historyFor(restaurantId: string, commercial: CommercialSummary): readonly MockTermsRow[] {
    const stored = this.termsHistory.get(restaurantId);
    if (stored) return stored;
    const current = commercial.subscription_terms.current;
    if (current === null) return [];
    // THE SEED'S BOUNDARY IS NORMALISED, and that is not tidiness. The fixture spells it
    // `+03:00` while every written row is normalised to `Z`, and the exact-retry proofs
    // below compare boundaries as STRINGS — so a retry against seeded terms would never
    // match its own instant, and would come back as a conflict that never happened.
    // Ordering comparisons are lexicographic for the same reason and need one spelling.
    return [{ ...current, effective_from: toInstant(current.effective_from), ended_at: null }];
  }

  /**
   * Persist the new history and rebuild the canonical projection from it.
   *
   * `configured` is DERIVED from whether an open row exists, exactly as the backend
   * derives it — never written beside the row where the two could disagree.
   */
  private commitTerms(
    restaurantId: string,
    commercial: CommercialSummary,
    history: readonly MockTermsRow[],
    current: MockTermsRow | null,
  ): Observable<CommercialMutationResult> {
    const next: CommercialSummary = {
      ...commercial,
      subscription_terms: {
        configured: current !== null,
        current: current === null ? null : project(current),
      },
    };
    this.termsHistory.set(restaurantId, history);
    this.written.set(restaurantId, next);
    return this.ok({ changed: true, commercial: next });
  }

  /** The most recent closure across the whole history, or null. */
  private latestEnd(history: readonly MockTermsRow[]): string | null {
    return history.reduce<string | null>(
      (latest, row) =>
        row.ended_at !== null && (latest === null || row.ended_at > latest) ? row.ended_at : latest,
      null,
    );
  }

  /** The FOUR commercial facts, deliberately excluding `effective_from`. */
  private sameFacts(row: MockTermsRow, fields: MockTermsFields): boolean {
    return (
      row.recurring_amount === fields.recurring_amount &&
      row.currency === fields.currency &&
      row.billing_interval.unit === fields.billing_interval.unit &&
      row.billing_interval.count === fields.billing_interval.count
    );
  }

  /**
   * `_normalise_terms_input`, in the same order and with the same refusals.
   *
   * The amount is checked as a STRING and quantised textually — `Decimal` semantics
   * without a float anywhere. A JSON number is refused outright, because that is the
   * exact round trip the backend's `StrictDecimalStringField` exists to prevent.
   */
  private normaliseTerms(
    request: RecordSubscriptionTermsRequest,
  ): MockTermsFields | { invalid: Observable<CommercialMutationResult> } {
    const amount = normaliseAmount(request.recurring_amount);
    if (amount === null) {
      return {
        invalid: this.invalid({
          recurring_amount: [
            'Enter a non-negative amount with at most two decimal places, as a string.',
          ],
        }),
      };
    }

    const currency = String(request.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return {
        invalid: this.invalid({
          currency: ['currency must be a three-letter alphabetic code, e.g. UGX.'],
        }),
      };
    }

    if (!INTERVAL_UNITS.includes(request.billing_interval_unit)) {
      return {
        invalid: this.invalid({
          billing_interval_unit: [
            `billing_interval_unit must be one of: ${INTERVAL_UNITS.join(', ')}.`,
          ],
        }),
      };
    }

    const count = request.billing_interval_count;
    if (!Number.isInteger(count) || count < 1) {
      return {
        invalid: this.invalid({
          billing_interval_count: ['billing_interval_count must be a whole number of at least 1.'],
        }),
      };
    }

    const effectiveFrom = this.normaliseMoment(request.effective_from, 'effective_from');
    if (typeof effectiveFrom !== 'string') return { invalid: effectiveFrom.invalid };

    return {
      recurring_amount: amount,
      currency,
      billing_interval: { unit: request.billing_interval_unit, count },
      effective_from: effectiveFrom,
    };
  }

  /**
   * An ISO instant carrying an EXPLICIT offset, normalised to UTC so two spellings of
   * one moment compare equal.
   *
   * A NAIVE value is refused rather than assumed to be anything — the difference between
   * midnight EAT and midnight UTC is three hours of "which terms were in force", and an
   * operator in another timezone would never see the substitution happen.
   */
  private normaliseMoment(
    raw: string,
    field: string,
  ): string | { invalid: Observable<CommercialMutationResult> } {
    const value = String(raw ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
      return {
        invalid: this.invalid({
          [field]: [
            'Include an explicit timezone offset, e.g. 2026-08-24T12:00:00Z or 2026-08-24T15:00:00+03:00.',
          ],
        }),
      };
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return {
        invalid: this.invalid({
          [field]: ['Enter a valid ISO-8601 datetime, e.g. 2026-08-24T12:00:00Z.'],
        }),
      };
    }
    return new Date(parsed).toISOString();
  }

  /** `_refuse_future`: this domain records terms already in effect, never schedules. */
  private refuseFuture(moment: string, field: string): Observable<CommercialMutationResult> | null {
    if (Date.parse(moment) <= Date.now()) return null;
    return this.throwLater(400, {
      status: 400,
      message: 'The request could not be applied.',
      code: 'future_effective_terms_not_supported',
      errors: {
        [field]: [
          `${field} may not be in the future: this domain records terms that are already in effect and does not schedule future changes.`,
        ],
      },
    });
  }

  /** `trim_whitespace=True`, then `allow_blank=False`, then the house minimum. */
  private checkReason(raw: string): Observable<CommercialMutationResult> | null {
    const reason = String(raw ?? '').trim();
    if (!reason) return this.invalid({ reason: ['This field may not be blank.'] });
    if (reason.length < MIN_REASON_LENGTH) {
      return this.invalid({
        reason: [`Please state a reason of at least ${MIN_REASON_LENGTH} characters.`],
      });
    }
    return null;
  }

  /**
   * The 409 body shape the endpoints answer with — a sentence and a code. `details`
   * exists for the creation conflicts that carry a UUID (the existing owner account,
   * the duplicate restaurant) and for nothing else; the invitation and commercial
   * conflicts never name a row.
   */
  private conflict<T = never>(
    code: string,
    message: string,
    details?: Record<string, string>,
  ): Observable<T> {
    return this.throwLater(409, {
      status: 409,
      message,
      code,
      ...(details === undefined ? {} : { details }),
    });
  }

  /** Sequential, so a review session can see which row is which. */
  private nextTermsId(): string {
    this.termsSequence += 1;
    return `00000000-0000-4000-8000-${String(this.termsSequence).padStart(12, '0')}`;
  }

  private termsSequence = 0;
  private readonly termsHistory = new Map<string, readonly MockTermsRow[]>();

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

/**
 * A terms row as the MOCK stores it: the projected shape plus the terminal stamp.
 *
 * `ended_at` is the whole reason a history exists. It is deliberately NOT part of
 * `CommercialSubscriptionTerms` — the canonical read only ever publishes the OPEN row,
 * and a client that could see closures would start reasoning about a timeline the API
 * does not give it.
 */
interface MockTermsRow extends CommercialSubscriptionTerms {
  readonly ended_at: string | null;
}

/** Everything an invitation write needs about one restaurant, or the refusal it gets instead. */
type MockInvitationContext =
  | {
      readonly ok: true;
      readonly found: RestaurantDetail;
      readonly onboarding: OnboardingSummary;
      /** The head, with its id narrowed to the string the concurrency token matched. */
      readonly head: OwnerInvitationProjection & { readonly id: string };
    }
  | { readonly ok: false; readonly error: Observable<never> };

/** Everything a terms write needs about one restaurant, or the 404 it gets instead. */
type MockTermsContext =
  | {
      readonly ok: true;
      readonly commercial: CommercialSummary;
      readonly history: readonly MockTermsRow[];
    }
  | { readonly ok: false; readonly error: Observable<CommercialMutationResult> };

/** The five facts a write states, before any row exists to carry them. */
interface MockTermsFields {
  readonly recurring_amount: string;
  readonly currency: string;
  readonly billing_interval: CommercialSubscriptionTerms['billing_interval'];
  readonly effective_from: string;
}

/**
 * One spelling for every stored moment.
 *
 * The comparisons in this file are string equality and lexicographic ordering — which is
 * sound for ISO instants only while they all carry the SAME offset. Normalising on the
 * way in is what makes that true; comparing `2026-08-01T00:00:00+03:00` against
 * `2026-08-01T00:00:00.000Z` is not the same question as comparing the two instants.
 */
function toInstant(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toISOString();
}

/** The projected row, without the mock's private terminal stamp. */
function project(row: MockTermsRow): CommercialSubscriptionTerms {
  return {
    id: row.id,
    recurring_amount: row.recurring_amount,
    currency: row.currency,
    billing_interval: row.billing_interval,
    effective_from: row.effective_from,
    recorded_at: row.recorded_at,
  };
}

/**
 * `_normalise_amount`, TEXTUALLY — the exact stored scale, with no float anywhere.
 *
 * Returns the canonical two-decimal spelling so a stored amount and a freshly stated
 * one compare identically, which is what every no-op and retry proof here depends on.
 * Null means refused: a non-string, a negative, a non-numeric, or more precision than
 * the column can hold. MORE PRECISION IS REFUSED, NEVER ROUNDED — silently storing
 * 1000.005 as 1000.01 changes a price the operator stated.
 */
function normaliseAmount(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  // `.5` is a legitimate `Decimal` to the server, so it is legitimate here — a fixture
  // stricter than the thing it stands in for teaches a reviewer a rule that is not real.
  const match = /^(\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const [, whole, fraction] = match;
  if (!whole && fraction === undefined) return null;
  const digits = (whole || '0').replace(/^0+(?=\d)/, '');
  return `${digits}.${(fraction ?? '').padEnd(2, '0')}`;
}


/**
 * `CreateRestaurantRequestSerializer`, field for field: every problem reported at once
 * and nested the way DRF nests them, so the page's field errors land beside the field
 * they name. The owner block is judged by the keys the caller SENT, exactly as the
 * server's `to_internal_value` captures them — a forbidden key with a blank value is
 * still a claim the caller made, and is refused as one.
 */
function creationErrors(request: CreateRestaurantRequest): Record<string, unknown> | null {
  const errors: Record<string, unknown> = {};

  const facts: Partial<CreateRestaurantRequest['restaurant']> = request.restaurant ?? {};
  const restaurant: Record<string, readonly string[]> = {};
  if (!collapse(facts.name)) restaurant['name'] = ['This field may not be blank.'];
  if (!collapse(facts.location)) restaurant['location'] = ['This field may not be blank.'];
  // `StrictBooleanField`: `1`, `"true"`, `"yes"` and `null` are all refused. The test
  // classification is decided by an operator saying so, never by a coercion table.
  if (typeof facts.is_test !== 'boolean') restaurant['is_test'] = ['Send true or false.'];
  if (Object.keys(restaurant).length > 0) errors['restaurant'] = restaurant;

  const spec: Record<string, unknown> = { ...(request.owner ?? {}) };
  const owner: Record<string, readonly string[]> = {};
  const mode = spec['mode'];
  if (mode !== 'new' && mode !== 'existing') {
    owner['mode'] = [`"${String(mode)}" is not a valid choice.`];
  } else {
    const [required, forbidden] =
      mode === 'new'
        ? [['first_name', 'last_name', 'phone_number'], ['user_id']]
        : [['user_id'], ['first_name', 'last_name', 'phone_number', 'email']];
    for (const field of required) {
      const value = spec[field];
      if (value === undefined || value === null || value === '') {
        owner[field] = [`This field is required when mode is "${mode}".`];
      }
    }
    for (const field of forbidden) {
      if (field in spec) owner[field] = [`This field is not accepted when mode is "${mode}".`];
    }
    // `StrictUUIDStringField`: a JSON number is refused rather than reinterpreted as
    // `uuid.UUID(int=…)`, which would produce a well-formed UUID no account has carried.
    const userId = spec['user_id'];
    if (mode === 'existing' && userId !== undefined && !('user_id' in owner)) {
      if (typeof userId !== 'string') {
        owner['user_id'] = ['Send the owner account id as a UUID string.'];
      } else if (!isUuid(userId)) {
        owner['user_id'] = ['Enter a valid UUID.'];
      }
    }
  }
  if (Object.keys(owner).length > 0) errors['owner'] = owner;

  const reason = String(request.reason ?? '').trim();
  if (!reason) errors['reason'] = ['This field may not be blank.'];
  else if (reason.length < MIN_REASON_LENGTH) {
    errors['reason'] = [`Please state a reason of at least ${MIN_REASON_LENGTH} characters.`];
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * `normalise_msisdn`, Uganda-only, with its exact branches and its exact messages —
 * none of which include the raw number. Separators are stripped FIRST, then the
 * remaining digits are branched on: `256…` is taken as is, a trunk `0` is replaced,
 * nine bare digits are prefixed, and anything else cannot be canonicalised
 * confidently and is refused rather than guessed.
 */
function normaliseMsisdn(raw: string): string | { readonly error: string } {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return { error: 'Empty or non-numeric phone number.' };
  let candidate: string;
  if (digits.startsWith('256')) candidate = digits;
  else if (digits.startsWith('0')) candidate = `256${digits.slice(1)}`;
  else if (digits.length === 9) candidate = `256${digits}`;
  else return { error: `Cannot canonicalise phone number (${digits.length} digits).` };
  if (candidate.length !== 12) {
    return { error: `Result is not a 12-digit 256 number (${candidate.length} digits).` };
  }
  return candidate;
}

/** Trimmed and lower-cased, or null — blank collapses to absence, as the service stores it. */
function normaliseEmail(raw: string | null): string | null {
  const cleaned = String(raw ?? '').trim().toLowerCase();
  return cleaned === '' ? null : cleaned;
}

/** Enough of `validate_email` to refuse what an operator would type by mistake. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `_collapse`: trimmed, internal whitespace runs reduced to one space. Never case-folded. */
function collapse(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** `str.title()`, near enough: the first letter of each run of letters up, the rest down. */
function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`);
}

/** The shape `uuid.UUID(...)` accepts from a client: eight-four-four-four-twelve hex. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/**
 * `secrets.token_urlsafe(48)`: 48 random bytes, base64url, no padding — 64 characters,
 * ~288 bits. Minted from the browser's CSPRNG for the one response that carries it and
 * held NOWHERE afterwards: this file keeps no plaintext and no hash, because nothing
 * here ever verifies a redemption, and a credential in a fixture map is exactly the
 * shape production code could one day consume by accident.
 */
function mintClaimToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The owner-claim COMPATIBILITY ALIASES, mirrored off the canonical onboarding record
 * exactly as the backend mirrors them, so a written onboarding overlay can never
 * disagree with the owner block beside it.
 */
function withClaimAliases(owner: RestaurantOwner, onboarding: OnboardingSummary): RestaurantOwner {
  return {
    ...owner,
    claim_tracked: onboarding.tracked,
    claim_status: onboarding.tracked ? onboarding.owner_control.status : null,
  };
}

/**
 * The directory row projected DOWN from a detail — the common fields plus the issue
 * count, and nothing detail-only. Spelled field by field rather than spread, so the
 * row can never quietly acquire `onboarding`, `owner` or `recent_activity`.
 */
function toRow(record: RestaurantDetail): RestaurantRow {
  return {
    id: record.id,
    commercial: record.commercial,
    name: record.name,
    location: record.location,
    status: record.status,
    is_test: record.is_test,
    readiness: record.readiness,
    subscription: record.subscription,
    last_activity_at: record.last_activity_at,
    needs_attention: record.needs_attention,
    payment_mode: record.payment_mode,
    payment_mode_configured: record.payment_mode_configured,
    open_issue_count: record.support.open_issue_count,
  };
}

/**
 * Read a one-shot lever and DISARM it, whatever it held. An unrecognised value is
 * discarded rather than honoured, so a typo in the console cannot arm a behaviour that
 * does not exist and leave it armed.
 */
function consumeLever<V extends string>(key: string, values: readonly V[]): V | null {
  const value = sessionStorage.getItem(key);
  if (value === null) return null;
  sessionStorage.removeItem(key);
  return (values as readonly string[]).includes(value) ? (value as V) : null;
}

/** The three closed vocabularies, exactly as `commercial_app.models` spells them. */
const PAYMENT_TIMINGS: readonly string[] = ['pay_first', 'pay_after'];
const COLLECTION_MODES: readonly string[] = ['offline', 'psp_online'];
const INTERVAL_UNITS: readonly string[] = ['day', 'week', 'month', 'year'];

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
