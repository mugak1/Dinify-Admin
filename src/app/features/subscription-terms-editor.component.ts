import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';

import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from '../core/api/api.constants';
import { eatWallTimeToIso } from '../core/formatting/time';
import { BillingIntervalUnit } from '../core/restaurants/restaurant.model';
import { AdminButtonComponent } from '../ui/button.component';

/**
 * The five commercial facts a terms row is made of, as the operator states them.
 *
 * `recurring_amount` IS A STRING all the way through. The backend refuses a JSON
 * number outright, and `"0.00"` versus `0.0` is exactly the distinction that would be
 * lost — so nothing here parses it, and the parent sends what was typed.
 *
 * `effective_from` is already an ISO instant carrying an explicit offset: the editor
 * converts the operator's EAT wall time before emitting, so the parent never has to
 * know that a `datetime-local` value is naive.
 */
export interface SubscriptionTermsSubmission {
  readonly recurring_amount: string;
  readonly currency: string;
  readonly billing_interval_unit: BillingIntervalUnit;
  readonly billing_interval_count: number;
  readonly effective_from: string;
  readonly reason: string;
}

/** The current row's immutable facts, for prefilling a replacement. */
export interface SubscriptionTermsPrefill {
  readonly recurring_amount: string;
  readonly currency: string;
  readonly billing_interval_unit: BillingIntervalUnit;
  readonly billing_interval_count: number;
}

const LABEL = 'text-admin-label text-ink';
const NOTE = 'text-admin-meta text-ink-subtle';
const FIELD =
  'w-full rounded bg-surface px-2 py-1.5 text-admin-body text-ink ring-1 ring-inset ring-line-strong';

const UNITS: readonly { readonly value: BillingIntervalUnit; readonly label: string }[] = [
  { value: 'day', label: 'day' },
  { value: 'week', label: 'week' },
  { value: 'month', label: 'month' },
  { value: 'year', label: 'year' },
];

/**
 * THE RECORD / REPLACE TERMS FORM (Step 3E.3).
 *
 * ── IT COLLECTS EVERY COMMERCIAL FACT, AND INVENTS NONE ───────────────────────────
 *
 * Amount, currency, interval unit, interval count and the effective-from boundary are
 * all stated by the operator. There is no silent UGX default and no "now" default: the
 * backend has no currency default either, and a moment the client filled in would be
 * Dinify recording a commercial term nobody chose. A replacement may PREFILL the
 * current row's four immutable facts so only what genuinely changes has to be retyped
 * — but never the boundary, which is a new decision every time.
 *
 * ── IT IS PRESENTATIONAL ──────────────────────────────────────────────────────────
 *
 * It does not know whether it is recording or replacing, hold a concurrency token,
 * call an API or interpret a status code. The Overview tab owns all of that, and owns
 * the three operations explicitly — the same boundary the axis editor keeps, for the
 * same reason.
 *
 * ── INLINE, NOT A MODAL ───────────────────────────────────────────────────────────
 *
 * These writes are elevation-gated, and the elevation prompt is already a modal. A
 * modal form would routinely have a TOTP prompt stacked on top of a half-written
 * reason.
 */
