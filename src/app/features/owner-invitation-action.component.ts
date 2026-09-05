import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from '../core/api/api.constants';
import { AdminButtonComponent } from '../ui/button.component';

/** What the parent is asked to submit. The parent owns the concurrency token. */
export interface OwnerInvitationActionSubmission {
  readonly reason: string;
}

const LABEL = 'text-admin-label text-ink';
const NOTE = 'text-admin-meta text-ink-subtle';
const FIELD =
  'w-full rounded bg-surface px-2 py-1.5 text-admin-body text-ink ring-1 ring-inset ring-line-strong';

/**
 * THE REISSUE / CANCEL FORM (Step 2G). One component, two headings, because the two
 * requests are byte-identical on the wire — the exact invitation reviewed, plus why —
 * and differ entirely in what the parent does with them.
 *
 * ── IT COLLECTS A REASON, AND NOTHING ELSE ───────────────────────────────────────
 *
 * There is no owner to choose, no expiry to set, no delivery channel to pick: reissue
 * binds to the current canonical owner on the server, the claim window is the
 * server's TTL, and nothing is delivered. The consequence is stated once, above the
 * field, in the parent's words for that action.
 *
 * ── IT IS PRESENTATIONAL ──────────────────────────────────────────────────────────
 *
 * No token, no API, no status codes, and no idea which of the two operations it is
 * serving. The Readiness tab captured `expected_invitation_id` when it opened this
 * form and owns the outcome — the same boundary the commercial editors keep, for the
 * same reason: a form that both collected a reason AND chose an endpoint is one step
 * from a generic invitation-mutation control.
 *
 * ── NOT STYLED AS DESTRUCTIVE ────────────────────────────────────────────────────
 *
 * Cancelling an invitation withdraws a credential and creates nothing; reissuing
 * replaces one. Both are reversible by reissuing again, history is retained, and
 * nothing about the owner account changes — so the consequence is stated in the
 * warning hue on wording that stands without it (§22), and the button keeps the
 * ordinary accent. `--admin-danger` is reserved for destruction.
 */
@Component({
  selector: 'app-owner-invitation-action',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent],
  template: `
    <section
      class="mt-4 rounded border border-line-strong bg-surface-sunken p-4"
      [attr.aria-labelledby]="headingId"
      data-invitation-editor
    >
      <h3 [id]="headingId" class="text-admin-label text-ink">{{ heading() }}</h3>

      <!-- The invitation the captured token names, as it read when this form opened.
           Shown so the operator can see WHICH credential they are acting on rather
           than trusting that the panel above still describes the same row. -->
      <p class="mt-1 text-admin-body text-ink" data-invitation-subject>{{ subject() }}</p>

      <p class="mt-2 max-w-prose text-admin-meta text-admin-warning" data-invitation-consequence>
        {{ consequence() }}
      </p>

      <div class="mt-3">
        <label class="flex flex-col gap-1">
          <span [class]="label">Reason</span>
          <textarea
            rows="2"
            [attr.minlength]="minReason"
            [attr.maxlength]="maxReason"
            [value]="reason()"
            [disabled]="pending()"
            (input)="reason.set(readValue($event))"
            [class]="field"
            data-invitation-reason
          ></textarea>
        </label>
        <p [class]="'mt-1 ' + note">
          Recorded in the Admin audit log. At least {{ minReason }} characters.
        </p>
        @for (message of errorsFor('reason'); track message) {
          <p class="mt-1 text-admin-meta text-admin-danger" data-invitation-field-error>
            {{ message }}
          </p>
        }
      </div>

      @for (message of otherErrors(); track message) {
        <p class="mt-2 max-w-prose text-admin-meta text-admin-danger" data-invitation-field-error>
          {{ message }}
        </p>
      }

      @if (errorMessage(); as message) {
        <p class="mt-3 max-w-prose text-admin-body text-admin-danger" data-invitation-error>
          {{ message }}
        </p>
      }

      <div class="mt-4 flex items-center gap-2">
        <!-- The pending state is the §16 mechanism: visibly in flight until the server
             has committed AND audited the write. -->
        <app-admin-button
          variant="primary"
          [disabled]="!canSubmit()"
          [pending]="pending()"
          (pressed)="submit()"
          >{{ submitLabel() }}</app-admin-button
        >
        <app-admin-button variant="ghost" [disabled]="pending()" (pressed)="cancelled.emit()"
          >Back</app-admin-button
        >
      </div>
    </section>
  `,
})
export class OwnerInvitationActionComponent {
  readonly headingId = 'owner-invitation-action-heading';

  readonly heading = input.required<string>();
  /** The invitation being acted on, already formatted by the parent that owns the read. */
  readonly subject = input.required<string>();
  /** What this action DOES, stated exactly and claiming nothing beyond it. */
  readonly consequence = input.required<string>();
  readonly submitLabel = input.required<string>();

  readonly pending = input(false);
  readonly errorMessage = input<string | null>(null);
  readonly fieldErrors = input<Record<string, readonly string[]>>({});

  readonly save = output<OwnerInvitationActionSubmission>();
  readonly cancelled = output<void>();

  protected readonly label = LABEL;
  protected readonly note = NOTE;
  protected readonly field = FIELD;
  protected readonly minReason = MIN_REASON_LENGTH;
  protected readonly maxReason = MAX_REASON_LENGTH;

  protected readonly reason = signal('');

  protected readonly canSubmit = computed(
    () => !this.pending() && this.reason().trim().length >= this.minReason,
  );

  protected readValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected errorsFor(field: string): readonly string[] {
    return this.fieldErrors()[field] ?? [];
  }

  /**
   * Server errors naming something this form has no control for —
   * `expected_invitation_id` above all. Shown rather than dropped: a 400 naming the
   * token is the server telling the operator something real.
   */
  protected otherErrors(): readonly string[] {
    return Object.entries(this.fieldErrors())
      .filter(([field]) => field !== 'reason')
      .flatMap(([, messages]) => messages);
  }

  protected submit(): void {
    if (!this.canSubmit()) return;
    this.save.emit({ reason: this.reason().trim() });
  }
}
