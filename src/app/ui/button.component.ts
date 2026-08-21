import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';

const BASE =
  'inline-flex h-control items-center justify-center gap-2 rounded px-3 ' +
  'text-admin-label transition-colors disabled:cursor-not-allowed disabled:opacity-55';

const VARIANTS: Record<ButtonVariant, string> = {
  // Every one of these reads --admin-accent or --admin-danger and nothing else.
  primary: 'bg-admin-accent text-admin-accent-fg hover:bg-admin-accent-hover',
  secondary: 'bg-surface text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-sunken',
  destructive: 'bg-admin-danger text-admin-danger-fg hover:bg-admin-danger-hover',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink',
};

/**
 * The class string for a button of this variant.
 *
 * Exported so the ONE place a control has to be an anchor rather than a button — a
 * primary action that NAVIGATES, like the restaurant header's "Review readiness" —
 * can look identical without respelling the styles. §19 wants real `<button>`
 * semantics for actions and real `<a>` semantics for navigation, and the honest way
 * to have both is to share the appearance rather than fake the element.
 *
 * It is appearance only: an anchor using it must still supply its own focus and
 * disabled behaviour, which is why this is a helper and not a directive.
 */
export function adminButtonClasses(variant: ButtonVariant, block = false): string {
  return [BASE, block ? 'w-full' : '', VARIANTS[variant]].filter(Boolean).join(' ');
}

/**
 * The button.
 *
 * ── `pending` IS A MECHANISM, NOT DECORATION ──────────────────────────────────────
 *
 * Spec §16 forbids optimistic UI for consequential writes: lifecycle transitions, go
 * live, offboard, mark-paid and incident resolution must stay VISIBLY PENDING until
 * the server has committed AND audited them. That is not a preference — on this plane
 * a write is only real once its `AdminAuditLog` row commits in the same transaction,
 * and a button that springs back to "Suspended" before that has told the operator
 * something that may not be true.
 *
 * `pending` is how that rule is enforced rather than remembered: it disables the
 * control (so the action cannot be fired twice) and shows progress (so the operator
 * knows it is still in flight). Any consequential action in step 1 onward binds it to
 * the in-flight state of its own request.
 *
 * ── SIZING ────────────────────────────────────────────────────────────────────────
 *
 * `h-control` is 40px — §16 asks for 40–44px rather than the WCAG 2.2 minimum, and
 * the height is a spacing token so it cannot drift from the rows it sits beside.
 */
@Component({
  selector: 'app-admin-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      [type]="type()"
      [disabled]="disabled() || pending()"
      [attr.aria-busy]="pending() ? 'true' : null"
      [class]="classes()"
      (click)="pressed.emit()"
    >
      @if (pending()) {
        <!-- Inline SVG. No icon package anywhere in this repo — see CLAUDE.md. -->
        <svg
          class="h-3.5 w-3.5 animate-spin"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" />
          <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      }
      <ng-content />
    </button>
  `,
})
export class AdminButtonComponent {
  readonly variant = input<ButtonVariant>('secondary');
  readonly type = input<'button' | 'submit'>('button');
  readonly disabled = input(false);
  /** In flight: disabled and visibly progressing. See the class comment. */
  readonly pending = input(false);
  readonly block = input(false);

  readonly pressed = output<void>();

  protected readonly classes = computed(() => adminButtonClasses(this.variant(), this.block()));
}
