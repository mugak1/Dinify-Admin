import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { extractErrorMessage } from '../core/api/error-message';
import { classifyTransportFailure, extractRequestId } from '../core/api/transport-failure';
import { AdminAuthService, PostVerifyReadError } from '../core/auth/admin-auth.service';
import { sanitiseReturnUrl } from '../core/auth/return-url';
import { SecondFactorMethod } from '../core/auth/session.model';
import { AuthShellComponent } from '../shell/auth-shell.component';
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
 * THE REDESIGN DID NOT TOUCH THAT. The server's sentence is still rendered as it
 * arrives, into one element, with no icon, prefix, suffix or severity word wrapped
 * around it that could turn "Invalid credentials." into a narrower claim. A styled
 * error block is where copy quietly grows helpful.
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
 * was typed: nothing was rejected, so nothing should behave as though it was. It is
 * also rendered in the WARNING hue, never the danger one, and never as a field error:
 * "careful, this is not answering" and "what you typed was refused" are different
 * statements and must not look alike.
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
 *
 * ── THE LOCKUP SAYS ADMIN, AND THAT IS LOAD-BEARING ───────────────────────────────
 *
 * This screen shares its environment and its type hierarchy with Dinify-Frontend's
 * sign-in, which is a deliberate change from the bare dark form it replaced (see
 * `AuthShellComponent`). What keeps the two apart at the moment it matters — an
 * operator with both portals open, about to type credentials — is the word ADMIN in
 * the lockup, the eyebrow naming the control plane, and the browser tab title. None
 * of the three is decorative; do not quietly drop one for balance.
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, AdminButtonComponent, AuthShellComponent],
  template: `
    <app-auth-shell [eyebrow]="eyebrow()" [heading]="heading()" [lede]="lede()">
      @if (step() === 'credentials') {
        <form class="mt-7" (ngSubmit)="submitCredentials()">
          <div class="group/field">
            <label [class]="labelClasses" for="username">Username</label>
            <div [class]="fieldShell">
              <span [class]="gutter" aria-hidden="true">
                <!-- Inline SVG. No icon package anywhere in this repo — see CLAUDE.md. -->
                <svg
                  class="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="12" cy="8.5" r="3.5" />
                  <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                </svg>
              </span>
              <input
                id="username"
                name="username"
                type="text"
                autocomplete="username"
                spellcheck="false"
                data-focus-ring="self"
                [class]="fieldInput"
                [(ngModel)]="username"
                [disabled]="pending()"
              />
            </div>
          </div>

          <div class="group/field mt-4">
            <label [class]="labelClasses" for="password">Password</label>
            <div [class]="fieldShell">
              <span [class]="gutter" aria-hidden="true">
                <svg
                  class="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
                  <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                </svg>
              </span>
              <!-- The input spans the full interior and pads itself clear of both
                   gutters, so the browser's autofill fill reaches the border rather
                   than stopping at an inset box. The icon and the reveal control are
                   painted over it on transparent backgrounds. -->
              <input
                id="password"
                name="password"
                [type]="revealPassword() ? 'text' : 'password'"
                autocomplete="current-password"
                data-focus-ring="self"
                [class]="fieldInput + ' pr-auth-gutter'"
                [(ngModel)]="password"
                [disabled]="pending()"
              />
              <button
                type="button"
                class="relative z-10 ml-auto flex h-full w-auth-gutter items-center justify-center
                       bg-transparent text-ink-subtle transition-colors hover:text-ink"
                [attr.aria-label]="revealPassword() ? 'Hide password' : 'Show password'"
                (click)="toggleReveal()"
              >
                @if (revealPassword()) {
                  <svg
                    class="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M3 3l18 18" />
                    <path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" />
                    <path d="M9.4 5.2A9.3 9.3 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.4 4.1" />
                    <path d="M6.2 6.7A17 17 0 0 0 2 12s3.6 7 10 7a9.4 9.4 0 0 0 3-.5" />
                  </svg>
                } @else {
                  <svg
                    class="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                }
              </button>
            </div>
          </div>

          @if (message(); as text) {
            <p role="alert" [class]="refusal">{{ text }}</p>
          }
          @if (unreachable(); as outage) {
            <ng-container
              [ngTemplateOutlet]="outageNotice"
              [ngTemplateOutletContext]="{ $implicit: outage }"
            />
          }

          <div class="mt-6">
            <app-admin-button
              size="auth"
              variant="primary"
              type="submit"
              [block]="true"
              [pending]="pending()"
            >
              {{ pending() ? 'Checking' : 'Continue' }}
              @if (!pending()) {
                <ng-container [ngTemplateOutlet]="advance" />
              }
            </app-admin-button>
          </div>
        </form>
      } @else {
        @if (recoveryOnly()) {
          <!-- The break-glass branch. Prompting for TOTP here would be refused as an
               ordinary bad code, and the operator would have no way to know why. The
               explanation sits in the shell's lede; this states the CONSEQUENCE. -->
          <p class="mt-5 rounded-auth-control bg-admin-warning-soft px-4 py-3 text-admin-body text-ink">
            A one-time recovery code will sign you in and clear the lock. It cannot be
            used again.
          </p>
        }

        <form class="mt-7" (ngSubmit)="submitSecondFactor()">
          <div class="group/field">
            <label [class]="labelClasses" for="code">
              {{ method() === 'totp' ? 'Six-digit code' : 'Recovery code' }}
            </label>
            <div [class]="fieldShell">
              <span [class]="gutter" aria-hidden="true">
                <svg
                  class="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="8" cy="12" r="3.2" />
                  <path d="M11.2 12H20" />
                  <path d="M17 12v3" />
                  <path d="M20 12v2.5" />
                </svg>
              </span>
              <input
                id="code"
                name="code"
                type="text"
                autocomplete="one-time-code"
                spellcheck="false"
                data-focus-ring="self"
                [class]="fieldInput + ' tabular-figures'"
                [(ngModel)]="code"
                [disabled]="pending()"
              />
            </div>
          </div>

          @if (!recoveryOnly()) {
            <!-- Sits where the restaurant portal's "Forgot password?" sits, and reads
                 the same way: a quiet secondary route out of the field above. It is a
                 real button, not a link — it changes what this challenge is asking
                 for, and it navigates nowhere. The underline arrives on hover so the
                 affordance is never carried by colour alone (§22). -->
            <div class="mt-2.5 flex justify-end">
              <button
                type="button"
                class="text-auth-label text-ink-muted transition-colors
                       hover:text-admin-accent-ink hover:underline"
                (click)="toggleMethod()"
              >
                {{
                  method() === 'totp'
                    ? 'Use a recovery code instead'
                    : 'Use your authenticator instead'
                }}
              </button>
            </div>
          }

          @if (message(); as text) {
            <p role="alert" [class]="refusal">{{ text }}</p>
          }
          @if (unreachable(); as outage) {
            <ng-container
              [ngTemplateOutlet]="outageNotice"
              [ngTemplateOutletContext]="{ $implicit: outage }"
            />
          }

          <div class="mt-6">
            <app-admin-button
              size="auth"
              variant="primary"
              type="submit"
              [block]="true"
              [pending]="pending()"
            >
              {{ pending() ? 'Verifying' : 'Sign in' }}
              @if (!pending()) {
                <ng-container [ngTemplateOutlet]="advance" />
              }
            </app-admin-button>
          </div>
        </form>
      }
    </app-auth-shell>

    <!-- One definition, both steps — the same reason the outage notice below is a
         template. The nudge is driven by the button's own group/btn scope, so the
         page never reaches inside AdminButtonComponent to animate it. -->
    <ng-template #advance>
      <svg
        class="h-4 w-4 transition-transform duration-200 group-hover/btn:translate-x-0.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </svg>
    </ng-template>

    <!-- AMBER, NOT RED. §16 separates "careful" from "something was refused", and
         nothing was refused here. Shared by both steps so the two cannot drift. -->
    <ng-template #outageNotice let-outage>
      <div
        role="alert"
        class="mt-4 flex items-start gap-3 rounded-auth-control border border-admin-warning/25
               bg-admin-warning-soft px-3.5 py-3 shadow-auth-notice"
      >
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-auth-control
                 bg-surface text-admin-warning"
          aria-hidden="true"
        >
          <svg
            class="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5" />
            <path d="M12 16h.01" />
          </svg>
        </span>
        <div class="min-w-0 text-left">
          <p class="text-admin-body text-ink">
            The admin control plane is not answering. Nothing was rejected — this is not a
            sign-in failure, and your credentials have not been tried.
          </p>
          @if (outage.requestId) {
            <p class="mt-1 text-admin-meta text-ink-muted">
              Request <span class="tabular-figures select-all">{{ outage.requestId }}</span>
            </p>
          }
        </div>
      </div>
    </ng-template>
  `,
})
export class LoginPage {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * The field shell owns the border, the radius and the focus treatment; the input
   * inside it is transparent and outline-free (`data-focus-ring="self"` opts out of
   * the global `:focus-visible` outline, which would otherwise draw a second ring
   * inside this one). Written once as constants because three fields share them and a
   * fourth would otherwise be styled by copy-paste.
   */
  protected readonly labelClasses =
    'mb-1.5 block text-auth-label text-ink-muted transition-colors ' +
    'group-focus-within/field:text-admin-accent-ink';

