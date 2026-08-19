const plugin = require('tailwindcss/plugin');
const defaultTheme = require('tailwindcss/defaultTheme');

/**
 * Dinify Admin design tokens — spec §16.
 *
 * VISUAL DISTINCTNESS FROM THE RESTAURANT PORTAL IS A SAFETY REQUIREMENT, not a
 * preference. During a delegated support session both applications are open at once,
 * and confusing them means acting in the wrong place. Four things carry that
 * distinction: dark chrome around a light working area, a denser and smaller type
 * scale, much tighter radii, and a single typeface.
 *
 * THE ROOT IS 16px. Dinify-Frontend uses a 14px root, and its own tailwind.config.js
 * records that as the cause of the arbitrary `text-[..px]` (and half-pixel) values that
 * later had to be swept out of it. Every size below is px-fixed anyway, so the root
 * only has to be honest.
 *
 * COLOUR VALUES LIVE IN src/styles.css as HSL triples; this file only names them.
 * They are HSL triples rather than hex so Tailwind's `/<alpha-value>` opacity modifier
 * works (`bg-admin-accent/10`), which is the same construction the sibling uses.
 *
 * Nothing under `src/app` may spell a colour, an arbitrary text/rounded size, or a
 * second font family — enforced by scripts/check-design-tokens.mjs.
 */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      fontFamily: {
        // ONE typeface. Gabarito and Bricolage Grotesque carry the customer surfaces'
        // identity and must not be reproduced here — that identity is precisely what
        // has to be distinguishable during a delegated session.
        sans: ['"Plus Jakarta Sans Variable"', ...defaultTheme.fontFamily.sans],
      },

      colors: {
        // --- Chrome: the dark frame (sidebar, top bar, modal scrim) ---
        chrome: {
          DEFAULT: 'hsl(var(--admin-chrome) / <alpha-value>)',
          raised: 'hsl(var(--admin-chrome-raised) / <alpha-value>)',
          border: 'hsl(var(--admin-chrome-border) / <alpha-value>)',
          fg: 'hsl(var(--admin-chrome-fg) / <alpha-value>)',
          'fg-muted': 'hsl(var(--admin-chrome-fg-muted) / <alpha-value>)',
        },

        // --- Working area: the light surface where the work happens ---
        canvas: 'hsl(var(--admin-canvas) / <alpha-value>)',
        surface: {
          DEFAULT: 'hsl(var(--admin-surface) / <alpha-value>)',
          sunken: 'hsl(var(--admin-surface-sunken) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'hsl(var(--admin-border) / <alpha-value>)',
          strong: 'hsl(var(--admin-border-strong) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'hsl(var(--admin-fg) / <alpha-value>)',
          muted: 'hsl(var(--admin-fg-muted) / <alpha-value>)',
          subtle: 'hsl(var(--admin-fg-subtle) / <alpha-value>)',
        },

        // --- THE interactive colour. One token, read by every button, link, focus
        // --- ring and selected state. §16 keeps brand red under an explicit review
        // --- trigger, so retinting the whole interactive surface is one line in
        // --- styles.css and nothing else.
        'admin-accent': {
          DEFAULT: 'hsl(var(--admin-accent) / <alpha-value>)',
          hover: 'hsl(var(--admin-accent-hover) / <alpha-value>)',
          fg: 'hsl(var(--admin-accent-fg) / <alpha-value>)',
          soft: 'hsl(var(--admin-accent-soft) / <alpha-value>)',
        },
        // --- Separate from the accent on purpose: the palette must distinguish
        // --- "do this" (accent) from "careful" (warning) from "something is
        // --- wrong / this destroys something" (danger).
        'admin-danger': {
          DEFAULT: 'hsl(var(--admin-danger) / <alpha-value>)',
          hover: 'hsl(var(--admin-danger-hover) / <alpha-value>)',
          fg: 'hsl(var(--admin-danger-fg) / <alpha-value>)',
          soft: 'hsl(var(--admin-danger-soft) / <alpha-value>)',
        },
        'admin-warning': {
          DEFAULT: 'hsl(var(--admin-warning) / <alpha-value>)',
          fg: 'hsl(var(--admin-warning-fg) / <alpha-value>)',
          soft: 'hsl(var(--admin-warning-soft) / <alpha-value>)',
        },

        // --- Lifecycle states (restaurants_app.controllers.lifecycle) + TEST.
        // --- `suspended` shares the warning hue DELIBERATELY: suspension is the
        // --- "careful" state, so a second amber would be a distinction without a
        // --- difference. TEST is separated by FORM as well as hue — it is the only
        // --- solid-filled pill in the system (see StatusPillComponent).
        state: {
          onboarding: 'hsl(var(--admin-state-onboarding) / <alpha-value>)',
          'onboarding-soft': 'hsl(var(--admin-state-onboarding-soft) / <alpha-value>)',
          live: 'hsl(var(--admin-state-live) / <alpha-value>)',
          'live-soft': 'hsl(var(--admin-state-live-soft) / <alpha-value>)',
          suspended: 'hsl(var(--admin-state-suspended) / <alpha-value>)',
          'suspended-soft': 'hsl(var(--admin-state-suspended-soft) / <alpha-value>)',
          offboarded: 'hsl(var(--admin-state-offboarded) / <alpha-value>)',
          'offboarded-soft': 'hsl(var(--admin-state-offboarded-soft) / <alpha-value>)',
          test: 'hsl(var(--admin-state-test) / <alpha-value>)',
          'test-fg': 'hsl(var(--admin-state-test-fg) / <alpha-value>)',
          neutral: 'hsl(var(--admin-state-neutral) / <alpha-value>)',
          'neutral-soft': 'hsl(var(--admin-state-neutral-soft) / <alpha-value>)',
        },
      },

      fontSize: {
        // Semantic, px-fixed, and denser than the sibling's (26/18/15/13/12/11).
        // No component may use an arbitrary size — the token guard enforces it.
        'admin-page': ['20px', { lineHeight: '26px', fontWeight: '600', letterSpacing: '-0.01em' }],
        'admin-section': ['15px', { lineHeight: '20px', fontWeight: '600' }],
        'admin-body': ['13px', { lineHeight: '18px' }],
        'admin-label': ['12px', { lineHeight: '16px', fontWeight: '500' }],
        // 11px is the hard floor, matching the sibling's. Nothing renders smaller.
        'admin-meta': ['11px', { lineHeight: '14px' }],
        // Uppercase pill / column-header treatment. Same 11px floor, tracked out so it
        // stays legible at weight.
        'admin-micro': ['11px', { lineHeight: '14px', fontWeight: '600', letterSpacing: '0.06em' }],
      },

      borderRadius: {
        // Three steps, 8px maximum — much tighter than the sibling's 20px
        // `rounded-card`. Density reads as a control plane rather than a menu.
        sm: 'var(--admin-radius-sm)',
        DEFAULT: 'var(--admin-radius-md)',
        md: 'var(--admin-radius-md)',
        lg: 'var(--admin-radius-lg)',
      },

      spacing: {
        // CHROME METRICS. §16 asks for explicit pixel heights on any chrome element
        // whose height feeds a sticky offset or a scroll margin, never a value
        // inferred from font math. Expressed as spacing tokens rather than one-off
        // `h-[56px]` values so the height and the offset that must match it
        // (`h-topbar` / `top-topbar` / `scroll-mt-topbar`) cannot drift apart.
        topbar: '56px',
        sidebar: '232px',
        row: '44px',      // interactive table row — above the WCAG 2.2 minimum
        control: '40px',  // buttons, inputs, menu items
      },

      boxShadow: {
        'admin-sm': '0 1px 2px 0 hsl(var(--admin-shadow) / 0.06)',
        'admin-md': '0 4px 12px -2px hsl(var(--admin-shadow) / 0.12), 0 1px 3px 0 hsl(var(--admin-shadow) / 0.08)',
        'admin-lg': '0 16px 40px -8px hsl(var(--admin-shadow) / 0.24), 0 4px 12px -4px hsl(var(--admin-shadow) / 0.12)',
      },
    },
  },
  plugins: [
    plugin(({ addUtilities }) => {
      addUtilities({
        // Applied to EVERY numeric column (§16). Without it, a column of figures in a
        // proportional font will not align on the digit, which is the whole reason to
        // put money in a table.
        '.tabular-figures': {
          fontVariantNumeric: 'tabular-nums lining-nums',
          fontFeatureSettings: '"tnum" 1, "lnum" 1',
        },
      });
    }),
  ],
};
