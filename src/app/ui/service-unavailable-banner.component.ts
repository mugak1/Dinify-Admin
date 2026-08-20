import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { AdminServiceStatus } from '../core/api/service-status';
import { AdminAuthService } from '../core/auth/admin-auth.service';
import { AdminButtonComponent } from './button.component';

/**
 * A MID-SESSION outage, inside the shell.
 *
 * The cold-start case gets its own view (`ServiceUnavailablePage`) because there is
 * nothing else to show. This one is a banner precisely because there IS: the session
 * was never denied, so the operator keeps their place and everything already on screen
 * stays readable.
 *
 * ── NOT DISMISSIBLE, AND THAT IS THE POINT ────────────────────────────────────────
 *
 * This is a LIVE STATE, not a message about one. It clears itself the moment any
 * request gets an answer (see `AdminServiceStatus`), so a Dismiss button could only
 * ever hide a fault that is still happening — and the next consequential write would
 * fail into the silence it created. The defect banner beside it is dismissible for the
 * opposite reason: a defect is history by the time it is read.
 */
@Component({
  selector: 'app-service-unavailable-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent],
  template: `
    @if (status.unavailable()) {
      <div
        role="alert"
        class="flex items-start gap-3 rounded-lg bg-admin-danger-soft px-4 py-3
               ring-1 ring-inset ring-admin-danger/20"
      >
        <svg
          class="mt-0.5 h-4 w-4 shrink-0 text-admin-danger"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M7.13 2.4a1 1 0 0 1 1.74 0l5.5 9.6a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5ZM7.25 6h1.5v4h-1.5Zm0 5h1.5v1.5h-1.5Z"
          />
        </svg>
        <div class="min-w-0 flex-1">
          <p class="text-admin-body text-ink">
            The admin control plane is not answering. Your session is still valid —
            nothing here has been signed out — but writes will fail until it returns.
          </p>
          @if (status.requestId(); as requestId) {
            <p class="mt-1 text-admin-meta text-ink-muted">
              Request <span class="tabular-figures select-all">{{ requestId }}</span> — quote
              this when reporting it.
            </p>
          }
        </div>
        <app-admin-button variant="secondary" [pending]="checking()" (pressed)="recheck()"
          >Check again</app-admin-button
        >
      </div>
    }
  `,
})
export class ServiceUnavailableBannerComponent {
  protected readonly status = inject(AdminServiceStatus);
  private readonly auth = inject(AdminAuthService);

  protected readonly checking = signal(false);

  /**
   * The same session read the cold start uses. On success it adopts a fresh session
   * (and a fresh clock anchor), and `AdminServiceStatus` clears itself — so the banner
   * disappears without anything here having to hide it.
   */
  protected async recheck(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    try {
      await this.auth.bootstrap();
    } finally {
      this.checking.set(false);
    }
  }
}