  protected readonly fieldShell =
    'group/ctrl relative flex h-auth-field items-center rounded-auth-control ' +
    'border border-auth-line bg-surface transition-all duration-200 ' +
    'focus-within:border-admin-accent focus-within:ring-4 focus-within:ring-admin-accent/20 ' +
    'focus-within:shadow-auth-field';

  protected readonly gutter =
    'pointer-events-none relative z-10 flex h-full w-auth-gutter items-center justify-center ' +
    'bg-transparent text-auth-quiet transition-colors group-focus-within/ctrl:text-admin-accent';

  protected readonly fieldInput =
    'absolute inset-0 h-full w-full rounded-auth-control border-0 bg-transparent ' +
    'pl-12 pr-3.5 text-auth-field text-ink outline-none placeholder:text-auth-quiet';

  /**
   * The server's refusal, verbatim. `--admin-danger` rather than the accent (§16: this
   * is "something was refused", not "do this"), and never the warning hue, which the
   * outage notice owns.
   */
  protected readonly refusal = 'mt-4 text-admin-body text-admin-danger';

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
  /** Presentation only: the password field's masking. Never persisted anywhere. */
  protected readonly revealPassword = signal(false);
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

  /**
   * The heading trio the shell renders.
   *
   * The eyebrow NAMES THE PLANE on step 1 — it is the line an operator reads before
   * typing, and the reason this screen can share an environment with the restaurant
   * portal's sign-in without the two becoming confusable. Step 2 swaps it for the
   * state the challenge is actually in, because by then the plane is settled and what
   * matters is which credential is being asked for.
   */
  protected readonly eyebrow = computed(() => {
    if (this.step() === 'credentials') return 'Platform control plane';
    return this.recoveryOnly() ? 'Account locked' : 'Second factor';
  });

  protected readonly heading = computed(() => {
    if (this.step() === 'credentials') return 'Sign in';
    return this.recoveryOnly() ? 'Enter a recovery code' : 'Enter your code';
  });

  protected readonly lede = computed(() => {
    if (this.step() === 'credentials') return 'Password first, then your second factor.';
    // Says what to reach for, and nothing about the account: the uniform failure
    // message above is only a disclosure control if the copy around it is too.
    return this.recoveryOnly()
      ? 'This account is locked. A recovery code is the way back in.'
      : 'From your authenticator app.';
  });

  protected toggleReveal(): void {
    this.revealPassword.update((shown) => !shown);
  }

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
    // The field is rebuilt masked. Carrying a reveal across a reset would leave a
    // password visible on a screen the operator did not expect to be back on.
    this.revealPassword.set(false);
    this.failures.set(0);
    this.unreachable.set(null);
    this.message.set(text);
  }
}
