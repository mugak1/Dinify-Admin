import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { catchError, distinctUntilChanged, of, switchMap, tap } from 'rxjs';

import { AdminServiceStatus } from '../core/api/service-status';
import { formatEat } from '../core/formatting/time';
import { LoadFailure, toLoadFailure } from '../core/restaurants/load-failure';
import { RESTAURANT_API } from '../core/restaurants/restaurant.api';
import {
  lifecycleLabel,
  lifecycleVariant,
  paymentModeLabel,
  readinessLabel,
  subscriptionLabel,
} from '../core/restaurants/restaurant.labels';
import {
  DirectoryPagination,
  DirectoryQuery,
  LIFECYCLE_STATES,
  LifecycleState,
  RestaurantRow,
} from '../core/restaurants/restaurant.model';
import { booleanParam, enumParam, integerParam, stringParam, urlState } from '../core/url/query-param';
import { AdminButtonComponent } from '../ui/button.component';
import { StatusPillComponent } from '../ui/status-pill.component';
import {
  AdminTableCellDirective,
  AdminTableColumn,
  AdminTableComponent,
} from '../ui/table.component';

/** The four lifecycle states, exactly as `restaurants_app` spells them. */
export const LIFECYCLE_FILTERS = LIFECYCLE_STATES;

/** The three §15 quick views, plus the state where the URL matches none of them. */
export type QuickView = 'all' | 'attention' | 'onboarding' | 'custom';

/** Typing must not fire a request per keystroke; the URL is still the source of truth. */
export const SEARCH_DEBOUNCE_MS = 250;

/** What the directory can currently show. Four states, and never collapsed into one. */
type DirectoryState = 'loading' | 'rows' | 'empty' | 'error';

/**
 * Restaurants — THE DIRECTORY (spec §15 step 1, columns per §9.1).
 *
 * ── FILTERS LIVE IN THE URL ───────────────────────────────────────────────────────
 *
 * `?search=`, `?status=`, `?attention=` and `?page=` are bound through `urlState()`,
 * so `/restaurants?status=onboarding&attention=true` is a real, shareable, refreshable
 * address with working browser Back. That is not a nicety: Home's needs-attention
 * items link INTO a filtered directory ("3 restaurants have outstanding go-live
 * blockers" → the filtered list), and if the filter lived in a component field those
 * links could not exist.
 *
 * Exactly the four parameters the backend accepts, and nothing speculative. Its query
 * string is DENY-BY-DEFAULT — an unknown key is a 400 — so a `sort` or `view`
 * parameter added here in advance of the server would take the screen down.
 *
 * ── RACE SAFETY ───────────────────────────────────────────────────────────────────
 *
 * Every filter change flows through ONE `switchMap`, so a slow response for the
 * previous filter is CANCELLED rather than allowed to land on top of a newer one.
 * Without it, typing "Kam" then "Kampala" can leave the wider result on screen under
 * the narrower query — the directory then shows rows that do not match what the
 * controls say, which on this plane is how an operator opens the wrong tenant.
 *
 * ── LOADING, EMPTY AND FAILED ARE THREE DIFFERENT ANSWERS ─────────────────────────
 *
 * "No restaurants match these filters" is a real answer an operator will act on;
 * "the read failed" is not an answer at all. Rendering the second as the first is the
 * same class of defect as a dead backend presenting as "Invalid credentials." — see
 * `AdminAuthService.bootstrap`. So a failure NEVER produces an empty table: it
 * produces a failure state with a retry, and (for a 5xx or a dead socket) the shell's
 * outage banner alongside it.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────────────
 *
 * No bulk actions and no saved views (§15: nothing legitimate happens in bulk across
 * tenants). No Create restaurant button — that is step 2, and a button that cannot
 * work is worse than no button. No sort control: the server orders by name and offers
 * no ordering parameter, so a sort header would be a control with nothing behind it.
 */
