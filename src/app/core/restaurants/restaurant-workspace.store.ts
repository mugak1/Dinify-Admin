import { computed, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of, Subject, switchMap, tap } from 'rxjs';

import { AdminServiceStatus } from '../api/service-status';
import { LoadFailure, reportReadReachable, toLoadFailure } from './load-failure';
import { RESTAURANT_API } from './restaurant.api';
import { CommercialSummary, RestaurantDetail } from './restaurant.model';

/** What the workspace is currently able to show. Four states, never collapsed. */
export type WorkspaceState = 'idle' | 'loading' | 'loaded' | 'error';

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

  /** The restaurant, once read. Null while loading, and after a failure. */
  readonly detail = this._detail.asReadonly();
  /** Why the read failed, or null. `kind === 'not-found'` is its own rendered state. */
  readonly failure = this._failure.asReadonly();
  readonly loading = this._loading.asReadonly();

  /**
   * True while a service-configuration write is in flight for THIS restaurant.
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
   * Claim the single service-configuration write slot. False when one is already in
   * flight, in which case the caller must not send anything.
   */
  beginMutation(): boolean {
    if (this._mutating()) return false;
    this._mutating.set(true);
    return true;
  }

  /**
   * Release the slot. Safe to call from a callback whose component has since been
   * destroyed — which is the ordinary case when an operator navigates away mid-write,
   * and precisely why the flag is held here.
   */
  endMutation(): void {
    this._mutating.set(false);
  }
}
