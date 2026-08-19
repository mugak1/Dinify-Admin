import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { formatEat, formatRelativeToServer } from '../core/formatting/time';
import { formatUGX } from '../core/formatting/currency';
import { SessionStore } from '../core/auth/session.store';
import { AdminButtonComponent, ButtonVariant } from '../ui/button.component';
import { AdminTableColumn, AdminTableComponent } from '../ui/table.component';
import { StatusPillComponent, StatusPillVariant } from '../ui/status-pill.component';

/**
 * A build marker — see `MOCK_AUTH_BUILD_MARKER`. Rendered as a `data-` attribute so a
 * minifier cannot drop it; `scripts/check-mock-isolation.mjs` fails the build if it
 * reaches a production bundle.
 */
export const GALLERY_BUILD_MARKER = 'DINIFY_ADMIN_GALLERY_PRESENT';

interface GalleryRow {
  readonly restaurant: string;
  readonly reference: string;
  readonly outstanding: string;
  readonly lastSeen: string;
}

/**
 * The primitives gallery — DEVELOPMENT BUILDS ONLY.
 *
 * Every primitive, every state, on one page, so the visual system can be reviewed as
 * a system rather than discovered one screen at a time. This is where the §16
 * decision about brand red at real density actually gets made: the accent appears
 * here against the dark chrome, on dense rows, next to the danger red and the amber,
 * which is the only context in which "is this the right red" is answerable.
 *
 * It is NOT in the production module graph — `dev-tools.ts` is file-replaced at
 * production build time, so nothing here is reachable, and the check above proves it
 * rather than asserting it.
 */
@Component({
  selector: 'app-gallery-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent, AdminTableComponent, StatusPillComponent],
  template: `
    <div [attr.data-build-marker]="marker">
      <header>
        <h1 class="text-admin-page text-ink">Primitives</h1>
        <p class="mt-0.5 text-admin-body text-ink-muted">
          Development build only. Not reachable in production.
        </p>
      </header>

      <section class="mt-4 rounded-lg bg-surface p-5 ring-1 ring-line">
        <h2 class="text-admin-section text-ink">Status pills</h2>
        <p class="mt-1 text-admin-body text-ink-muted">
          Never interactive. TEST is the only solid fill, so it differs in form as well as
          colour.
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          @for (variant of pillVariants; track variant) {
            <app-status-pill [variant]="variant" />
          }
        </div>
      </section>

      <section class="mt-4 rounded-lg bg-surface p-5 ring-1 ring-line">
        <h2 class="text-admin-section text-ink">Buttons</h2>
        <p class="mt-1 text-admin-body text-ink-muted">
          Primary reads the single accent token. Destructive reads the separate danger token —
          the palette has to distinguish "do this" from "this destroys something".
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          @for (variant of buttonVariants; track variant) {
            <app-admin-button [variant]="variant">{{ variant }}</app-admin-button>
          }
          <app-admin-button variant="primary" [pending]="true">pending</app-admin-button>
          <app-admin-button variant="secondary" [disabled]="true">disabled</app-admin-button>
        </div>
        <div class="mt-3">
          <app-admin-button variant="primary" [pending]="busy()" (pressed)="simulate()"
            >Simulate a consequential write</app-admin-button
          >
        </div>
      </section>

      <section class="mt-4">
        <h2 class="text-admin-section text-ink">Table</h2>
        <p class="mb-3 mt-1 text-admin-body text-ink-muted">
          Dense rows, tabular numerals on numeric columns, arrow keys and Home/End to move,
          Enter to activate.
        </p>
        <app-admin-table
          caption="Sample rows"
          [columns]="columns"
          [rows]="rows"
          empty="Nothing here."
        />
      </section>

      <section class="mt-4">
        <h2 class="text-admin-section text-ink">Empty state</h2>
        <p class="mb-3 mt-1 text-admin-body text-ink-muted">
          "Nothing here" and "failed to load" must never look alike.
        </p>
        <app-admin-table
          caption="Empty sample"
          [columns]="columns"
          [rows]="[]"
          empty="No invoices yet."
          emptyHint="Invoices appear once subscriptions exist."
        />
      </section>

      <section class="mt-4 rounded-lg bg-surface p-5 ring-1 ring-line">
        <h2 class="text-admin-section text-ink">Formatting</h2>
        <dl class="mt-3 grid grid-cols-[10rem_1fr] gap-y-1 text-admin-body">
          <dt class="text-ink-muted">Currency</dt>
          <dd class="tabular-figures text-ink">{{ sampleMoney }}</dd>
          <dt class="text-ink-muted">Time</dt>
          <dd class="text-ink">{{ sampleTime }}</dd>
          <dt class="text-ink-muted">Relative</dt>
          <dd class="text-ink">{{ relative() }}</dd>
        </dl>
        <p class="mt-3 text-admin-meta text-ink-subtle">
          Relative time is anchored on the server's clock, never the browser's.
        </p>
      </section>
    </div>
  `,
})
export class GalleryPage {
  protected readonly marker = GALLERY_BUILD_MARKER;
  private readonly session = inject(SessionStore);

  protected readonly pillVariants: readonly StatusPillVariant[] = [
    'onboarding',
    'live',
    'suspended',
    'offboarded',
    'neutral',
    'test',
  ];

  protected readonly buttonVariants: readonly ButtonVariant[] = [
    'primary',
    'secondary',
    'destructive',
    'ghost',
  ];

  protected readonly busy = signal(false);

  protected readonly sampleMoney = formatUGX('150000.00');
  protected readonly sampleTime = formatEat('2026-08-19T12:42:00+00:00');

  protected readonly rows: readonly GalleryRow[] = [
    {
      restaurant: 'Kampala Bistro',
      reference: 'REST-0018',
      outstanding: formatUGX('150000.00'),
      lastSeen: formatEat('2026-08-19T12:42:00+00:00'),
    },
    {
      restaurant: 'Nakasero Grill',
      reference: 'REST-0021',
      outstanding: formatUGX('9500'),
      lastSeen: formatEat('2026-08-18T06:05:00+00:00'),
    },
    {
      restaurant: 'Kololo Coffee House',
      reference: 'REST-0034',
      outstanding: formatUGX('1250000'),
      lastSeen: formatEat('2026-07-30T19:20:00+00:00'),
    },
  ];

  protected readonly columns: readonly AdminTableColumn<GalleryRow>[] = [
    { key: 'restaurant', header: 'Restaurant', value: (row) => row.restaurant },
    { key: 'reference', header: 'Reference', value: (row) => row.reference },
    { key: 'outstanding', header: 'Outstanding', numeric: true, value: (row) => row.outstanding },
    { key: 'lastSeen', header: 'Last activity', value: (row) => row.lastSeen },
  ];

  protected relative(): string {
    return (
      formatRelativeToServer('2026-08-19T12:42:00+00:00', this.session.serverNowMs()) ??
      'no server clock yet'
    );
  }

  protected simulate(): void {
    this.busy.set(true);
    setTimeout(() => this.busy.set(false), 1500);
  }
}