@Component({
  selector: 'app-subscription-terms-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent],
  template: `
    <section
      class="mt-4 rounded border border-line-strong bg-surface-sunken p-4"
      [attr.aria-labelledby]="headingId"
      data-commercial-editor
      data-terms-editor
    >
      <h3 [id]="headingId" class="text-admin-label text-ink">{{ heading() }}</h3>

      <p [class]="'mt-1 max-w-prose ' + note">
        These are the recurring software-subscription terms Dinify has recorded for this
        restaurant. They are not an invoice, a payment, or proof that the owner agreed to
        them.
      </p>

      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1">
          <span [class]="label">Recurring amount</span>
          <!-- A TEXT input, never type="number". The value is a decimal string on the
               wire and a number input would hand back a coerced one — which is the exact
               round trip the backend's strict field exists to refuse. -->
          <input
            type="text"
            inputmode="decimal"
            autocomplete="off"
            [value]="amount()"
            [disabled]="pending()"
            (input)="amount.set(readValue($event))"
            [class]="field"
            data-terms-amount
          />
          @for (message of errorsFor('recurring_amount'); track message) {
            <span class="text-admin-meta text-admin-danger" data-commercial-field-error>{{
              message
            }}</span>
          }
        </label>

        <label class="flex flex-col gap-1">
          <span [class]="label">Currency</span>
          <!-- Stated, never assumed. The backend has no default and no allowlist: it
               enforces the SHAPE (three letters) and canonicalises the case. -->
          <input
            type="text"
            autocomplete="off"
            maxlength="3"
            placeholder="UGX"
            [value]="currency()"
            [disabled]="pending()"
            (input)="currency.set(readValue($event))"
            [class]="field"
            data-terms-currency
          />
          @for (message of errorsFor('currency'); track message) {
            <span class="text-admin-meta text-admin-danger" data-commercial-field-error>{{
              message
            }}</span>
          }
        </label>

        <label class="flex flex-col gap-1">
          <span [class]="label">Billing every</span>
          <input
            type="number"
            min="1"
            step="1"
            [value]="count()"
            [disabled]="pending()"
            (input)="count.set(readValue($event))"
            [class]="field"
            data-terms-count
          />
          @for (message of errorsFor('billing_interval_count'); track message) {
            <span class="text-admin-meta text-admin-danger" data-commercial-field-error>{{
              message
            }}</span>
          }
        </label>

        <label class="flex flex-col gap-1">
          <span [class]="label">Interval</span>
          <!-- THE SELECTED OPTION IS MARKED ON THE OPTION, not by binding value on the
               select. A value binding is applied before the loop has rendered the
               options, so it matches nothing and the control falls back to the FIRST one
               — which meant a replacement prefilled with "every 2 years" came up reading
               "day", and would have recorded that recurrence if the operator did not
               notice. A test with a non-default interval caught it; one using the
               default month/1 would not have, because the wrong answer and the right
               answer look identical. -->
          <select
            [disabled]="pending()"
            (change)="unit.set(readValue($event))"
            [class]="field"
            data-terms-unit
          >
            @for (option of units; track option.value) {
              <option [value]="option.value" [selected]="option.value === unit()">
                {{ option.label }}
              </option>
            }
          </select>
          @for (message of errorsFor('billing_interval_unit'); track message) {
            <span class="text-admin-meta text-admin-danger" data-commercial-field-error>{{
              message
            }}</span>
          }
        </label>
      </div>

      <div class="mt-3">
        <label class="flex flex-col gap-1">
          <!-- EAT IS IN THE LABEL, and that is not decoration. The operator may be
               administering from another timezone, and this field decides which terms
               were in force. The value is serialised against Africa/Kampala, never
               against the browser's zone. -->
          <span [class]="label">Effective from (EAT)</span>
          <input
            type="datetime-local"
            [value]="effectiveFrom()"
            [disabled]="pending()"
            (input)="effectiveFrom.set(readValue($event))"
            [class]="field"
            data-terms-effective-from
          />
        </label>
        <p [class]="'mt-1 ' + note">
          When these terms took effect. Terms already in effect only — a future moment is
          not accepted, and this is not the moment you are recording them.
        </p>
        @for (message of errorsFor('effective_from'); track message) {
          <p class="mt-1 text-admin-meta text-admin-danger" data-commercial-field-error>
            {{ message }}
          </p>
        }
      </div>

      <div class="mt-3">
        <label class="flex flex-col gap-1">
          <span [class]="label">Reason for change</span>
          <textarea
            rows="2"
            [attr.minlength]="minReason"
            [attr.maxlength]="maxReason"
            [value]="reason()"
            [disabled]="pending()"
            (input)="reason.set(readValue($event))"
            [class]="field"
            data-commercial-reason
          ></textarea>
        </label>
        <p [class]="'mt-1 ' + note">
          Recorded in the Admin audit log. At least {{ minReason }} characters.
        </p>
        @for (message of errorsFor('reason'); track message) {
          <p class="mt-1 text-admin-meta text-admin-danger" data-commercial-field-error>
            {{ message }}
          </p>
        }
      </div>

      @for (message of otherErrors(); track message) {
        <p class="mt-2 max-w-prose text-admin-meta text-admin-danger" data-commercial-field-error>
          {{ message }}
        </p>
      }

      @if (errorMessage(); as message) {
        <p class="mt-3 max-w-prose text-admin-body text-admin-danger" data-commercial-error>
          {{ message }}
        </p>
      }

      @if (unchangedFacts()) {
        <!-- Replacing terms means changing what the restaurant PAYS. The backend treats
             a replacement whose four commercial facts are unchanged as a no-op, and
             re-dating an unchanged price is a separate correction it deliberately does
             not offer — so the form says so rather than encouraging the request. -->
        <p class="mt-3 max-w-prose text-admin-meta text-admin-warning" data-terms-unchanged>
          These are the terms already recorded. Change the amount, currency or interval to
          replace them.
        </p>
      }

      <div class="mt-4 flex items-center gap-2">
        <app-admin-button
          variant="primary"
          [disabled]="!canSave()"
          [pending]="pending()"
          (pressed)="submit()"
          >{{ submitLabel() }}</app-admin-button
        >
        <app-admin-button variant="ghost" [disabled]="pending()" (pressed)="cancelled.emit()"
          >Cancel</app-admin-button
        >
      </div>
    </section>
  `,
})
export class SubscriptionTermsEditorComponent implements OnInit {
  readonly heading = input.required<string>();
  readonly submitLabel = input.required<string>();
  readonly headingId = 'subscription-terms-editor-heading';

