import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { AdminServiceStatus } from '../core/api/service-status';
import { AdminAuthService } from '../core/auth/admin-auth.service';
import { sanitiseReturnUrl } from '../core/auth/return-url';
import { SessionStore } from '../core/auth/session.store';
import { AuthShellComponent } from '../shell/auth-shell.component';
import { AdminButtonComponent } from '../ui/button.component';

/**
 * THE CONTROL PLANE IS NOT ANSWERING — the third bootstrap outcome, on screen.
 *
 * ── WHY THIS IS NOT A BANNER ON THE LOGIN PAGE ────────────────────────────────────
 *
 * A warning beside a sign-in form still invites credentials, and credentials cannot
 * work against a service that is not answering. The attempt then returns the uniform
 * "Invalid credentials." from the fallback path, and the operator spends the next ten
 * minutes doubting their password while the actual fault is a 502. The only honest
 * screen here is one that does not ask for anything it cannot use.
 *
 * ── WHY IT IS NOT THE SHELL EITHER ────────────────────────────────────────────────
 *
 * The shell has nothing to show without a session, and ten placeholder screens with
 * written empty states would read as real data. A MID-SESSION outage is different and
 * is handled differently: the session was never denied, so the shell stays up and the
 * outage appears as a banner inside it.
 *
 * ── MANUAL RETRY, NO SPINNER ──────────────────────────────────────────────────────
 *
 * There is no automatic retry and no full-screen progress state. The operator needs to
 * KNOW the control plane is unreachable — that is the fact that decides whether they
 * chase Apache, wait, or call someone — and a screen that quietly re-attempts every
 * few seconds hides exactly that. The button reports its own progress and nothing
 * else does.
 *
 * ── IT SHARES `/login`'s FRAME DELIBERATELY ───────────────────────────────────────
 *
 * These are the two screens outside the router shell, and `/login` NAVIGATES here when
 * a verified session cannot be read back — so an operator crosses the seam mid-flow,
 * mid-sign-in, at the worst possible moment to wonder whether they are still in the
 * same application. `AuthShellComponent` is what stops the two drifting apart, and
 * nothing about the outage reasoning above changed with it: still no form, still no
 * auto-retry, still no full-screen spinner.
 */
@Component({
  selector: 'app-service-unavailable-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent, AuthShellComponent],
  template: `
    <app-auth-shell
      eyebrow="Control plane status"
      heading="Not answering"
      lede="It did not answer, or answered with an error."
    >
      <p class="mt-6 text-admin-body text-ink-muted">
        This is not a sign-in problem — nothing was rejected, nothing was changed, and no
        session was ended.
      </p>

      @if (status.requestId(); as requestId) {
        <p
          class="mt-4 rounded-auth-control border border-auth-line bg-surface-sunken px-3.5 py-3
                 text-admin-meta text-ink-muted"
        >
          Request
          <span class="tabular-figures select-all text-ink">{{ requestId }}</span>
          — quote this when reporting it.
        </p>
      } @else {
        <!-- No request id means the request never reached the server: there is no
             server-side log line to correlate with, and saying so is more useful
             than an empty field. -->
        <p class="mt-4 text-admin-meta text-ink-subtle">
          The request did not reach the server, so there is no request id to quote.
        </p>
      }

      <div class="mt-6">
        <app-admin-button
          size="auth"
          variant="primary"
          [block]="true"
          [pending]="!auth.bootstrapped()"
          (pressed)="retry()"
          >Try again</app-admin-button
        >
      </div>
    </app-auth-shell>
  `,
})
export class ServiceUnavailablePage {
  protected readonly status = inject(AdminServiceStatus);
  protected readonly auth = inject(AdminAuthService);
  private readonly store = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * Re-run the one read that decides all three outcomes, and go wherever it lands.
   *
   * Deliberately `bootstrap()` and not a bespoke probe: a probe that succeeded while
   * the real read would have failed is worse than no probe, and this way the recovery
   * path and the cold-start path cannot drift.
   */
  protected async retry(): Promise<void> {
    await this.auth.bootstrap();

    const target = sanitiseReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));

    if (this.store.isAuthenticated()) {
      // The session survived the outage. Straight back to where they were headed.
      await this.router.navigateByUrl(target, { replaceUrl: true });
      return;
    }

    if (!this.status.unavailable()) {
      // The service answered and this operator is signed out. That is a login, not an
      // outage — and now the form CAN work, so sending them to it is honest.
      await this.router.navigate(['/login'], {
        queryParams: { returnUrl: target },
        replaceUrl: true,
      });
      return;
    }

    // Still unavailable. Stay, with a request id refreshed from the latest attempt.
  }
}
