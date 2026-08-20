import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ElevationService } from '../core/auth/elevation.service';
import { AdminButtonComponent } from './button.component';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The re-elevation prompt.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────
 *
 * A valid session proves the operator authenticated some time in the last eight
 * hours. The actions with the largest blast radius — lifecycle transitions,
 * delegation minting, mark-paid — require a second factor cleared within the last few
 * minutes, so a walked-away-from browser cannot be used to do the irreversible
 * things. That refusal arrives as a 403 mid-action, and the failure mode being
 * designed out is: click Suspend, get a mysterious 403, lose what you were doing.
 * This asks for the factor and the original request is replayed.
 *
 * ── ACCESSIBILITY, WITHOUT @angular/cdk ───────────────────────────────────────────
 *
 * There is no CDK in this repo (three primitives do not justify it), so the dialog
 * mechanics are implemented here rather than skipped. A badly focus-trapped modal is
 * an accessibility defect, and this one gates every consequential action in the
 * portal:
 *
 *   - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` — it is announced as
 *     a dialog with a name, not as an anonymous region;
 *   - focus moves INTO the dialog on open and Tab/Shift+Tab cycle within it, so a
 *     keyboard operator cannot wander into the page behind;
 *   - focus is RESTORED to whatever was focused before it opened, so dismissing it
 *     puts the operator back where they were;
 *   - Escape cancels, which fails every queued request with an explicit cancelled
 *     state rather than leaving them hanging.
 *
 * ── ONE MODAL, HOWEVER MANY REQUESTS ──────────────────────────────────────────────
 *
 * `ElevationService` is a singleton with a queue, so three concurrent refusals show
 * ONE prompt and replay all three on success. `waiting` is surfaced when it is more
 * than one so the operator knows what is about to resume.
 */
@Component({
  selector: 'app-elevation-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, AdminButtonComponent],
  template: `
    @if (elevation.isOpen()) {
      <!-- The backdrop is INERT. Click-to-dismiss was removed deliberately, not to
           satisfy a lint rule: a stray click outside this dialog would cancel an
           elevation that has real requests queued behind it, and this is the prompt
           standing between the operator and a consequential write. Dismissal is
           explicit — the Cancel button, or Escape. -->
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-chrome/60 p-4">
        <div
          #dialog
          role="dialog"
          aria-modal="true"
          aria-labelledby="elevation-title"
          aria-describedby="elevation-description"
          class="w-full max-w-sm rounded-lg bg-surface p-5 shadow-admin-lg"
          (keydown)="onKeydown($event)"
        >
          <h2 id="elevation-title" class="text-admin-section text-ink">Confirm it is you</h2>
          <p id="elevation-description" class="mt-1 text-admin-body text-ink-muted">
            <!-- ONE SENTENCE, TWO TRUTHS. Telling an operator who just chose
                 Re-authenticate that "this action needs a second factor" describes an
                 action they have not taken yet — and the whole point of the
                 deliberate path is to clear the window BEFORE starting one. -->
            @if (elevation.reason() === 'deliberate') {
              Confirming now opens the re-authentication window, so the next
              consequential action will not stop to ask.
            } @else {
              This action needs a second factor from the last few minutes.
            }
            @if (elevation.waiting() > 1) {
              {{ elevation.waiting() }} requests are waiting.
            }
          </p>

          <!-- The method is EXPLICIT and always sent. The backend removed
               try-TOTP-then-fall-back-to-recovery, because TOTP decrypts the stored
               secret before it can reject a code and the crypto layer fails closed —
               so one lost key took the recovery codes down with it. -->
          <div class="mt-4 flex gap-1 rounded bg-surface-sunken p-1" role="group" aria-label="Second factor">
            <button
              type="button"
              class="h-8 flex-1 rounded-sm text-admin-label transition-colors"
              [class]="elevation.method() === 'totp' ? activeTab : idleTab"
              [attr.aria-pressed]="elevation.method() === 'totp'"
              (click)="elevation.setMethod('totp')"
            >
              Authenticator
            </button>
            <button
              type="button"
              class="h-8 flex-1 rounded-sm text-admin-label transition-colors"
              [class]="elevation.method() === 'recovery' ? activeTab : idleTab"
              [attr.aria-pressed]="elevation.method() === 'recovery'"
              (click)="elevation.setMethod('recovery')"
            >
              Recovery code
            </button>
          </div>

          <label class="mt-4 block text-admin-label text-ink-muted" for="elevation-code">
            {{ elevation.method() === 'totp' ? 'Six-digit code' : 'Recovery code' }}
          </label>
          <input
            id="elevation-code"
            #codeField
            type="text"
            name="code"
            autocomplete="one-time-code"
            spellcheck="false"
            class="mt-1 h-control w-full rounded bg-surface px-3 text-admin-body text-ink
                   ring-1 ring-inset ring-line-strong"
            [(ngModel)]="code"
            [disabled]="elevation.submitting()"
          />

          @if (elevation.error(); as message) {
            <!-- The server's message, VERBATIM. Every second-factor failure returns
                 one byte-identical message by design — a wrong code, the wrong method
                 for the code, an unknown method and an unusable encryption key are
                 deliberately indistinguishable. Interpreting or elaborating on it
                 would undo a disclosure control. -->
            <p role="alert" class="mt-2 text-admin-meta text-admin-danger">{{ message }}</p>
          }

          <div class="mt-5 flex justify-end gap-2">
            <app-admin-button variant="ghost" (pressed)="elevation.cancel()">Cancel</app-admin-button>
            <app-admin-button
              variant="primary"
              [pending]="elevation.submitting()"
              (pressed)="submit()"
              >Confirm</app-admin-button
            >
          </div>
        </div>
      </div>
    }
  `,
})
export class ElevationDialogComponent {
  protected readonly elevation = inject(ElevationService);
  protected code = '';

  protected readonly activeTab = 'bg-surface text-ink shadow-admin-sm';
  protected readonly idleTab = 'text-ink-muted hover:text-ink';

  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly codeField = viewChild<ElementRef<HTMLInputElement>>('codeField');
  /** Whatever had focus before the dialog opened, so it can be handed back. */
  private readonly restoreTo = signal<HTMLElement | null>(null);

  constructor() {
    effect(() => {
      if (this.elevation.isOpen()) {
        const active = document.activeElement;
        this.restoreTo.set(active instanceof HTMLElement ? active : null);
        this.code = '';
        // One microtask so the dialog is in the DOM before focus moves into it.
        queueMicrotask(() => this.codeField()?.nativeElement.focus());
      } else {
        const target = this.restoreTo();
        this.restoreTo.set(null);
        queueMicrotask(() => target?.focus());
      }
    });
  }

  protected submit(): void {
    this.elevation.submit(this.code);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.elevation.cancel();
      return;
    }
    if (event.key === 'Enter' && !this.elevation.submitting()) {
      event.preventDefault();
      this.submit();
      return;
    }
    if (event.key !== 'Tab') return;

    // The trap. Without it, Tab walks straight out of a modal that is gating a
    // consequential write, and the operator is typing into a page they cannot see.
    const host = this.dialog()?.nativeElement;
    if (!host) return;

    const focusable = Array.from(host.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null,
    );
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !host.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
