import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { formatEat } from '../core/formatting/time';
import { AdminButtonComponent } from '../ui/button.component';

const NOTE = 'mt-2 max-w-prose text-admin-meta text-ink-subtle';

/**
 * THE ONE-TIME CLAIM-CODE PANEL (Step 2G). Shown after a creation and after a reissue.
 *
 * ── THE CODE IS A BEARER CREDENTIAL, AND THIS IS THE ONLY PLACE IT IS EVER SEEN ────
 *
 * The server persists only a hash of the owner claim token and returns the raw value in
 * exactly one response. So this panel receives it as a plain input from the component
 * that holds it in TRANSIENT state, renders it to the authenticated operator, offers a
 * clipboard copy, and does nothing else with it: no storage, no URL, no navigation
 * state, no log, no notice, no analytics. Leaving the screen loses it, and the panel
 * says so rather than pretending it can be fetched later — the supported recovery is a
 * REISSUE from the restaurant's Readiness tab, which rotates the credential.
 *
 * ── NOTHING HERE IS SENT ─────────────────────────────────────────────────────────
 *
 * Phase 1 hand-off is operator-mediated: the operator gives the code to the owner
 * themselves, and the owner types it into the restaurant portal's owner-claim screen.
 * The copy therefore says ISSUED and never sent, delivered or resent, and it fabricates
 * no link — a token is a credential, a URL would be a product promise the platform
 * cannot keep, and the customer portal's claim screen takes a pasted CODE.
 *
 * ── AND NOTHING HERE ESTABLISHES OWNER CONTROL ──────────────────────────────────
 *
 * Issuing a code proves nothing about the owner. Control is established only when the
 * owner redeems it, and the workspace reports that from the canonical projection.
 *
 * ── IT IS PRESENTATIONAL ─────────────────────────────────────────────────────────
 *
 * The primary action is PROJECTED by the parent (`<ng-content />`): after a creation it
 * is a real navigation to the new restaurant's workspace, after a reissue it is a Done
 * button that clears the code. The panel itself owns only the copy affordance.
 */
@Component({
  selector: 'app-owner-claim-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent],
  template: `
    <section
      class="mt-4 rounded border border-line-strong bg-surface-sunken p-4"
      aria-labelledby="owner-claim-code-heading"
      data-claim-code-panel
    >
      <h3 id="owner-claim-code-heading" class="text-admin-section text-ink">{{ heading() }}</h3>

      @if (intro(); as copy) {
        <p class="mt-1 max-w-prose text-admin-body text-ink-muted">{{ copy }}</p>
      }

      <label class="mt-3 flex flex-col gap-1">
        <span class="text-admin-label text-ink">Owner claim code</span>
        <span class="flex flex-wrap items-center gap-2">
          <!-- A READONLY INPUT rather than prose, so the whole value can be selected
               with one click and copied by hand when the clipboard API is unavailable.
               No autocomplete and no spellcheck: a credential must not be offered
               back by the browser later. -->
          <input
            type="text"
            readonly
            autocomplete="off"
            spellcheck="false"
            [value]="claimToken()"
            (focus)="selectAll($event)"
            class="min-w-0 flex-1 rounded bg-surface px-2 py-1.5 text-admin-body text-ink
                   tabular-figures tracking-wide ring-1 ring-inset ring-line-strong"
            data-claim-code
          />
          <app-admin-button variant="secondary" (pressed)="copy()" data-claim-copy
            >Copy code</app-admin-button
          >
        </span>
      </label>
      <p class="mt-1 text-admin-meta text-ink-subtle" role="status" aria-live="polite">
        @switch (copyState()) {
          @case ('copied') {
            Copied to the clipboard.
          }
          @case ('failed') {
            The clipboard could not be used. Select the code and copy it by hand.
          }
          @default {}
        }
      </p>

      @if (issuedLine(); as line) {
        <p class="mt-2 text-admin-meta text-ink-subtle" data-claim-code-window>{{ line }}</p>
      }

      <!-- Warning hue on wording that stands without it (§22): this is "careful", not
           "broken". The sentence states the consequence exactly — no retrieval exists,
           on this side or the server's — and names the one supported recovery. -->
      <p class="mt-3 max-w-prose text-admin-body text-admin-warning" data-claim-code-warning>
        Shown once. This code cannot be retrieved after you leave this screen — Dinify Admin
        does not keep it, and the server keeps only a hash. If it is lost, or if the response
        that carried it never arrived, reissue a new code from the restaurant’s Readiness
        tab; the old one stops working.
      </p>

      <p [class]="note">
        Hand the code to the owner yourself; Dinify does not deliver it. The owner enters it
        on the restaurant portal’s Claim your restaurant screen (/owner-claim), verifies
        their phone number, and chooses a password if the account is new.
      </p>

      <p [class]="note">
        Issuing a code does not establish owner control. The restaurant reports owner control
        as established only once the owner has redeemed it.
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <ng-content />
      </div>
    </section>
  `,
})
export class OwnerClaimCodeComponent {
  /** "Restaurant created", "Claim code reissued". */
  readonly heading = input.required<string>();
  /** THE RAW CREDENTIAL. Rendered, copied, and never handed on. */
  readonly claimToken = input.required<string>();
  /** One sentence of context from the parent, or none. */
  readonly intro = input<string | null>(null);
  readonly issuedAt = input<string | null>(null);
  readonly expiresAt = input<string | null>(null);

  protected readonly note = NOTE;
  protected readonly copyState = signal<'idle' | 'copied' | 'failed'>('idle');

  protected readonly issuedLine = computed(() => {
    const issued = this.issuedAt();
    const expires = this.expiresAt();
    if (!issued && !expires) return null;
    const parts: string[] = [];
    if (issued) parts.push(`Issued ${formatEat(issued)}`);
    if (expires) parts.push(`Expires ${formatEat(expires)}`);
    return parts.join(' · ');
  });

  protected selectAll(event: FocusEvent): void {
    (event.target as HTMLInputElement).select();
  }

  /**
   * Clipboard copy of the EXACT value, and nothing else.
   *
   * `navigator.clipboard` is absent outside a secure context and its promise rejects
   * when the document is not focused, so both are reported as a failure the operator
   * can act on — the readonly input above is the manual path — rather than as a
   * silent success that leaves them pasting nothing.
   */
  protected async copy(): Promise<void> {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      this.copyState.set('failed');
      return;
    }
    try {
      await clipboard.writeText(this.claimToken());
      this.copyState.set('copied');
    } catch {
      this.copyState.set('failed');
    }
  }
}