  /**
   * The current row's immutable facts, prefilled so a replacement only has to restate
   * what genuinely changes. Absent when recording — nothing is invented for a first
   * set of terms.
   */
  readonly prefill = input<SubscriptionTermsPrefill | null>(null);

  /**
   * True when this editor must refuse a submission whose commercial facts equal the
   * prefill. Set for Replace, not for Record — recording identical terms is a
   * legitimate exact retry the backend answers as a successful no-op.
   */
  readonly refuseUnchanged = input(false);

  readonly pending = input(false);
  readonly errorMessage = input<string | null>(null);
  readonly fieldErrors = input<Record<string, readonly string[]>>({});

  readonly save = output<SubscriptionTermsSubmission>();
  readonly cancelled = output<void>();

  protected readonly label = LABEL;
  protected readonly note = NOTE;
  protected readonly field = FIELD;
  protected readonly units = UNITS;
  protected readonly minReason = MIN_REASON_LENGTH;
  protected readonly maxReason = MAX_REASON_LENGTH;

  protected readonly amount = signal('');
  protected readonly currency = signal('');
  protected readonly unit = signal<string>('month');
  protected readonly count = signal('1');
  /** A naive wall time. Serialised against EAT on submit, never by `new Date()`. */
  protected readonly effectiveFrom = signal('');
  protected readonly reason = signal('');

  /**
   * Prefill runs ONCE, from the input's initial value.
   *
   * `ngOnInit` and not the constructor, and that is not a style choice: input signals
   * are populated AFTER construction, so reading `prefill()` in the constructor returns
   * the default and every replacement form comes up blank. (It did. Two tests caught it.)
   *
   * And not an effect or a `linkedSignal` either — either would keep TRACKING the input,
   * so a background change to the store would overwrite what the operator had typed with
   * facts they never saw. The parent snapshots the row when the editor opens; this reads
   * that snapshot once and then owns its own state.
   */
  ngOnInit(): void {
    const initial = this.prefill();
    if (!initial) return;
    this.amount.set(initial.recurring_amount);
    this.currency.set(initial.currency);
    this.unit.set(initial.billing_interval_unit);
    this.count.set(String(initial.billing_interval_count));
  }

  /**
   * True when every commercial fact still equals the row being replaced.
   *
   * Compares the FOUR facts and deliberately not `effective_from` — mirroring the
   * backend's own `_commercial_tuple`, which excludes it because re-dating unchanged
   * terms is a different question from changing them. Amounts are compared as TRIMMED
   * STRINGS: no float conversion, ever.
   */
  protected readonly unchangedFacts = computed(() => {
    const current = this.prefill();
    if (!current || !this.refuseUnchanged()) return false;
    return (
      this.amount().trim() === current.recurring_amount.trim() &&
      this.currency().trim().toUpperCase() === current.currency.trim().toUpperCase() &&
      this.unit() === current.billing_interval_unit &&
      this.count().trim() === String(current.billing_interval_count)
    );
  });

  /** The instant the stated EAT wall time denotes, or null if it is incomplete. */
  protected readonly effectiveFromIso = computed(() => eatWallTimeToIso(this.effectiveFrom()));

  protected readonly canSave = computed(() => {
    if (this.pending()) return false;
    if (this.unchangedFacts()) return false;
    if (!this.amount().trim()) return false;
    if (!this.currency().trim()) return false;
    if (!this.isPositiveInteger(this.count())) return false;
    if (this.effectiveFromIso() === null) return false;
    return this.reason().trim().length >= this.minReason;
  });

  protected readValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  protected errorsFor(field: string): readonly string[] {
    return this.fieldErrors()[field] ?? [];
  }

  /** Server errors naming something this form has no control for. Shown, not dropped. */
  protected otherErrors(): readonly string[] {
    const known = new Set([
      'recurring_amount',
      'currency',
      'billing_interval_unit',
      'billing_interval_count',
      'effective_from',
      'reason',
    ]);
    return Object.entries(this.fieldErrors())
      .filter(([field]) => !known.has(field))
      .flatMap(([, messages]) => messages);
  }

  protected submit(): void {
    if (!this.canSave()) return;
    const effectiveFrom = this.effectiveFromIso();
    if (effectiveFrom === null) return;

    this.save.emit({
      // TRIMMED, NEVER PARSED. The string the operator typed is the string that is sent.
      recurring_amount: this.amount().trim(),
      currency: this.currency().trim(),
      billing_interval_unit: this.unit() as BillingIntervalUnit,
      billing_interval_count: Number(this.count().trim()),
      effective_from: effectiveFrom,
      reason: this.reason().trim(),
    });
  }

  private isPositiveInteger(raw: string): boolean {
    return /^\d+$/.test(raw.trim()) && Number(raw.trim()) >= 1;
  }
}
