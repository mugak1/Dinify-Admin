import { computed, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of, Subject, switchMap, tap } from 'rxjs';

import { AdminServiceStatus } from '../api/service-status';
import { LoadFailure, reportReadReachable, toLoadFailure } from './load-failure';
import { RESTAURANT_API } from './restaurant.api';
import { CommercialSummary, OnboardingSummary, RestaurantDetail } from './restaurant.model';

/** What the workspace is currently able to show. Four states, never collapsed. */
export type WorkspaceState = 'idle' | 'loading' | 'loaded' | 'error';

/** The two owner-invitation writes a workspace can have in flight (Step 2G). */
export type OwnerInvitationWriteAction = 'reissue' | 'cancel';

/**
 * An owner-invitation write that got NO USABLE ANSWER: which action, and which
 * invitation it named. Non-secret bookkeeping — the Readiness tab resolves it against
 * the re-read projection once that lands. See `indeterminateInvitationWrite`.
 */
export interface IndeterminateInvitationWrite {
  readonly action: OwnerInvitationWriteAction;
  readonly expectedId: string;
}

/**
 * THE RESTAURANT WORKSPACE'S DETAIL DATA — loaded once, by the parent, for the tab
 * subtree.
 *
 * ── WHY IT IS A ROUTE-SCOPED SERVICE AND NOT A GLOBAL STORE ───────────────────────
 *
 * Provided on the `/restaurants/:id` ROUTE, so exactly one instance exists per
 * workspace and it is destroyed on the way out. The parent (`RestaurantDetailPage`)
 * calls `load()`; the tabs INJECT and read. That is what stops Overview issuing a
 * second `GET /restaurants/<id>/` merely because it happens to be a child route — the
 * §9.1 header and the Overview tab are one screen and must be one read, or they can
 * disagree with each other about the same restaurant.
 *
 * It is deliberately NOT a global state library and not an application-wide cache. A
 * cache would have to answer "how stale is this allowed to be" for a control plane
 * where the answer is different per screen; the workspace's honest answer is "as fresh
 * as the last time you opened it", and `reload()` is how the operator says otherwise.
 *
 * ── RACE SAFETY ───────────────────────────────────────────────────────────────────
 *
 * Every load goes through one `switchMap`, so a second `load()` — a different `:id`,
 * or a retry — CANCELS the first. Without that, a slow response for the previous
 * restaurant can land after a fast one for the current restaurant and repaint the
 * header with the wrong tenant's name, which on this plane is the beginning of acting
 * on the wrong restaurant. The subscription is torn down with the route.
 */
@Injectable()
export class RestaurantWorkspaceStore {
  private readonly api = inject(RESTAURANT_API);
  private readonly status = inject(AdminServiceStatus);

  private readonly requests = new Subject<string>();

  private readonly _id = signal<string | null>(null);
  private readonly _detail = signal<RestaurantDetail | null>(null);
  private readonly _failure = signal<LoadFailure | null>(null);
  private readonly _loading = signal(false);
  private readonly _mutating = signal(false);
  private readonly _invitationMutating = signal(false);
  private readonly _unshownCodeInvitationId = signal<string | null>(null);
  private readonly _indeterminateInvitationWrite = signal<IndeterminateInvitationWrite | null>(null);
  private readonly _superseded = signal(false);

  /** The restaurant, once read. Null while loading, and after a failure. */
  readonly detail = this._detail.asReadonly();
  /** Why the read failed, or null. `kind === 'not-found'` is its own rendered state. */
  readonly failure = this._failure.asReadonly();
  readonly loading = this._loading.asReadonly();

  /**
   * True while a COMMERCIAL write is in flight for THIS restaurant — either service
   * axis, or any of the three subscription-terms operations.
   *
   * ── WHY THE FLAG LIVES HERE AND NOT ON THE TAB ────────────────────────────────────
   *
   * It was a signal on the Overview component, and review found the hole: the tabs are
   * SIBLING ROUTES under this store, so switching to Readiness DESTROYS Overview while
   * the request keeps running — the write is deliberately not torn down with the
   * component. Coming back builds a fresh instance whose local flag reads false, and it
   * would happily start a second write against the same restaurant.
   *
   * That is the exact race the one-at-a-time rule exists to prevent: each write returns
   * the WHOLE canonical commercial object, so two in flight can land out of order and
   * the older snapshot repaints the newer axis change.
   *
   * The guarantee is a property of the WORKSPACE — "one service-configuration mutation
   * at a time for this restaurant" — not of one tab's component, so it belongs on the
   * thing whose lifetime actually matches: this store is provided on `/restaurants/:id`
   * and outlives every tab beneath it.
   *
   * NOT SOLVED BY `takeUntilDestroyed`, and that alternative is worse. The request has
   * already been sent; cancelling the subscription does not un-send it, so the server may
   * still commit while the client throws the response away — manufacturing an
   * indeterminate outcome out of a routine tab click.
   */
  readonly mutating = this._mutating.asReadonly();

