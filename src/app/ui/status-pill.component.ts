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
 * ── WHERE THE TEST FLAG COMES FROM ────────────────────────────────────────────────
 *
 * `Restaurant.is_test` NOW EXISTS (migration `restaurants_app/0057`) and is what drives
 * this variant: platform-owned metadata marking a tenant that is not a real commercial
 * customer — a demo, a fixture, an internal rehearsal account. It is absent from both
 * `EDIT_INFORMATION['restaurants']` and `SerializerPutRestaurant`, so no restaurant user
 * can set it, and migration 0057 deliberately backfills NOTHING: whether an existing
 * restaurant is a test tenant is an explicit operator decision, never inferred from its
 * name. The admin directory and detail reads surface it directly.
 *
 * DO NOT CONFUSE IT WITH `Order.is_test` (migration `orders_app/0035`), which is a
 * different fact about a different object: one ORDER that is operationally real and
 * commercially invisible, either because its tenant is a test tenant or because it was
 * placed before go-live as a rehearsal. A real restaurant can have test orders, and a
 * test restaurant's orders are all test orders — so neither flag may be derived from
 * the other. The Overview tab marks a test LATEST ORDER with this same pill for the
 * same reason it marks a test tenant: "a rehearsal happened" and "a sale happened" are
 * not the same statement.
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
