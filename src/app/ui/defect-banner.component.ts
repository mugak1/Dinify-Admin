import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { DefectService } from '../core/api/defect.service';

/**
 * What the operator sees when something failed in a way no screen owns.
 *
 * ── WHY THE REQUEST ID IS ON SCREEN ───────────────────────────────────────────────
 *
 * `X-Request-ID` is the only header the admin plane adds to a response
 * (`platform_admin_app/middleware.py`). It is a server-generated uuid4 — never read
 * from a client header, so it cannot be forged or pinned — and it is the correlation
 * key into the append-only `AdminAuditLog`.
 *
 * For a one-person platform company that is the difference between a bug report that
 * says "it broke when I clicked suspend" and one that resolves to a single server log
 * line and a single audit row. Showing it costs a line of markup; recovering it
 * afterwards costs an afternoon.
 *
 * Only genuine defects land here — unclassified 4xx/5xx, an exhausted CSRF retry, an
 * exhausted elevation replay. Expected outcomes (a rejected password, a refused
 * transition) are rendered by the screen that asked for them, so this banner stays
 * rare enough to be worth reading.
 */
@Component({
  selector: 'app-defect-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (defects.current(); as defect) {
      <div
        role="alert"
        class="flex items-start gap-3 rounded-lg bg-admin-danger-soft px-4 py-3
               ring-1 ring-inset ring-admin-danger/20"
      >
        <svg class="mt-0.5 h-4 w-4 shrink-0 text-admin-danger" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 4.5h1.5v5h-1.5v-5Zm0 6.25h1.5v1.5h-1.5v-1.5Z"
          />
        </svg>
        <div class="min-w-0 flex-1">
          <p class="text-admin-body text-ink">{{ defect.message }}</p>
          @if (defect.requestId; as requestId) {
            <p class="mt-1 text-admin-meta text-ink-muted">
              Request <span class="tabular-figures select-all">{{ requestId }}</span> — quote this
              when reporting it.
            </p>
          }
        </div>
        <button
          type="button"
          class="rounded-sm px-1 text-admin-meta text-ink-muted hover:text-ink"
          (click)="defects.dismiss()"
        >
          Dismiss
        </button>
      </div>
    }
  `,
})
export class DefectBannerComponent {
  protected readonly defects = inject(DefectService);
}
