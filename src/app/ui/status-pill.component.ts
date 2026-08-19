import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The four lifecycle states are fixed by the backend
 * (`restaurants_app/controllers/lifecycle.py`), plus TEST and a neutral fallback.
 */
export type StatusPillVariant =
  | 'onboarding'
  | 'live'
  | 'suspended'
  | 'offboarded'
  | 'test'
  | 'neutral';

const LABELS: Record<StatusPillVariant, string> = {
  onboarding: 'Onboarding',
  live: 'Live',
  suspended: 'Suspended',
  offboarded: 'Offboarded',
  test: 'Test',
  neutral: 'Unknown',
};

const STYLES: Record<StatusPillVariant, string> = {
  onboarding: 'bg-state-onboarding-soft text-state-onboarding ring-state-onboarding/20',
  live: 'bg-state-live-soft text-state-live ring-state-live/20',
  suspended: 'bg-state-suspended-soft text-state-suspended ring-state-suspended/20',
  offboarded: 'bg-state-offboarded-soft text-state-offboarded ring-state-offboarded/25',
  neutral: 'bg-state-neutral-soft text-state-neutral ring-state-neutral/20',
  // THE ONLY SOLID-FILLED PILL IN THE SYSTEM. See the class comment.
  test: 'bg-state-test text-state-test-fg ring-state-test',
};

/**
 * A status badge. Lifecycle, TEST, or neutral.
 *
 * ── IT IS NEVER INTERACTIVE ───────────────────────────────────────────────────────
 *
 * Spec §16: badges are STATUS, never a control. So this renders a plain `<span>` with
 * no click handler, no `tabindex`, no `role`, no hover state and no `cursor-pointer`.
 * If a status needs to be clickable, the thing that is clickable is the row or a
 * button beside it — never the badge, because a badge that is sometimes a control
 * teaches the operator to click badges that are not.
 *
 * §16 also asks for badges SPARINGLY: lifecycle, subscription and incident status are
 * enough. Not every noun becomes a coloured pill.
 *
 * ── WHY TEST IS SOLID-FILLED ──────────────────────────────────────────────────────
 *
 * §16 requires test restaurants to be UNMISTAKABLE. Hue alone is not enough — an
 * operator scanning a directory reads shape before colour, and a sixth soft-tinted
 * pill in a different hue is just another pill. TEST is therefore the only pill in
 * the system with a solid fill, so it differs in FORM from every lifecycle state and
 * cannot be mistaken for one at a glance.
 *
 * ── THE BACKEND DOES NOT HAVE THIS FIELD YET ──────────────────────────────────────
 *
 * `Restaurant.is_test` DOES NOT EXIST — confirmed against `restaurants_app/models.py`
 * during recon. What exists is `Order.is_test` (migration `orders_app/0035`), and it
 * means something different: an order placed while the restaurant was still
 * `onboarding`, i.e. a pre-go-live REHEARSAL order. A rehearsal order is
 * operationally real and commercially invisible — it occupies its table and reaches
 * the kitchen board, but is excluded from every sales figure.
 *
 * So the `test` variant is MOCK-DRIVEN until the step-1 backend PR adds a restaurant
 * level flag. Do not derive it from order data; those are different facts.
 */
@Component({
  selector: 'app-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex items-center rounded-sm px-1.5 py-0.5 text-admin-micro uppercase ring-1 ring-inset"
      [class]="styles()"
      >{{ text() }}</span
    >
  `,
})
export class StatusPillComponent {
  readonly variant = input.required<StatusPillVariant>();
  /** Override the default label. The variant still decides the colour. */
  readonly label = input<string | null>(null);

  protected readonly text = computed(() => this.label() ?? LABELS[this.variant()]);
  protected readonly styles = computed(() => STYLES[this.variant()]);
}
