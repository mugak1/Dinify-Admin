import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from '../core/api/api.constants';
import { AdminButtonComponent } from '../ui/button.component';

/**
 * One choice on one commercial axis.
 *
 * `note` is what the option MEANS and is always shown. `warning` is shown only while
 * that option is SELECTED, and exists for the one case where an operator needs to know
 * something before committing — see `psp_online` in `restaurant-tabs.pages.ts`.
 */
export interface CommercialAxisOption {
  readonly value: string;
  readonly label: string;
  readonly note: string;
  readonly warning?: string;
}

/** What the parent is asked to submit. The parent owns the concurrency token. */
export interface CommercialAxisSubmission {
  readonly value: string;
  readonly reason: string;
}

const PANEL_LABEL = 'text-admin-label text-ink';
const NOTE = 'text-admin-meta text-ink-subtle';

/**
 * THE INLINE SERVICE-CONFIGURATION EDITOR (Step 3E.2).
 *
 * ── WHY IT IS INLINE AND NOT A MODAL ──────────────────────────────────────────────
 *
 * The elevation dialog is already a modal, and these writes are elevation-gated — so a
 * modal editor would routinely have a second modal stacked on top of it, with the
 * operator's half-written reason hidden behind a TOTP prompt. Editing in place keeps
 * them anchored to the restaurant they are changing, and lets the global elevation
 * dialog appear over the whole screen exactly as it does everywhere else.
 *
 * ── IT IS PRESENTATIONAL, AND THAT BOUNDARY IS LOAD-BEARING ───────────────────────
 *
 * It renders options, collects a choice and a reason, and emits them. It does NOT know
 * which axis it is editing, hold a concurrency token, call an API, interpret a status
 * code, or decide what happens on success. All of that lives in the Overview tab, which
 * owns the two axes explicitly.
 *
 * That split is deliberate rather than tidy: a component that both collected a reason
 * AND chose an endpoint would be one small step from a generic commercial CRUD
 * framework, and the whole point of two named endpoints is that the two decisions stay
 * legible as two decisions.
 *
 * ── SAVE IS UNAVAILABLE UNTIL THE SUBMISSION WOULD MEAN SOMETHING ─────────────────
 *
 * A different value, and a substantive reason. Not because the server cannot cope —
 * it refuses a short reason itself, and it answers a same-state request with a
 * successful no-op — but because there is no reason to encourage a write that says
 * nothing. The bar is the SERVER'S bar, mirrored; the server stays authoritative and a
 * 400 from it still renders below the field it names.
 */
@Component({
  selector: 'app-commercial-axis-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent],
  template: `
    <section
      class="mt-4 rounded border border-line-strong bg-surface-sunken p-4"
      [attr.aria-labelledby]="headingId()"
      data-commercial-editor
    >
      <h3 [id]="headingId()" class="text-admin-label text-ink">{{ heading() }}</h3>

      <!-- A real radiogroup. Options are a small closed set and the operator has to be
           able to compare them, so they are all visible rather than collapsed into a
           select the way a longer vocabulary would be. -->
      <div class="mt-3 space-y-2" role="radiogroup" [attr.aria-labelledby]="headingId()">
        @for (option of options(); track option.value) {
          <label class="flex cursor-pointer gap-2">
            <input
              type="radio"
              class="mt-0.5 h-4 w-4 shrink-0 accent-admin-accent"
              [name]="headingId()"
              [value]="option.value"
              [checked]="choice() === option.value"
              [disabled]="pending()"
              (change)="choose(option.value)"
            />
            <span class="flex flex-col gap-0.5">
              <span [class]="panelLabel">{{ option.label }}</span>
              <span [class]="note">{{ option.note }}</span>
            </span>
          </label>
        }
      </div>

      @if (selectedWarning(); as warning) {
        <!-- §16's warning hue means "careful", never "broken". The wording stands
             without the colour (§22), which is why it is a full sentence. -->
        <p class="mt-3 max-w-prose text-admin-meta text-admin-warning" data-commercial-warning>
          {{ warning }}
        </p>
      }

      <div class="mt-4">
        <label class="flex flex-col gap-1" [attr.for]="reasonId()">
          <span [class]="panelLabel">Reason for change</span>
          <textarea
            [id]="reasonId()"
            rows="2"
            [attr.minlength]="minReason"
            [attr.maxlength]="maxReason"
            [attr.aria-describedby]="reasonHintId()"
            [value]="reason()"
            [disabled]="pending()"
            (input)="onReason($event)"
            class="w-full rounded bg-surface px-2 py-1.5 text-admin-body text-ink
                   ring-1 ring-inset ring-line-strong"
            data-commercial-reason
          ></textarea>
        </label>
        <p [id]="reasonHintId()" [class]="'mt-1 ' + note">
          Recorded in the Admin audit log. At least {{ minReason }} characters.
        </p>

        @for (message of fieldErrorsFor('reason'); track message) {
          <p class="mt-1 text-admin-meta text-admin-danger" data-commercial-field-error>
            {{ message }}
          </p>
        }
      </div>

      @for (message of otherFieldErrors(); track message) {
        <p class="mt-2 max-w-prose text-admin-meta text-admin-danger" data-commercial-field-error>
          {{ message }}
        </p>
      }

      @if (errorMessage(); as message) {
        <p class="mt-3 max-w-prose text-admin-body text-admin-danger" data-commercial-error>
          {{ message }}
        </p>
      }

      <div class="mt-4 flex items-center gap-2">
        <!-- The pending state is the §16 mechanism, not decoration: the control stays
             visibly in flight until the server has committed AND audited the write. -->
        <app-admin-button
          variant="primary"
          [disabled]="!canSave()"
          [pending]="pending()"
          (pressed)="submit()"
          >Save change</app-admin-button
        >
        <app-admin-button variant="ghost" [disabled]="pending()" (pressed)="cancelled.emit()"
          >Cancel</app-admin-button
        >
      </div>
    </section>
  `,
})
export class CommercialAxisEditorComponent {
  /** Names the axis being edited — "Payment timing", "Collection mode". */
  readonly heading = input.required<string>();
  readonly options = input.required<readonly CommercialAxisOption[]>();

