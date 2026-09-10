import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * THE DINIFY MARK — emblem and logotype, drawn once for both frames.
 *
 * ── WHY IT IS INLINE SVG AND NOT AN ASSET ─────────────────────────────────────────
 *
 * Dinify-Frontend renders its sidebar logo as `<img src="assets/images/...svg">`, and
 * copying that here would quietly break the one thing §16 depends on. The source asset
 * fills the emblem with a literal brand-red hex and the logotype with white; `src/assets`
 * is OUTSIDE `check-design-tokens.mjs` scope, so those fills would sit in the repo
 * unguarded. §16 keeps brand red under an explicit review trigger, and that review is
 * only cheap while retinting the interactive surface is one line in `src/styles.css` —
 * an asset with a baked hex is exactly the drift the gate exists to prevent, just
 * parked where the gate cannot look.
 *
 * So both halves are drawn from `currentColor` and carry no fill of their own. The
 * gate cannot see an attribute that was never written, which is why
 * `dinify-wordmark.component.spec.ts` asserts it instead.
 *
 * ── WHY IT IS SHELL FURNITURE, NOT A FOURTH PRIMITIVE ─────────────────────────────
 *
 * Same argument as the banners and `app-auth-shell`: a primitive is something SCREENS
 * reach for, and this is something the frames own. It has exactly two hosts — the dark
 * sidebar of the authenticated shell, and the signed-out card — and it exists so they
 * cannot drift. §16 is still three primitives.
 *
 * ── THE TONE IS REQUIRED, AND THE EMBLEM IS NOT TONED ─────────────────────────────
 *
 * The two hosts sit on OPPOSITE grounds, so there is no default that is merely
 * suboptimal on the other one: ink on dark chrome is an invisible logotype, and a
 * missing default is a compile error. Loud beats silent, so the caller states it.
 *
 * The emblem takes no tone at all. It is the accent on both grounds — that is the
 * whole point of it reading `--admin-accent` — and a knob there would be an invitation
 * to draw the brand mark in something that is not the brand colour.
 *
 * ── THE viewBox IS MEASURED, NOT ROUNDED ─────────────────────────────────────────
 *
 * The paths span x 402–898 and y 389.2–510.8. The box is 395 385 510 130: seven
 * units of air either side, and the vertical range the glyphs were drawn in. It was
 * 500 wide when this lived inlined in the auth shell, which ENDED AT 895 and clipped
 * the tail of the "y" — sub-pixel at these sizes, and still the brand mark rendered
 * short. Widening rather than re-cropping keeps the vertical scale identical, so the
 * sign-in card is unchanged. A spec asserts the content fits.
 *
 * HEIGHT COMES FROM THE CALLER, on the host (`class="h-5"`), the same way the sidebar
 * sizes its nav icons at their use sites. The mark keeps its own aspect ratio.
 */
export type WordmarkTone = 'ink' | 'chrome';

/** The logotype half only. Never the emblem — see the note above. */
const TONES: Record<WordmarkTone, string> = {
  ink: 'text-ink',
  chrome: 'text-chrome-fg',
};

@Component({
  selector: 'app-dinify-wordmark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Inline hosts have no height for the mark to fill, so the caller's `h-*` would do
  // nothing and the mark would collapse.
  host: { class: 'block' },
  template: `
    <svg
      viewBox="395 385 510 130"
      class="h-full w-auto"
      role="img"
      aria-label="Dinify"
    >
      <g class="text-admin-accent" fill="currentColor">
        <path d="m543.52,413.67c-1.25-1.6-2.6-3.12-4.03-4.55-8.93-8.93-21.26-14.45-34.88-14.45h-102.58l24.16,28.47c5.07,5.97,12.39,9.57,20.22,9.92l14.5.66c2.48.11,4.76-1.34,5.72-3.63.31-.73.6-1.38.81-1.73,3.44-5.86,9.99-9.68,20.94-9.68,17.97,0,40.99,10.29,40.99,22.99s-23.03,22.99-40.99,22.99c-10.18,0-16.55-3.3-20.16-8.47-.67-.95-1.24-1.97-1.73-3.04-1-2.22-3.23-3.63-5.67-3.52l-11.72.53,5.12,6.03,17.96,21.82c3.99,4.85,8.96,8.68,14.5,11.29,5.54,2.61,11.65,4.02,17.93,4.02,24.58,0,44.95-17.98,48.7-41.5.4-2.55.62-5.15.62-7.82,0-11.44-3.89-21.96-10.42-30.33Z" />
      </g>
      <g [class]="logotype()" fill="currentColor">
        <path d="m631.11,413.84c-8.25-8.05-18.52-12.06-30.82-12.06h-30.53v84.44h30.53c12.3,0,22.57-4.02,30.82-12.06,8.24-8.03,12.36-18.09,12.36-30.16s-4.12-22.12-12.36-30.16Zm-12.14,48.74c-4.82,4.82-11.05,7.23-18.69,7.23h-13.28v-51.63h13.28c7.63,0,13.87,2.42,18.69,7.23,4.83,4.83,7.25,11.03,7.25,18.58s-2.42,13.75-7.25,18.58Z" />
        <path d="m669.41,392.06c-2-1.88-4.58-2.83-7.72-2.83s-5.6.96-7.66,2.89c-2.05,1.94-3.07,4.34-3.07,7.25s1.02,5.42,3.07,7.35c2.06,1.94,4.61,2.9,7.66,2.9s5.72-.96,7.72-2.9c2.02-1.93,3.02-4.37,3.02-7.35s-1.01-5.41-3.02-7.31Zm-16.4,27.82v66.34h17.25v-66.34h-17.25Z" />
        <path d="m737.22,425.42c-4.27-4.65-10.14-6.99-17.62-6.99-8.76,0-15.65,3.5-20.63,10.49v-9.04h-17.25v66.34h17.25v-34.85c0-11.03,4.98-16.54,14.97-16.54,4.42,0,7.59,1.13,9.53,3.38,1.93,2.25,2.89,5.63,2.89,10.14v37.88h17.25v-41.61c0-8.12-2.13-14.52-6.39-19.19Z" />
        <path d="m770.75,392.06c-2.02-1.88-4.58-2.83-7.72-2.83s-5.62.96-7.66,2.89c-2.05,1.94-3.08,4.34-3.08,7.25s1.04,5.42,3.08,7.35c2.05,1.94,4.61,2.9,7.66,2.9s5.71-.96,7.72-2.9c2.02-1.93,3.02-4.37,3.02-7.35s-1.01-5.41-3.02-7.31Zm-16.4,27.82v66.34h17.25v-66.34h-17.25Z" />
        <path d="m812.67,406.97c2.49,0,5.26.44,8.33,1.32l2.3.61,3.13-13.99c-4.42-2.02-9.65-3.02-15.68-3.02-7.56,0-13.96,2.27-19.19,6.82-5.23,4.55-7.84,11.25-7.84,20.09v67.43h17.25v-45.06l-14.94-4.99h37.02v-16.29h-22.08v-.25c0-8.43,3.91-12.66,11.71-12.66Z" />
        <path d="m879.51,419.87l-16.52,38.84-16.4-38.84h-18.35l25.58,57.54-14.86,33.36h18.35l40.68-90.9h-18.46Z" />
      </g>
    </svg>
  `,
})
export class DinifyWordmarkComponent {
  readonly tone = input.required<WordmarkTone>();

  protected readonly logotype = computed(() => TONES[this.tone()]);
}
