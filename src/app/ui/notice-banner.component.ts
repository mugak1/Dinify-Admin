import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { NoticeService } from '../core/notices/notice.service';

/**
 * POST-AUTHENTICATION FACTS THE OPERATOR MUST ACTUALLY SEE.
 *
 * Low recovery codes and a cleared lockout are reported by `verify/` and `elevate/`
 * and by nothing else, ever. They used to reach `console.warn` — which is to say
 * nobody, on a surface where the consequence of missing them is
 * `manage.py reset_platform_admin_totp` on the server.
 *
 * ── ONE NOTICE, AND IT WAITS ──────────────────────────────────────────────────────
 *
 * `NoticeService` composes every true fact into ONE notice; this renders that one and
 * has no concept of a second. No stacking, no queue, no timer, nothing that slides in
 * and leaves. A warning about a resource running out has to still be there when the
 * operator looks up, which is the whole reason it is not a toast.
 *
 * Amber, not red: §16 keeps "careful" visually distinct from "something is wrong".
 * Running low on recovery codes is the former — nothing is broken, and there is time
 * to act, which is exactly why it is worth saying early.
 */
@Component({
  selector: 'app-notice-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notices.notice(); as notice) {
      <div
        role="status"
        class="flex items-start gap-3 rounded-lg bg-admin-warning-soft px-4 py-3
               ring-1 ring-inset ring-admin-warning/25"
      >
        <svg
          class="mt-0.5 h-4 w-4 shrink-0 text-admin-warning"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm-.75 3h1.5v5h-1.5Zm0 6.25h1.5v1.5h-1.5Z"
          />
        </svg>
        <div class="min-w-0 flex-1">
          <p class="text-admin-body text-ink">{{ notice.title }}</p>
          <!-- One line per FACT. "The lockout was cleared" and "two codes remain" are
               different things and are not joined into a sentence. -->
          @for (fact of notice.facts; track fact) {
            <p class="mt-1 text-admin-meta text-ink-muted">{{ fact }}</p>
          }
          @if (notice.action; as action) {
            <p class="mt-1.5 text-admin-meta text-ink">{{ action }}</p>
          }
        </div>
        <!-- Dismissible, but it returns on the next sign-in while the condition
             holds. Reading it once is not the same as acting on it. -->
        <button
          type="button"
          class="rounded-sm px-1 text-admin-meta text-ink-muted hover:text-ink"
          (click)="notices.dismiss()"
        >
          Dismiss
        </button>
      </div>
    }
  `,
})
export class NoticeBannerComponent {
  protected readonly notices = inject(NoticeService);
}
