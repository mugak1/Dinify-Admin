import { ChangeDetectionStrategy, Component, input } from '@angular/core';

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
             is about to take their credentials. The Dinify mark is drawn from
             currentColor in two groups rather than carrying its own fills, so it
             tracks --admin-accent and --admin-fg like everything else, and no fill in
             it is spelled as a colour. -->
        <div class="flex items-center justify-center gap-3">
          <svg
            viewBox="395 385 500 130"
            class="h-7 w-auto"
            role="img"
            aria-label="Dinify"
          >
            <g class="text-admin-accent" fill="currentColor">
              <path d="m543.52,413.67c-1.25-1.6-2.6-3.12-4.03-4.55-8.93-8.93-21.26-14.45-34.88-14.45h-102.58l24.16,28.47c5.07,5.97,12.39,9.57,20.22,9.92l14.5.66c2.48.11,4.76-1.34,5.72-3.63.31-.73.6-1.38.81-1.73,3.44-5.86,9.99-9.68,20.94-9.68,17.97,0,40.99,10.29,40.99,22.99s-23.03,22.99-40.99,22.99c-10.18,0-16.55-3.3-20.16-8.47-.67-.95-1.24-1.97-1.73-3.04-1-2.22-3.23-3.63-5.67-3.52l-11.72.53,5.12,6.03,17.96,21.82c3.99,4.85,8.96,8.68,14.5,11.29,5.54,2.61,11.65,4.02,17.93,4.02,24.58,0,44.95-17.98,48.7-41.5.4-2.55.62-5.15.62-7.82,0-11.44-3.89-21.96-10.42-30.33Z" />
            </g>
            <g class="text-ink" fill="currentColor">
              <path d="m631.11,413.84c-8.25-8.05-18.52-12.06-30.82-12.06h-30.53v84.44h30.53c12.3,0,22.57-4.02,30.82-12.06,8.24-8.03,12.36-18.09,12.36-30.16s-4.12-22.12-12.36-30.16Zm-12.14,48.74c-4.82,4.82-11.05,7.23-18.69,7.23h-13.28v-51.63h13.28c7.63,0,13.87,2.42,18.69,7.23,4.83,4.83,7.25,11.03,7.25,18.58s-2.42,13.75-7.25,18.58Z" />
              <path d="m669.41,392.06c-2-1.88-4.58-2.83-7.72-2.83s-5.6.96-7.66,2.89c-2.05,1.94-3.07,4.34-3.07,7.25s1.02,5.42,3.07,7.35c2.06,1.94,4.61,2.9,7.66,2.9s5.72-.96,7.72-2.9c2.02-1.93,3.02-4.37,3.02-7.35s-1.01-5.41-3.02-7.31Zm-16.4,27.82v66.34h17.25v-66.34h-17.25Z" />
              <path d="m737.22,425.42c-4.27-4.65-10.14-6.99-17.62-6.99-8.76,0-15.65,3.5-20.63,10.49v-9.04h-17.25v66.34h17.25v-34.85c0-11.03,4.98-16.54,14.97-16.54,4.42,0,7.59,1.13,9.53,3.38,1.93,2.25,2.89,5.63,2.89,10.14v37.88h17.25v-41.61c0-8.12-2.13-14.52-6.39-19.19Z" />
              <path d="m770.75,392.06c-2.02-1.88-4.58-2.83-7.72-2.83s-5.62.96-7.66,2.89c-2.05,1.94-3.08,4.34-3.08,7.25s1.04,5.42,3.08,7.35c2.05,1.94,4.61,2.9,7.66,2.9s5.71-.96,7.72-2.9c2.02-1.93,3.02-4.37,3.02-7.35s-1.01-5.41-3.02-7.31Zm-16.4,27.82v66.34h17.25v-66.34h-17.25Z" />
              <path d="m812.67,406.97c2.49,0,5.26.44,8.33,1.32l2.3.61,3.13-13.99c-4.42-2.02-9.65-3.02-15.68-3.02-7.56,0-13.96,2.27-19.19,6.82-5.23,4.55-7.84,11.25-7.84,20.09v67.43h17.25v-45.06l-14.94-4.99h37.02v-16.29h-22.08v-.25c0-8.43,3.91-12.66,11.71-12.66Z" />
              <path d="m879.51,419.87l-16.52,38.84-16.4-38.84h-18.35l25.58,57.54-14.86,33.36h18.35l40.68-90.9h-18.46Z" />
            </g>
          </svg>
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
