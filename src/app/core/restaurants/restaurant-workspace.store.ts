import { computed, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of, Subject, switchMap, tap } from 'rxjs';

import { AdminServiceStatus } from '../api/service-status';
import { LoadFailure, toLoadFailure } from './load-failure';
import { RESTAURANT_API } from './restaurant.api';
import { RestaurantDetail } from './restaurant.model';

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

  /** The restaurant, once read. Null while loading, and after a failure. */
  readonly detail = this._detail.asReadonly();
  /** Why the read failed, or null. `kind === 'not-found'` is its own rendered state. */
  readonly failure = this._failure.asReadonly();
  readonly loading = this._loading.asReadonly();

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
}
