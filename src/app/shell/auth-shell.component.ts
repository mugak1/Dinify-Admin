import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { DinifyWordmarkComponent } from './dinify-wordmark.component';

/**
 * THE FRAME FOR THE TWO SIGNED-OUT SCREENS — `/login` and `/unavailable`.
 *
 * ── WHY THIS IS NOT DARK CHROME ───────────────────────────────────────────────────
 *
 * §16's dark chrome exists to FRAME a light working area, and half of what makes this
 * application unmistakable beside the restaurant portal. Neither job applies here:
 * there is no working area on a signed-out screen, and a near-black page with a small
 * grey form on it was not reading as a control plane so much as an unstyled one. So
 * these two screens use the warm paper environment instead, mirroring
 * Dinify-Frontend's sign-in at this application's density (see the `auth-*` note at
 * the top of tailwind.config.js).
 *
 * ── THE DISTINCTNESS RULE IS NOT RELAXED, IT IS RELOCATED ─────────────────────────
 *
 * The delegated-support hazard §16 is about is two WORKING surfaces open at once, and
 * every authenticated surface still carries the chrome, the dense scale, the 8px radii
 * and the single typeface. What has to be unmistakable HERE is which plane is about to
 * receive a set of credentials, and that is carried by the word ADMIN — in the lockup
 * beside the wordmark, in the page title, and in the copy — rather than by making the
 * screen unpleasant. **Never render this shell without the `Admin` half of the
 * lockup**: it is the whole reason the warm environment is safe to use.
 *
 * ── WHY IT IS SHELL FURNITURE, NOT A PRIMITIVE ────────────────────────────────────
 *
 * Same argument as the three banners: a primitive is something screens reach for, and
 * this is something the frame owns. It has exactly two hosts, both outside the router
 * shell, and it exists so they cannot drift — a redesigned sign-in beside an
 * untouched outage page would be two applications, and `/login` NAVIGATES to
 * `/unavailable` when a verified session cannot be read back, so an operator crosses
 * that seam mid-flow.
 *
 * It owns the environment, the card and the lockup. It owns no state, no form and no
 * behaviour; the heading trio is passed in because it changes per step, and everything
 * below it is projected.
 */
@Component({
  selector: 'app-auth-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DinifyWordmarkComponent],
  template: `
    <div
      class="relative flex min-h-screen items-center justify-center overflow-hidden
             bg-auth-environment px-4 py-10"
    >
      <!-- Fine paper grain. A cream field this large bands visibly on an ordinary
           monitor; a few percent of fractal noise over it does not. Inert to the
           pointer and hidden from assistive technology — it carries no meaning. -->
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 z-0 bg-auth-grain opacity-5 mix-blend-multiply"
      ></div>

      <main
        class="relative z-10 w-full max-w-auth-card rounded-auth-card border border-auth-line
               bg-surface px-7 py-9 shadow-auth-card sm:px-9 sm:py-10"
      >
        <!-- THE LOCKUP. Wordmark, a hairline, then ADMIN. The second half is not
             decoration: it is what tells an operator with both portals open which one
             is about to take their credentials. The mark itself is shared with the
             sidebar's lockup so the two frames cannot drift — see
             dinify-wordmark.component.ts for why it is drawn from currentColor rather
             than loaded as an asset. -->
        <div class="flex items-center justify-center gap-3">
          <app-dinify-wordmark class="h-7" tone="ink" />
          <span aria-hidden="true" class="h-5 w-px bg-auth-line"></span>
          <span class="text-admin-section text-ink-muted">Admin</span>
        </div>

        <div class="mt-7 text-center">
          @if (eyebrow(); as label) {
            <p class="text-auth-eyebrow uppercase text-admin-accent-ink">{{ label }}</p>
          }
          <h1 class="mt-2 text-auth-display text-ink">{{ heading() }}</h1>
          @if (lede(); as text) {
            <p class="mt-2 text-auth-lede text-ink-subtle">{{ text }}</p>
          }
        </div>

        <ng-content />
      </main>
    </div>
  `,
})
export class AuthShellComponent {
  /** Uppercase, tracked, in the accent's text tint. Optional. */
  readonly eyebrow = input<string | null>(null);
  readonly heading = input.required<string>();
  /** One line under the heading. Optional. */
  readonly lede = input<string | null>(null);
}
