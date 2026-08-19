import { ChangeDetectionStrategy, Component } from '@angular/core';

import { booleanParam, enumParam, urlState } from '../core/url/query-param';
import { AdminTableColumn, AdminTableComponent } from '../ui/table.component';

/** The four lifecycle states, exactly as `restaurants_app` spells them. */
export const LIFECYCLE_FILTERS = ['onboarding', 'live', 'suspended', 'offboarded'] as const;

interface DirectoryRow {
  readonly name: string;
  readonly status: string;
  readonly readiness: string;
}

/**
 * Restaurants — the directory. A PLACEHOLDER THAT PROVES ONE THING.
 *
 * The directory itself is step 1 and is explicitly out of scope here. What this
 * screen does carry is the mechanism step 1 must inherit: FILTERS LIVE IN THE URL
 * (spec §9.2), so `/restaurants?status=onboarding&attention=true` is a real,
 * shareable, refreshable address with working browser Back.
 *
 * That is not a nicety. Home's needs-attention items link INTO a filtered directory
 * ("3 restaurants have outstanding go-live blockers" → the filtered list). If the
 * filter lives in component state those links cannot exist, and the inbox that §11
 * builds the whole product around does not work.
 *
 * Both controls below are bound through `urlState()`, so this page is the working
 * proof rather than a promise — change either and watch the address bar.
 */
@Component({
  selector: 'app-restaurants-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminTableComponent],
  template: `
    <header>
      <h1 class="text-admin-page text-ink">Restaurants</h1>
      <p class="mt-0.5 text-admin-body text-ink-muted">
        Every tenant, and the state each one is in.
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-3 rounded-lg bg-surface p-3 ring-1 ring-line">
      <label class="flex items-center gap-2 text-admin-label text-ink-muted" for="status-filter">
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
            <option [value]="option">{{ option }}</option>
          }
        </select>
      </label>

      <label class="flex items-center gap-2 text-admin-label text-ink-muted" for="attention-filter">
        <input
          id="attention-filter"
          type="checkbox"
          class="h-4 w-4 accent-admin-accent"
          [checked]="attention.value()"
          (change)="onAttention($event)"
        />
        Needs attention only
      </label>

      <span class="ml-auto text-admin-meta text-ink-subtle">
        These two filters are held in the URL, not in this component.
      </span>
    </div>

    <app-admin-table
      caption="Restaurant directory"
      [columns]="columns"
      [rows]="rows"
      empty="No restaurants to show."
      emptyHint="The directory and the restaurant detail workspace are step 1. This screen exists
                 so the URL-backed filtering it depends on is already in place."
    />
  `,
})
export class RestaurantsPage {
  protected readonly lifecycleOptions = LIFECYCLE_FILTERS;

  // Must be created in the routed component's injection context — see `urlState`.
  private readonly url = urlState();

  /** `?status=onboarding` — an unrecognised value falls back to "all" and is dropped. */
  protected readonly status = this.url.param('status', enumParam(LIFECYCLE_FILTERS));
  /** `?attention=true` — omitted from the URL when false, so ordinary links stay short. */
  protected readonly attention = this.url.param('attention', booleanParam());

  protected readonly rows: readonly DirectoryRow[] = [];

  protected readonly columns: readonly AdminTableColumn<DirectoryRow>[] = [
    { key: 'name', header: 'Restaurant', value: (row) => row.name },
    { key: 'status', header: 'Lifecycle', value: (row) => row.status },
    { key: 'readiness', header: 'Readiness', value: (row) => row.readiness },
  ];

  protected onStatus(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.status.set(value === '' ? null : (value as (typeof LIFECYCLE_FILTERS)[number]));
  }

  protected onAttention(event: Event): void {
    this.attention.set((event.target as HTMLInputElement).checked);
  }
}
