import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from '../core/api/api.constants';
import { eatWallTimeToIso } from '../core/formatting/time';
import { AdminButtonComponent } from '../ui/button.component';

/** What the parent is asked to submit. The parent owns the concurrency token. */
export interface SubscriptionTermsEndSubmission {
  /** An ISO instant carrying an explicit offset. Already converted from EAT wall time. */
  readonly ended_at: string;
  readonly reason: string;
}

const LABEL = 'text-admin-label text-ink';
const NOTE = 'text-admin-meta text-ink-subtle';
const FIELD =
  'w-full rounded bg-surface px-2 py-1.5 text-admin-body text-ink ring-1 ring-inset ring-line-strong';

/**
 * THE END TERMS FORM (Step 3E.3).
 *
 * ── IT COLLECTS A BOUNDARY AND A REASON, AND NOTHING ELSE ─────────────────────────
 *
 * A terms row's five commercial facts are immutable, so ending one changes exactly one
 * thing: when it stopped applying. There is no amount to restate and nothing to choose.
 *
 * ── THERE IS NO "NOW" DEFAULT, AND THAT IS THE WHOLE POINT OF THE FIELD ───────────
 *
 * The backend requires `ended_at` and refuses to default it, because the operator is
 * recording the boundary at which the terms STOPPED APPLYING — frequently not the
 * moment they got round to typing it. Backdating is ordinary and truthful here.
 * Prefilling the current time would have Dinify record a different fact from the one
 * the operator meant, in the one field that decides which terms were in force.
 *
 * ── THE COPY STATES THE CONSEQUENCE AND CLAIMS NOTHING ELSE ───────────────────────
 *
 * Ending terms leaves the restaurant with no CURRENT terms. It does not cancel a
 * subscription, stop billing, issue a refund, revoke access, close an account or take
 * the restaurant off the platform — there is no invoice model, no receivable and no
 * collection path behind any of those words. Historical rows are retained; the domain
 * closes the open row and deletes nothing.
 *
 * ── IT IS DESTRUCTIVE-SOUNDING AND IS NOT STYLED AS DESTRUCTIVE ───────────────────
 *
 * §16 reserves `--admin-danger` for destructive actions and `--admin-warning` for
 * "careful". This is the second: nothing is destroyed, the history survives, and the
 * state is reversible by recording new terms. The consequence is stated in the warning
 * hue on wording that stands without it (§22), and the button stays the ordinary
 * accent — a danger-red control here would train the operator to read real destruction
 * as routine.
 *
 * ── IT IS PRESENTATIONAL ──────────────────────────────────────────────────────────
 *
 * No token, no API, no status codes. The Overview tab owns those, exactly as it does
 * for the axis editor and the record/replace form.
 */
@Component({
  selector: 'app-subscription-terms-end',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent],
  template: `
    <section
      class="mt-4 rounded border border-line-strong bg-surface-sunken p-4"
      [attr.aria-labelledby]="headingId"
      data-commercial-editor
      data-terms-end-editor
    >
      <h3 [id]="headingId" class="text-admin-label text-ink">End subscription terms</h3>

      <!-- The row the captured token names, as it was when this form opened. Shown so
           the operator can see WHICH terms they are ending rather than trusting that
           the panel above still describes the same row. -->
      <p class="mt-1 text-admin-body text-ink" data-terms-end-subject>{{ subject() }}</p>

      <p class="mt-2 max-w-prose text-admin-meta text-admin-warning" data-terms-end-consequence>
        Ending these terms leaves the restaurant with no current subscription terms.
        Historical terms are retained.
      </p>

      <div class="mt-3">
        <label class="flex flex-col gap-1">
          <!-- EAT IS IN THE LABEL. An operator administering from another timezone is
               deciding a commercial boundary here, and the value is serialised against
               Africa/Kampala rather than against the browser's zone. -->
          <span [class]="label">End time (EAT)</span>
          <input
            type="datetime-local"
            [value]="endedAt()"
            [disabled]="pending()"
            (input)="endedAt.set(readValue($event))"
            [class]="field"
            data-terms-ended-at
          />
        </label>
        <p [class]="'mt-1 ' + note">
          When these terms stopped applying. Not defaulted to now — a future moment is
          not accepted, and a boundary before the terms took effect is refused.
        </p>
        @for (message of errorsFor('ended_at'); track message) {
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

      <div class="mt-4 flex items-center gap-2">
        <app-admin-button
          variant="primary"
          [disabled]="!canSave()"
          [pending]="pending()"
          (pressed)="submit()"
          >End terms</app-admin-button
        >
        <app-admin-button variant="ghost" [disabled]="pending()" (pressed)="cancelled.emit()"
          >Cancel</app-admin-button
        >
      </div>
    </section>
  `,
})
export class SubscriptionTermsEndComponent {
  readonly headingId = 'subscription-terms-end-heading';

  /** The terms being ended, already formatted by the parent that owns the read. */
  readonly subject = input.required<string>();

  readonly pending = input(false);
  readonly errorMessage = input<string | null>(null);
  readonly fieldErrors = input<Record<string, readonly string[]>>({});

  readonly save = output<SubscriptionTermsEndSubmission>();
  readonly cancelled = output<void>();

  protected readonly label = LABEL;
  protected readonly note = NOTE;
  protected readonly field = FIELD;
  protected readonly minReason = MIN_REASON_LENGTH;
  protected readonly maxReason = MAX_REASON_LENGTH;

  /** A naive wall time. Serialised against EAT on submit, never by `new Date()`. */
  protected readonly endedAt = signal('');
  protected readonly reason = signal('');

  /** The instant the stated EAT wall time denotes, or null if it is incomplete. */
  protected readonly endedAtIso = computed(() => eatWallTimeToIso(this.endedAt()));

  protected readonly canSave = computed(() => {
    if (this.pending()) return false;
    if (this.endedAtIso() === null) return false;
    return this.reason().trim().length >= this.minReason;
  });

  protected readValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected errorsFor(field: string): readonly string[] {
    return this.fieldErrors()[field] ?? [];
  }

  /**
   * Server errors naming something this form has no control for — `expected_terms_id`
   * above all. Shown rather than dropped: a 400 naming the token is the server telling
   * the operator something real, and swallowing it leaves a form that refuses silently.
   */
  protected otherErrors(): readonly string[] {
    const known = new Set(['ended_at', 'reason']);
    return Object.entries(this.fieldErrors())
      .filter(([field]) => !known.has(field))
      .flatMap(([, messages]) => messages);
  }

  protected submit(): void {
    if (!this.canSave()) return;
    const endedAt = this.endedAtIso();
    if (endedAt === null) return;
    this.save.emit({ ended_at: endedAt, reason: this.reason().trim() });
  }
}