@Component({
  selector: 'app-restaurants-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminButtonComponent,
    AdminTableCellDirective,
    AdminTableComponent,
    StatusPillComponent,
  ],
  template: `
    <header>
      <h1 class="text-admin-page text-ink">Restaurants</h1>
      <p class="mt-0.5 text-admin-body text-ink-muted">
        Every tenant, and the state each one is in.
      </p>
    </header>

    <!-- QUICK VIEWS. A real tablist: the selected one always describes the URL, so
         "All" can never be highlighted while ?status=suspended is set. -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-1 rounded-lg bg-surface p-1 ring-1 ring-line" role="tablist"
           aria-label="Quick views">
        @for (view of quickViews; track view.id) {
          <button
            type="button"
            role="tab"
            class="h-control rounded px-3 text-admin-label transition-colors"
            [class.bg-admin-accent]="activeView() === view.id"
            [class.text-admin-accent-fg]="activeView() === view.id"
            [class.text-ink-muted]="activeView() !== view.id"
            [class.hover:bg-surface-sunken]="activeView() !== view.id"
            [attr.aria-selected]="activeView() === view.id"
            (click)="selectView(view.id)"
          >
            {{ view.label }}
          </button>
        }
        @if (activeView() === 'custom') {
          <span
            role="tab"
            aria-selected="true"
            class="h-control inline-flex items-center rounded bg-surface-sunken px-3
                   text-admin-label text-ink"
            >Custom</span
          >
        }
      </div>
    </div>

    <div class="flex flex-wrap items-end gap-3 rounded-lg bg-surface p-3 ring-1 ring-line">
      <label class="flex flex-col gap-1 text-admin-label text-ink-muted" for="restaurant-search">
        Search
        <input
          id="restaurant-search"
          type="search"
          placeholder="Name or location"
          class="h-control w-64 rounded bg-surface px-2 text-admin-body text-ink
                 ring-1 ring-inset ring-line-strong"
          [value]="searchDraft()"
          (input)="onSearch($event)"
        />
      </label>

      <label class="flex flex-col gap-1 text-admin-label text-ink-muted" for="status-filter">
        Lifecycle
        <select
          id="status-filter"
          class="h-control rounded bg-surface px-2 text-admin-body text-ink
                 ring-1 ring-inset ring-line-strong"
          [value]="status.value() ?? ''"
          (change)="onStatus($event)"
        >
          <option value="">All</option>
          @for (option of lifecycleOptions; track option) {
            <option [value]="option">{{ lifecycleLabel(option) }}</option>
          }
        </select>
      </label>

      <label class="flex h-control items-center gap-2 text-admin-label text-ink-muted"
             for="attention-filter">
        <input
          id="attention-filter"
          type="checkbox"
          class="h-4 w-4 accent-admin-accent"
          [checked]="attention.value()"
          (change)="onAttention($event)"
        />
        Needs attention only
      </label>

      @if (hasFilters()) {
        <app-admin-button variant="ghost" (pressed)="clearFilters()">Clear filters</app-admin-button>
      }
    </div>

    <!-- One live region for the whole result set. Polite and coarse on purpose:
         announcing per keystroke would make the screen reader unusable while typing. -->
    <p class="sr-only" role="status">{{ announcement() }}</p>

    @switch (state()) {
      @case ('loading') {
        <!-- A deliberate progress state, sized like the table it replaces so the page
             does not jump when rows arrive. -->
        <div class="rounded-lg bg-surface p-6 ring-1 ring-line" aria-busy="true">
          <p class="text-admin-body text-ink-muted">Loading restaurants…</p>
          <div class="mt-4 space-y-2" aria-hidden="true">
            @for (placeholder of placeholders; track placeholder) {
              <div class="h-row animate-pulse rounded bg-surface-sunken"></div>
            }
          </div>
        </div>
      }

      @case ('error') {
        <!-- NEVER an empty table. The request id is what turns "it broke" into a
             report that resolves to one server log line. -->
        <div class="rounded-lg bg-surface p-6 ring-1 ring-line">
          <h2 class="text-admin-section text-ink">The restaurant directory could not be loaded</h2>
          <p class="mt-1 max-w-prose text-admin-body text-ink-muted">{{ failure()?.message }}</p>
          @if (failure()?.requestId; as requestId) {
            <p class="mt-2 text-admin-meta text-ink-subtle">
              Request ID <span class="tabular-figures">{{ requestId }}</span> — quote this if you
              report it.
            </p>
          }
          <div class="mt-4">
            <app-admin-button variant="primary" (pressed)="retry()">Try again</app-admin-button>
          </div>
        </div>
      }

      @default {
        <app-admin-table
          caption="Restaurant directory"
          [columns]="columns"
          [rows]="rows()"
          [empty]="hasFilters() ? 'No restaurants match these filters.' : 'No restaurants yet.'"
          [emptyHint]="
            hasFilters()
              ? 'Widen the search, or clear the filters to see the whole portfolio.'
              : 'Restaurants appear here once they exist on the platform.'
          "
          (rowActivate)="open($event)"
        >
          <!-- THE RESTAURANT CELL. Name, then the location as quieter secondary text,
               then the TEST treatment — the existing solid-filled pill, not a second
               label style. §16 requires a test tenant to be unmistakable, and shape
               carries that further than hue does. -->
          <ng-template [appAdminTableCell]="'restaurant'" [appAdminTableCellOf]="rows()" let-row>
            <div class="flex items-center gap-2">
              <span
                class="text-admin-body text-ink"
                [class.font-semibold]="row.needs_attention"
                >{{ row.name }}</span
              >
              @if (row.is_test) {
                <app-status-pill variant="test" />
              }
              @if (row.needs_attention) {
                <!-- Not a badge: §16 asks for badges sparingly, and the attention
                     signal earns weight rather than another colour. -->
                <span class="text-admin-meta text-admin-warning">Needs attention</span>
              }
            </div>
            @if (row.location) {
              <span class="text-admin-meta text-ink-subtle">{{ row.location }}</span>
            }
          </ng-template>

          <ng-template [appAdminTableCell]="'status'" [appAdminTableCellOf]="rows()" let-row>
            <app-status-pill [variant]="lifecycleVariant(row.status)" />
          </ng-template>
        </app-admin-table>

        <!-- PAGINATION. Backend metadata only: nothing here recomputes a page count. -->
        @if (pagination(); as page) {
          <div class="flex items-center justify-between gap-3">
            <p class="text-admin-meta text-ink-muted tabular-figures">{{ rangeLabel() }}</p>
            <nav class="flex items-center gap-2" aria-label="Directory pages">
              <app-admin-button
                variant="secondary"
                [disabled]="page.page <= 1"
                (pressed)="goToPage(page.page - 1)"
                >Previous</app-admin-button
              >
              <span class="text-admin-meta text-ink-muted tabular-figures"
                >Page {{ page.page }} of {{ page.pages }}</span
              >
              <app-admin-button
                variant="secondary"
                [disabled]="page.page >= page.pages"
                (pressed)="goToPage(page.page + 1)"
                >Next</app-admin-button
              >
            </nav>
          </div>
        }
      }
    }
  `,
})
export class RestaurantsPage {
  private readonly api = inject(RESTAURANT_API);
  private readonly status$ = inject(AdminServiceStatus);
  private readonly router = inject(Router);

