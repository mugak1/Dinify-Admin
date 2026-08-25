import { Injectable } from '@angular/core';
import { delay, Observable, of, throwError } from 'rxjs';

import { MIN_REASON_LENGTH } from '../core/api/api.constants';
import { RestaurantApi } from '../core/restaurants/restaurant.api';
import {
  CommercialAxis,
  CommercialMutationResult,
  CommercialSubscriptionTerms,
  CommercialSummary,
  DirectoryQuery,
  EndSubscriptionTermsRequest,
  PaymentCollectionMode,
  PaymentTiming,
  RecordSubscriptionTermsRequest,
  ReplaceSubscriptionTermsRequest,
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

/** Latency, so the loading states are actually visible when reviewing. */
const LATENCY_MS = 380;

/**
 * The mock restaurant transport — DEVELOPMENT ONLY.
 *
 * `npm start` renders the directory and the workspace with NO backend running, which
 * is how the screens get reviewed before a deploy carries them. It implements the whole
 * `RestaurantApi` — two reads, two service-configuration writes and three
 * subscription-terms writes; the pages, the workspace store, the states, the labels
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
    const found = MOCK_RESTAURANT_DETAILS.get(restaurantId);
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

  /** The 409 body shape the endpoints answer with — a sentence and a code, no row ids. */
  private conflict(code: string, message: string): Observable<CommercialMutationResult> {
    return this.throwLater(409, { status: 409, message, code });
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