  /**
   * The value currently stored, as the operator sees it. Used ONLY to keep Save
   * unavailable for a submission that would change nothing — it is NOT the concurrency
   * token, which the parent captured when this editor opened.
   */
  readonly current = input<string | null>(null);

  readonly pending = input(false);
  /** A whole-request failure: a conflict, an outage, a cancelled re-authentication. */
  readonly errorMessage = input<string | null>(null);
  /** The server's per-field 400s, keyed by request-body field name. */
  readonly fieldErrors = input<Record<string, readonly string[]>>({});
  /** Disambiguates the two editors' element ids and radio-group name. */
  readonly axisId = input.required<string>();

  readonly save = output<CommercialAxisSubmission>();
  readonly cancelled = output<void>();

  protected readonly panelLabel = PANEL_LABEL;
  protected readonly note = NOTE;
  protected readonly minReason = MIN_REASON_LENGTH;
  protected readonly maxReason = MAX_REASON_LENGTH;

  protected readonly choice = signal<string | null>(null);
  protected readonly reason = signal('');

  protected readonly headingId = computed(() => `commercial-${this.axisId()}-heading`);
  protected readonly reasonId = computed(() => `commercial-${this.axisId()}-reason`);
  protected readonly reasonHintId = computed(() => `commercial-${this.axisId()}-reason-hint`);

  protected readonly selectedWarning = computed(() => {
    const selected = this.choice();
    if (selected === null) return null;
    return this.options().find((option) => option.value === selected)?.warning ?? null;
  });

  /**
   * A different value AND a substantive reason. `pending` closes it too, so a second
   * press cannot start a second request — the button is disabled while in flight and
   * this is the belt to that braces.
   */
  protected readonly canSave = computed(() => {
    if (this.pending()) return false;
    const selected = this.choice();
    if (selected === null || selected === this.current()) return false;
    return this.reason().trim().length >= this.minReason;
  });

  protected choose(value: string): void {
    this.choice.set(value);
  }

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected fieldErrorsFor(field: string): readonly string[] {
    return this.fieldErrors()[field] ?? [];
  }

  /**
   * Errors the server attributed to a field this form has no control for — `value`,
   * `expected_current`, or `__all__`.
   *
   * Shown rather than dropped. A 400 naming `expected_current` is the server telling
   * the operator something real about their request, and swallowing it because there is
   * no input to hang it on would leave them with a form that refuses silently.
   */
  protected otherFieldErrors(): readonly string[] {
    return Object.entries(this.fieldErrors())
      .filter(([field]) => field !== 'reason')
      .flatMap(([, messages]) => messages);
  }

  protected submit(): void {
    if (!this.canSave()) return;
    const selected = this.choice();
    if (selected === null) return;
    this.save.emit({ value: selected, reason: this.reason().trim() });
  }
}