  protected readonly lifecycleOptions = LIFECYCLE_FILTERS;
  protected readonly lifecycleLabel = lifecycleLabel;
  protected readonly lifecycleVariant = lifecycleVariant;
  /** Row-shaped placeholders for the loading state. The count is cosmetic. */
  protected readonly placeholders = [0, 1, 2, 3, 4, 5];

  protected readonly quickViews: readonly { id: Exclude<QuickView, 'custom'>; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'onboarding', label: 'Onboarding' },
  ];

  // Must be created in the routed component's injection context — see `urlState`.
  private readonly url = urlState();

  /** `?search=` — free text, matched against name or location by the server. */
  protected readonly search = this.url.param('search', stringParam());
  /** `?status=onboarding` — an unrecognised value falls back to "all" and is dropped. */
  protected readonly status = this.url.param('status', enumParam(LIFECYCLE_FILTERS));
  /** `?attention=true` — omitted from the URL when false, so ordinary links stay short. */
  protected readonly attention = this.url.param('attention', booleanParam());
  /** `?page=2` — omitted at 1. A malformed value fails soft to 1 rather than 400ing. */
  protected readonly page = this.url.param('page', integerParam());

  /**
   * What the search box currently shows.
   *
   * Separate from `search` because the two have different clocks: the input must react
   * instantly to a keystroke, while the URL (and the request) must not. The effect
   * below pulls the draft back into line whenever the URL changes from OUTSIDE this
   * component — Back, a pasted link, Clear filters — without fighting the operator
   * mid-word, because it only writes when the URL says something the draft did not.
   */
  protected readonly searchDraft = signal(this.search.value() ?? '');
  private published: string | null = this.search.value();
  private debounce: ReturnType<typeof setTimeout> | null = null;

  private readonly _rows = signal<readonly RestaurantRow[]>([]);
  private readonly _pagination = signal<DirectoryPagination | null>(null);
  private readonly _failure = signal<LoadFailure | null>(null);
  private readonly _loading = signal(true);
  /** Bumped by Try again, so a retry re-emits a query identical to the failed one. */
  private readonly retryToken = signal(0);

  protected readonly rows = this._rows.asReadonly();
  protected readonly pagination = this._pagination.asReadonly();
  protected readonly failure = this._failure.asReadonly();

  /** The exact request to make. Nothing outside these four parameters is ever sent. */
  private readonly query = computed<DirectoryQuery & { readonly token: number }>(() => ({
    search: this.search.value(),
    status: this.status.value(),
    attention: this.attention.value() ? true : null,
    page: this.page.value(),
    pageSize: null,
    token: this.retryToken(),
  }));

  protected readonly state = computed<DirectoryState>(() => {
    if (this._loading()) return 'loading';
    if (this._failure()) return 'error';
    return this._rows().length ? 'rows' : 'empty';
  });

  protected readonly hasFilters = computed(
    () => !!this.search.value() || !!this.status.value() || this.attention.value(),
  );

  /**
   * The selected quick view, DERIVED FROM THE URL rather than remembered separately.
   *
   * A remembered selection is how "All" ends up highlighted while `?status=suspended`
   * is set: the control then describes the operator's last click instead of what they
   * are looking at. Any combination the three views do not name reads as Custom.
   */
  protected readonly activeView = computed<QuickView>(() => {
    const status = this.status.value();
    const attention = this.attention.value();
    const search = this.search.value();
    if (search) return 'custom';
    if (attention && !status) return 'attention';
    if (status === 'onboarding' && !attention) return 'onboarding';
    if (!status && !attention) return 'all';
    return 'custom';
  });

  protected readonly rangeLabel = computed(() => {
    const page = this._pagination();
    if (!page || page.count === 0) return 'No restaurants';
    const first = (page.page - 1) * page.page_size + 1;
    const last = Math.min(page.count, first + this._rows().length - 1);
    return `${first}–${last} of ${page.count}`;
  });

  protected readonly announcement = computed(() => {
    switch (this.state()) {
      case 'loading':
        return 'Loading restaurants.';
      case 'error':
        return 'The restaurant directory could not be loaded.';
      case 'empty':
        return this.hasFilters()
          ? 'No restaurants match these filters.'
          : 'No restaurants yet.';
      default:
        return `${this.rangeLabel()} restaurants shown.`;
    }
  });

  protected readonly columns: readonly AdminTableColumn<RestaurantRow>[] = [
    { key: 'restaurant', header: 'Restaurant', cell: true },
    { key: 'status', header: 'Lifecycle', cell: true },
    { key: 'readiness', header: 'Readiness', value: (row) => readinessLabel(row.readiness) },
    { key: 'payment', header: 'Payment mode', value: (row) => paymentModeLabel(row) },
    {
      key: 'subscription',
      header: 'Subscription',
      value: (row) => subscriptionLabel(row.subscription),
    },
    {
      key: 'issues',
      header: 'Open issues',
      value: (row) => String(row.open_issue_count),
      numeric: true,
    },
    // Always EAT-labelled (§16). An operator administering from another timezone must
    // never have to guess which day a timestamp belongs to.
    { key: 'activity', header: 'Last activity', value: (row) => formatEat(row.last_activity_at) },
  ];

  constructor() {
    toObservable(this.query)
      .pipe(
        // A filter change that also resets the page writes two signals; the
        // computed settles once before this sees it, and `distinctUntilChanged` then
        // stops a re-emission that says nothing new from costing a request.
        distinctUntilChanged(
          (a, b) =>
            a.search === b.search &&
            a.status === b.status &&
            a.attention === b.attention &&
            a.page === b.page &&
            a.token === b.token,
        ),
        tap(() => {
          this._loading.set(true);
          this._failure.set(null);
        }),
        // switchMap, so an older in-flight read is CANCELLED rather than allowed to
        // overwrite a newer one.
        switchMap((query) =>
          this.api.list(query).pipe(
            catchError((error: unknown) =>
              of({
                failure: toLoadFailure(
                  error,
                  this.status$,
                  'The restaurant directory could not be loaded.',
                ),
              }),
            ),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((result) => {
        this._loading.set(false);
        if ('failure' in result) {
          // The rows are cleared so a stale page cannot sit under a failure message
          // and read as the current portfolio.
          this._rows.set([]);
          this._pagination.set(null);
          this._failure.set(result.failure);
          return;
        }
        this._rows.set(result.results);
        this._pagination.set(result.pagination);
        this._failure.set(null);
      });

    // URL -> input, for changes this component did not make.
    effect(() => {
      const fromUrl = this.search.value() ?? '';
      if (fromUrl !== (this.published ?? '')) {
        this.published = this.search.value();
        this.searchDraft.set(fromUrl);
      }
    });
  }

  protected open(row: RestaurantRow): void {
    void this.router.navigate(['/restaurants', row.id]);
  }

  protected onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchDraft.set(value);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.publishSearch(value.trim() === '' ? null : value);
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onStatus(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.status.set(value === '' ? null : (value as LifecycleState));
    this.resetPage();
  }

  protected onAttention(event: Event): void {
    this.attention.set((event.target as HTMLInputElement).checked);
    this.resetPage();
  }

  protected selectView(view: Exclude<QuickView, 'custom'>): void {
    // Each view states the WHOLE filter set it means, so switching between them can
    // never leave a stray parameter behind that the highlighted tab does not describe.
    this.publishSearch(null);
    this.searchDraft.set('');
    this.status.set(view === 'onboarding' ? 'onboarding' : null);
    this.attention.set(view === 'attention');
    this.resetPage();
  }

  protected clearFilters(): void {
    this.selectView('all');
  }

  protected goToPage(page: number): void {
    if (page < 1) return;
    this.page.set(page);
  }

  protected retry(): void {
    this.retryToken.update((token) => token + 1);
  }

  /** Any change to WHAT is being filtered returns to page 1 — page 4 of a new filter
   *  is almost always empty, and an empty page reads as "nothing matches". */
  private resetPage(): void {
    this.page.set(1);
  }

  private publishSearch(value: string | null): void {
    this.published = value;
    this.search.set(value);
    this.resetPage();
  }
}