  /**
   * True while an OWNER-INVITATION write — a reissue or a cancellation — is in flight
   * for THIS restaurant (Step 2G).
   *
   * ── A SECOND SLOT, NOT THE COMMERCIAL ONE, AND DELIBERATELY SO ───────────────────
   *
   * The commercial slot exists because every commercial write returns the WHOLE
   * canonical `commercial` object, so two of them in flight could land out of order and
   * the older snapshot would repaint the newer change. An invitation write returns the
   * canonical `onboarding` object and touches `commercial` not at all, so the two
   * domains cannot repaint each other and there is no race between them to prevent.
   * Sharing one slot would have been mechanically easy and semantically false: it would
   * shut the Readiness controls while a terms write ran on Overview, for a reason that
   * does not exist, and the docstring above would stop being true.
   *
   * What IS true within the domain is exactly the commercial argument: reissue and
   * cancel both return the whole `onboarding` projection, a reissue in flight beside a
   * cancel is pointless, and the second to land would repaint the first. So it is ONE
   * invitation mutation at a time for this workspace.
   *
   * ── AND IT LIVES HERE FOR THE SAME REASON THE COMMERCIAL FLAG DOES ───────────────
   *
   * The Readiness tab is a sibling route: switching to Overview destroys it while the
   * reissue keeps running, and a rebuilt tab with a local flag would start a second one.
   * The request is deliberately not torn down with the component — cancelling the
   * subscription would not un-send it, and the server may still commit while the client
   * discards the response. (The raw claim token in that response is NOT held here: it
   * lives only in the tab's own transient state, so a reissue whose response lands after
   * the tab was left is a lost credential. What IS held here is the non-secret fact that
   * it was lost — `unshownCodeInvitationId` — so the next tab can say so. The recovery is
   * reissuing again, which is precisely why the backend built reissue as rotation.)
   */
  readonly invitationMutating = this._invitationMutating.asReadonly();

  /**
   * The invitation whose one-time claim code a write from THIS workspace minted but no
   * tab could show — or null (Step 2G).
   *
   * ── WHY THE WORKSPACE HOLDS IT ────────────────────────────────────────────────────
   *
   * A reissue whose answer lands after the Readiness tab was left has two halves in it.
   * The canonical projection belongs on this store and is adopted; the credential does
   * not belong anywhere that outlives a tab and is dropped. Review found the consequence
   * on the REBUILT tab: it read a fresh Pending row, from a rotation the operator had
   * asked for, with no sign that the row's code had already gone unseen — the first
   * version of that tab noticed only a write still in flight when it was built, and a
   * write that had COMPLETED while the operator was on Overview left nothing behind to
   * notice. So the fact that a code went unseen is recorded HERE, as the invitation's
   * id — an identifier the canonical read publishes anyway, never the code — and the
   * Readiness tab renders the note whenever that id is still the unresolved head.
   *
   * It clears when a tab shows a code (nothing is unseen any more), when the invitation
   * is cancelled from here, and when this store moves to a different restaurant.
   */
  readonly unshownCodeInvitationId = this._unshownCodeInvitationId.asReadonly();

  /**
   * The invitation write that got no usable answer, until the operator acts again
   * (Step 2G). Held here rather than on the tab for the same reason the in-flight flag
   * is: the tab that sent the write may not be the one that renders the outcome.
   */
  readonly indeterminateInvitationWrite = this._indeterminateInvitationWrite.asReadonly();

