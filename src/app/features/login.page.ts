import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { extractErrorMessage } from '../core/api/error-message';
import { classifyTransportFailure, extractRequestId } from '../core/api/transport-failure';
import { AdminAuthService, PostVerifyReadError } from '../core/auth/admin-auth.service';
import { sanitiseReturnUrl } from '../core/auth/return-url';
import { SecondFactorMethod } from '../core/auth/session.model';
import { AdminButtonComponent } from '../ui/button.component';

type Step = 'credentials' | 'second-factor';

/**
 * Sign in. ONE ROUTE, TWO STATES — deliberately not two routes.
 *
 * The challenge cookie is `__Host-` prefixed, HttpOnly and lives five minutes, so
 * this application CANNOT INSPECT IT. A second route would therefore have no way to
 * know, on a refresh, whether the challenge it is standing on is still alive — it
 * would render a code field for a challenge that expired, and the operator would only
 * discover it by failing. Keeping both states in one component means a refresh
 * unambiguously returns to step 1, which is always correct.
 *
 * ── THE UNIFORM FAILURE MESSAGE IS A DISCLOSURE CONTROL ───────────────────────────
 *
 * Every login and verify failure returns ONE byte-identical body. Unknown user, wrong
 * password, not platform staff, inactive, unenrolled, holding a restaurant
 * membership, and locked out are all indistinguishable — and the password check runs
 * against a dummy hash for unknown users so the response TIME does not leak account
 * existence either. The real reason goes to the audit log.
 *
 * So this component displays the server's message VERBATIM. It does not interpret it,
 * elaborate on it, add client-side hints, or offer "did you mean" help. Doing any of
 * those would hand back exactly the distinction the backend spent effort removing.
 *
 * ── A DEAD BACKEND IS NOT A WRONG PASSWORD ────────────────────────────────────────
 *
 * The uniform message has one failure mode, and it is this: when the service does not
 * answer at all, `extractErrorMessage` finds nothing to read (a `ProgressEvent` has no
 * `detail`, and an Apache error page is discarded as markup) and falls back to
 * "Invalid credentials." — the disclosure control answering confidently about a
 * situation it knows nothing about, while the operator retypes a password that was
 * never wrong.
 *
 * So every failure here is classified for TRANSPORT first. An unreachable service says
 * so, in its own words, and it does NOT count toward the retry budget or clear what
 * was typed: nothing was rejected, so nothing should behave as though it was.
 *
 * ── BREAK-GLASS ───────────────────────────────────────────────────────────────────
 *
 * `login/` answers 200 with `recovery_code_required: true` when the account is LOCKED
 * OUT and the password was correct. That challenge accepts a RECOVERY CODE ONLY — a
 * TOTP code is refused as an ordinary bad code. Honouring the flag is what makes a
 * lockout clearable from the portal; without it the only way back in is
 * `manage.py unlock_platform_admin` on the box, which defeats having a portal at all.
 * An attacker cannot ride this path: it needs the password AND a one-shot recovery
 * code.
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, AdminButtonComponent],
  template: `
    <div class="flex min-h-screen items-center justify-center bg-chrome p-4">
      <main class="w-full max-w-sm rounded-lg bg-surface p-6 shadow-admin-lg">
        <div class="flex items-center gap-2">
          <span
            class="flex h-5 w-5 items-center justify-center rounded-sm bg-admin-accent
                   text-admin-micro text-admin-accent-fg"
            aria-hidden="true"
            >D</span
          >
          <span class="text-admin-label text-ink">Dinify Admin</span>
        </div>

        @if (step() === 'credentials') {
          <h1 class="mt-5 text-admin-section text-ink">Sign in</h1>
          <form (ngSubmit)="submitCredentials()">
            <label class="mt-4 block text-admin-label text-ink-muted" for="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              autocomplete="username"
              spellcheck="false"
              [class]="field"
              [(ngModel)]="username"
              [disabled]="pending()"
            />

            <label class="mt-3 block text-admin-label text-ink-muted" for="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              [class]="field"
              [(ngModel)]="password"
              [disabled]="pending()"
            />

            @if (message(); as text) {
              <p role="alert" class="mt-3 text-admin-meta text-admin-danger">{{ text }}</p>
            }
            @if (unreachable(); as outage) {
              <ng-container [ngTemplateOutlet]="outageNotice" [ngTemplateOutletContext]="{ $implicit: outage }" />
            }

            <div class="mt-5">
              <app-admin-button variant="primary" type="submit" [block]="true" [pending]="pending()"
                >Continue</app-admin-button
              >
            </div>
          </form>
        } @else {
          <h1 class="mt-5 text-admin-section text-ink">
            {{ recoveryOnly() ? 'Enter a recovery code' : 'Enter your code' }}
          </h1>

          @if (recoveryOnly()) {
            <!-- The break-glass branch. Prompting for TOTP here would be refused as an
                 ordinary bad code, and the operator would have no way to know why. -->
            <p class="mt-1 text-admin-body text-ink-muted">
              This account is locked. A one-time recovery code will sign you in and clear the
              lock.
            </p>
          } @else {
            <p class="mt-1 text-admin-body text-ink-muted">
              From your authenticator app.
            </p>
          }

          <form (ngSubmit)="submitSecondFactor()">
            <label class="mt-4 block text-admin-label text-ink-muted" for="code">
              {{ method() === 'totp' ? 'Six-digit code' : 'Recovery code' }}
            </label>
            <input
              id="code"
              name="code"
              type="text"
              autocomplete="one-time-code"
              spellcheck="false"
              [class]="field"
              [(ngModel)]="code"
              [disabled]="pending()"
            />

            @if (!recoveryOnly()) {
              <button
                type="button"
                class="mt-2 text-admin-meta text-ink-muted underline hover:text-ink"
                (click)="toggleMethod()"
              >
                {{
                  method() === 'totp'
                    ? 'Use a recovery code instead'
                    : 'Use your authenticator instead'
                }}
              </button>
            }

            @if (message(); as text) {
              <p role="alert" class="mt-3 text-admin-meta text-admin-danger">{{ text }}</p>
            }
            @if (unreachable(); as outage) {
              <ng-container [ngTemplateOutlet]="outageNotice" [ngTemplateOutletContext]="{ $implicit: outage }" />
            }

            <div class="mt-5">
              <app-admin-button variant="primary" type="submit" [block]="true" [pending]="pending()"
                >Sign in</app-admin-button
              >
            </div>
          </form>
        }
      </main>
    </div>

    <!-- AMBER, NOT RED. §16 separates "careful" from "something was refused", and
         nothing was refused here. Shared by both steps so the two cannot drift. -->
    <ng-template #outageNotice let-outage>
      <div role="alert" class="mt-3 rounded bg-admin-warning-soft px-3 py-2">
        <p class="text-admin-meta text-ink">
          The admin control plane is not answering. Nothing was rejected — this is not a
          sign-in failure, and your credentials have not been tried.
        </p>
        @if (outage.requestId) {
          <p class="mt-1 text-admin-meta text-ink-muted">
            Request <span class="tabular-figures select-all">{{ outage.requestId }}</span>
          </p>
        }
      </div>
    </ng-template>
  `,
})
export class LoginPage {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly field =
    'mt-1 h-control w-full rounded bg-surface px-3 text-admin-body text-ink ' +
    'ring-1 ring-inset ring-line-strong';

  protected username = '';
  protected password = '';
  protected code = '';

  protected readonly step = signal<Step>('credentials');
  protected readonly pending = signal(false);
  protected readonly message = signal<string | null>(null);
  /**
   * Set when the last attempt got no usable answer. Separate from `message` because it
   * is a statement about the SERVICE, not about what the operator typed — and because
   * the two must never be shown as the same kind of thing.
   */
  protected readonly unreachable = signal<{ requestId: string | null } | null>(null);
  /** True when the server said this challenge takes a recovery code and nothing else. */
  protected readonly recoveryOnly = signal(false);
  private readonly chosenMethod = signal<SecondFactorMethod>('totp');
  /**
   * How many second-factor attempts have failed against THIS challenge.
   *
   * A failure may mean a wrong code, an expired challenge (5 minutes) or an exhausted
   * attempt budget, and the uniform message deliberately cannot tell them apart. One
   * retry covers a mistyped code; a second failure is far more likely to mean the
   * challenge is dead, so the operator is returned to step 1 cleanly rather than left
   * typing into something that can no longer succeed.
   */
  private readonly failures = signal(0);

  /** A recovery-only challenge fixes the method; otherwise the operator chooses. */
  protected readonly method = computed<SecondFactorMethod>(() =>
    this.recoveryOnly() ? 'recovery' : this.chosenMethod(),
  );

  protected toggleMethod(): void {
    if (this.pending() || this.recoveryOnly()) return;
    this.chosenMethod.update((current) => (current === 'totp' ? 'recovery' : 'totp'));
    this.clearFeedback();
  }

  protected async submitCredentials(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.clearFeedback();

    try {
      const result = await this.auth.login(this.username.trim(), this.password);
      this.recoveryOnly.set(result.recovery_code_required);
      this.chosenMethod.set(result.recovery_code_required ? 'recovery' : 'totp');
      this.code = '';
      this.failures.set(0);
      this.step.set('second-factor');
    } catch (error) {
      // TRANSPORT FIRST. Without this the fallback below answers a 502 with
      // "Invalid credentials." — see the class comment.
      if (classifyTransportFailure(error) === 'unavailable') {
        this.reportUnreachable(error);
        return;
      }
      // Verbatim. See the class comment.
      this.message.set(extractErrorMessage(error, 'Invalid credentials.'));
    } finally {
      this.pending.set(false);
    }
  }

  protected async submitSecondFactor(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.clearFeedback();

    try {
      await this.auth.verify(this.method(), this.code.trim());

      // The recovery-code and lockout facts are recorded by `AdminAuthService` into
      // the notice channel, which OUTLIVES this component — the navigation below
      // destroys it within the tick, so anything rendered here would never be read.
      // They used to go to `console.warn`, which is the same outcome with extra steps.

      // VALIDATED ON THE WAY OUT. `returnUrl` can arrive from a hand-crafted link, so
      // anything with a scheme, anything protocol-relative and anything that is not a
      // single-slash relative path falls back to `/`. An open redirect on the control
      // plane's login page would bounce a just-authenticated platform administrator
      // onto an attacker's page.
      const target = sanitiseReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
      await this.router.navigateByUrl(target, { replaceUrl: true });
    } catch (error) {
      // THE FACTOR WAS ACCEPTED AND THE SESSION COOKIE IS LIVE FOR EIGHT HOURS. The
      // one thing this must not do is tell the operator their code was rejected.
      if (error instanceof PostVerifyReadError) {
        await this.handlePostVerifyReadFailure(error);
        return;
      }

      // Nothing was rejected, so nothing is spent: no failure counted, no code
      // cleared, no return to step 1 for a challenge that is still perfectly alive.
      if (classifyTransportFailure(error) === 'unavailable') {
        this.reportUnreachable(error);
        return;
      }

      this.failures.update((count) => count + 1);
      const text = extractErrorMessage(error, 'Invalid or expired verification.');

      if (this.failures() >= 2) {
        // Second failure: the challenge is probably dead (expired, or out of
        // attempts). Start again rather than stranding the operator on it.
        this.resetToCredentials(text);
      } else {
        this.message.set(text);
        this.code = '';
      }
    } finally {
      this.pending.set(false);
    }
  }

  /**
   * The second factor cleared, the server minted a session — and the read back failed
   * twice (`AdminAuthService.verify` already retried it once).
   *
   * Neither branch returns the operator to step 2. The challenge cookie was cleared by
   * the successful verify, so a "retry" there can only fail, which is exactly how the
   * old behaviour walked them to step 1 with a message about a code that was fine.
   */
  private async handlePostVerifyReadFailure(error: PostVerifyReadError): Promise<void> {
    if (error.failure === 'unavailable') {
      // A live session and an unreachable service: signing in again is not what they
      // need. The unavailable view's retry re-runs the same read, and when the service
      // returns it adopts THIS session and lands them in the shell.
      await this.router.navigate(['/unavailable'], { replaceUrl: true });
      return;
    }

    // The service answered but would not hand back the session — rare, and not
    // something a second factor can fix. Signing in again is the honest instruction,
    // and it works: `login/` mints a fresh challenge regardless of the live cookie.
    this.resetToCredentials(
      'Signed in, but the session could not be read back. Please sign in again.',
    );
  }

  /** A statement about the SERVICE. Never touches what the operator typed. */
  private reportUnreachable(error: unknown): void {
    this.unreachable.set({ requestId: extractRequestId(error) });
  }

  private clearFeedback(): void {
    this.message.set(null);
    this.unreachable.set(null);
  }

  private resetToCredentials(text: string): void {
    this.step.set('credentials');
    this.recoveryOnly.set(false);
    this.chosenMethod.set('totp');
    this.code = '';
    this.password = '';
    this.failures.set(0);
    this.unreachable.set(null);
    this.message.set(text);
  }
}