  /**
   * True from the moment the loaded projection is KNOWN to be superseded until the
   * fresh read replacing it has settled.
   *
   * ── WHY THIS IS NOT COVERED BY `loading` ─────────────────────────────────────────
   *
   * `reload()` leaves the previous detail in place on purpose, so the workspace does not
   * blank out on a retry. That is right for an ordinary re-read — but after a 409 the
   * projection on screen is not merely old, it is KNOWN WRONG, and the tab outlet stays
   * mounted through the loading state (`restaurant-detail.page.ts` renders the outlet in
   * its `@default` branch). So the commercial panel goes on rendering superseded values
   * with its controls live.
   *
   * Review found the consequence: an operator could reopen an editor before the fresh
   * GET landed and capture THE SAME STALE TOKEN AGAIN. The server's `expected_current`
   * still refuses the write, so nothing is silently overwritten — but the recovery
   * invariant is the point:
   *
   *   AFTER A CONFLICT, THE OPERATOR MUST SEE THE FRESHLY RELOADED CANONICAL STATE
   *   BEFORE BEING ALLOWED TO MAKE ANOTHER COMMERCIAL DECISION.
   *
   * A guard built on `loading` alone would also disable controls during every ordinary
   * retry, which is a different and weaker statement. This flag says the specific thing:
   * what you are looking at has been replaced.
   *
   * IT IS SHARED BY EVERY DOMAIN ON THE WORKSPACE, unlike the two write slots. A 409
   * on an invitation write reloads the WHOLE detail, and until that read lands the
   * commercial panel is rendering a projection that is known stale too — so both panels
   * gate their controls on this one flag, and a stale invitation conflict cannot leave
   * a stale commercial editor openable underneath it.
   */
  readonly detailSuperseded = this._superseded.asReadonly();

  readonly state = computed<WorkspaceState>(() => {
    if (this._loading()) return 'loading';
    if (this._failure()) return 'error';
    if (this._detail()) return 'loaded';
    return 'idle';
  });

  constructor() {
    this.requests
      .pipe(
        tap(() => {
          this._loading.set(true);
          this._failure.set(null);
        }),
        switchMap((id) =>
          this.api.detail(id).pipe(
            // Mapped to a value rather than left to error, so one failed read cannot
            // complete the outer subscription and leave Retry inert for the rest of
            // the route's life.
            catchError((error: unknown) =>
              of({ failure: toLoadFailure(error, this.status, 'This restaurant could not be loaded.') }),
            ),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((result) => {
        this._loading.set(false);
        // The read has SETTLED, so whatever is on screen next is current — including on
        // the failure branch, where the detail is cleared and the workspace renders its
        // own error state instead of the tabs. Cleared here, at the single settle point,
        // rather than at each caller.
        this._superseded.set(false);
        if ('failure' in result) {
          this._detail.set(null);
          this._failure.set(result.failure);
          return;
        }
        this._detail.set(result);
        this._failure.set(null);
        // The other half of the outage report — see `reportReadReachable`. Without it
        // a mocked failure leaves the shell's banner up after a successful retry,
        // because no interceptor runs in mock mode to clear it.
        reportReadReachable(this.status);
      });
  }

  /**
   * Read `id`. Called by the PARENT only — a tab that calls this has become a second
   * owner of the same data, which is the duplication this store exists to prevent.
   *
   * Re-reads when the id changes, and is a no-op when it does not: `withComponentInputBinding`
   * can restate the same id on an in-place navigation between tabs, and refetching
   * the header every time the operator clicks Billing would be a request per tab.
   */
  load(id: string): void {
    if (this._id() === id && (this._loading() || this._detail() !== null)) return;
    if (this._id() !== id) {
      // A record about another restaurant's invitation must not survive into this one.
      this._unshownCodeInvitationId.set(null);
      this._indeterminateInvitationWrite.set(null);
    }
    this._id.set(id);
    this._detail.set(null);
    this.requests.next(id);
  }

  /** Re-read the current restaurant — the retry action on the failure state. */
  reload(): void {
    const id = this._id();
    if (id !== null) this.requests.next(id);
  }

  /**
   * Re-read because what is loaded has been SUPERSEDED — a 409 conflict, or a target
   * that has gone away.
   *
   * Identical to `reload()` except that it marks the projection superseded for the
   * duration, so a screen rendering it can refuse to let another decision be taken
   * against state it already knows is wrong. See `detailSuperseded`.
   */
  reloadSuperseded(): void {
    const id = this._id();
    if (id === null) return;
    this._superseded.set(true);
    this.requests.next(id);
  }

  /**
   * Adopt the canonical `commercial` projection a successful WRITE returned (Step 3E.2).
   *
   * ── WHY THIS EXISTS RATHER THAN A REFETCH ─────────────────────────────────────────
   *
   * The service-configuration endpoints re-read the projection INSIDE the mutation's own
   * transaction and hand back the state the write actually produced. That is strictly
   * better than a follow-up GET: it is the same canonical shape, it cannot race the
   * write, and it costs no second round trip. So the response is adopted, and a screen
   * that fetched again merely to learn what it had just been told would be adding a
   * request and a window in which the two answers could differ.
   *
   * ── WHY IT IS DELIBERATELY NARROW ─────────────────────────────────────────────────
   *
   * It replaces ONLY `commercial`. Every other field of the loaded detail — the owner,
   * the onboarding projection, operations, recent activity, the legacy compatibility
   * block — is preserved untouched, because the write response does not carry them and
   * a merge that guessed at them would quietly discard state the workspace still holds.
   *
   * A no-op when nothing is loaded: there is no detail to attach a projection to, and
   * synthesising one from a partial response would produce a restaurant object whose
   * other halves were invented.
   */
  adoptCommercial(commercial: CommercialSummary): void {
    const current = this._detail();
    if (current === null) return;
    this._detail.set({ ...current, commercial });
  }

  /**
   * Adopt the canonical `onboarding` projection a successful OWNER-INVITATION write
   * returned (Step 2G) — the same move as `adoptCommercial`, for the same reasons.
   *
   * The reissue and cancel endpoints re-read the projection INSIDE the mutation's own
   * transaction through the same `onboarding_summary` the detail read uses, so what
   * comes back is byte-identical to the next GET and cannot race the write. It is
   * adopted rather than refetched.
   *
   * ── IT REPLACES `onboarding`, AND KEEPS THE OWNER'S COMPATIBILITY ALIASES IN STEP ─
   *
   * `owner.claim_tracked` / `owner.claim_status` are derived by the server from the
   * onboarding projection (`restaurant_reads.serialize_owner`: `tracked`, and the
   * owner-control status while tracked). Nothing in this application renders them, but
   * leaving them stale beside a fresh `onboarding` would hold two answers to one
   * question in the same object — the exact disagreement the model warns against. So
   * they are re-derived here by the server's own rule, and only they: no other owner
   * field is touched, and no other part of the detail is guessed at.
   *
   * WHAT IT NEVER CARRIES: the raw claim token. A reissue response holds the credential
   * in a separate `owner_invitation` object, and the caller hands ONLY the projection
   * here. This store outlives every tab beneath it, which is exactly why a bearer
   * credential must not be parked in it.
   */
  adoptOnboarding(onboarding: OnboardingSummary): void {
    const current = this._detail();
    if (current === null) return;
    const owner =
      current.owner === null
        ? null
        : {
            ...current.owner,
            claim_tracked: onboarding.tracked,
            claim_status: onboarding.tracked ? onboarding.owner_control.status : null,
          };
    this._detail.set({ ...current, onboarding, owner });
  }

  /**
   * Claim the single COMMERCIAL write slot. False when one is already in flight, in
   * which case the caller must not send anything.
   */
  beginMutation(): boolean {
    if (this._mutating()) return false;
    this._mutating.set(true);
    return true;
  }

  /**
   * Release the commercial slot. Safe to call from a callback whose component has since
   * been destroyed — which is the ordinary case when an operator navigates away
   * mid-write, and precisely why the flag is held here.
   */
  endMutation(): void {
    this._mutating.set(false);
  }

  /**
   * Claim the single OWNER-INVITATION write slot. False when a reissue or a cancel is
   * already in flight, in which case the caller must not send anything — the claim is
   * the guard, not a separate `pending()` check that could disagree with it.
   */
  beginInvitationMutation(): boolean {
    if (this._invitationMutating()) return false;
    this._invitationMutating.set(true);
    return true;
  }

  /** Release the invitation slot. Safe after the requesting tab has been destroyed. */
  endInvitationMutation(): void {
    this._invitationMutating.set(false);
  }

  /**
   * A reissue landed where no tab could show its code: remember WHICH invitation that
   * was. Takes the invitation's id and nothing else — see `unshownCodeInvitationId`.
   */
  markCodeUnshown(invitationId: string): void {
    this._unshownCodeInvitationId.set(invitationId);
  }

  /** A code has been shown, or the invitation it was for is gone. */
  clearCodeUnshown(): void {
    this._unshownCodeInvitationId.set(null);
  }

  /** An invitation write got no usable answer. Recorded here; the caller re-reads. */
  noteIndeterminateInvitationWrite(write: IndeterminateInvitationWrite): void {
    this._indeterminateInvitationWrite.set(write);
  }

  /** The operator has acted again, or the outcome has been superseded by a real one. */
  clearIndeterminateInvitationWrite(): void {
    this._indeterminateInvitationWrite.set(null);
  }
}
