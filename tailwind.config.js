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
 * THE `auth-*` TIER IS THE SIGN-IN SURFACE, AND IT IS SCOPED BY NAME ON PURPOSE.
 * `/login` and `/unavailable` are the two screens that render OUTSIDE the shell, to a
 * signed-out operator, one card on an empty page. The control-plane scale above is
 * tuned for the opposite problem — dense tables read all day — so applying it to a
 * lone sign-in card produced the bare grey form this tier replaces.
 *
 * It does NOT relax the four distinctness carriers, and must not be read as doing so:
 * the dark chrome, the 20/15/13/12/11 scale, the 3/5/8 radii and the single typeface
 * all still govern every authenticated surface, because the delegated-support hazard
 * §16 is about is two WORKING surfaces open at once. A signed-out screen has no
 * restaurant on it to act on by mistake. What keeps the two sign-in pages apart is the
 * word ADMIN on the lockup and in the copy, which is exactly where an operator looks
 * before typing platform-staff credentials.
 *
 * Where it mirrors Dinify-Frontend's login it does so AT THIS APPLICATION'S DENSITY —
 * roughly 0.85x, the same ratio the two type scales already sit at (28px display
 * against the sibling's 33, a 48px field against its 52, an 18px card corner against
 * its 22). Copying the sibling's numbers verbatim would have imported its 14px root's
 * arithmetic along with them.
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
          // `fg` is what sits ON the accent; `ink` is the accent USED as ink on a
          // light ground. They are not interchangeable and the difference is a
          // contrast rule, not a preference: brand red on the cream sign-in field is
          // ~3.3:1, which fails for the 11px eyebrow and for a small inline link, so
          // small red text lands here (~6:1) instead. It is still the accent, so §16's
          // brand-red review moves BOTH lines or neither.
          ink: 'hsl(var(--admin-accent-ink) / <alpha-value>)',
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

        // --- The signed-out environment. A warm paper field rather than the dark
        // --- chrome, because there is no working area here to frame — see the
        // --- `auth-*` note at the top of this file.
        auth: {
          paper: 'hsl(var(--admin-auth-paper) / <alpha-value>)',
          'paper-deep': 'hsl(var(--admin-auth-paper-deep) / <alpha-value>)',
          // The warm highlight the top-right wash is drawn from. Not the accent: a
          // second red there reads as an alert on a screen where nothing is wrong.
          glow: 'hsl(var(--admin-auth-glow) / <alpha-value>)',
          // A warm hairline. `line` (cool grey) sits on the canvas and looks dirty
          // against cream, which is the whole reason this is its own token.
          line: 'hsl(var(--admin-auth-line) / <alpha-value>)',
          // Placeholder text and the resting state of a field's leading icon.
          quiet: 'hsl(var(--admin-auth-quiet) / <alpha-value>)',
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

        // --- THE SIGN-IN TIER. Deliberately NOT `admin-*`: these sizes answer a
        // --- different question (one card, read once) and naming them apart is what
        // --- stops a display headline turning up over a restaurant table.
        'auth-display': ['28px', { lineHeight: '34px', fontWeight: '700', letterSpacing: '-0.02em' }],
        'auth-lede': ['14px', { lineHeight: '20px' }],
        // Still the 11px floor. It clears it on weight and tracking, not on size.
        'auth-eyebrow': ['11px', { lineHeight: '14px', fontWeight: '700', letterSpacing: '0.16em' }],
        'auth-label': ['13px', { lineHeight: '18px', fontWeight: '600' }],
        'auth-field': ['15px', { lineHeight: '20px' }],
        'auth-cta': ['15px', { lineHeight: '20px', fontWeight: '700' }],
      },

      borderRadius: {
        // Three steps, 8px maximum — much tighter than the sibling's 20px
        // `rounded-card`. Density reads as a control plane rather than a menu.
        sm: 'var(--admin-radius-sm)',
        DEFAULT: 'var(--admin-radius-md)',
        md: 'var(--admin-radius-md)',
        lg: 'var(--admin-radius-lg)',

        // The sign-in tier, and the ONLY place these two are permitted. The 8px
        // ceiling above still governs every authenticated surface; a lone card on an
        // empty page is not a control plane at density, and cutting an 8px corner
        // into a 420px card reads as an unstyled dialog.
        'auth-card': 'var(--admin-radius-auth-card)',
        'auth-control': 'var(--admin-radius-auth-control)',
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

        // Sign-in tier. Taller than `control` because these are the only inputs on
        // the page and they carry a leading icon; still under the sibling's 52/54.
        'auth-field': '48px',
        'auth-cta': '50px',
        // The leading-icon gutter. A token so the icon well and the input's own left
        // padding cannot drift — the input spans the full interior (see the field
        // comment in auth-shell) and pads itself past the icon.
        'auth-gutter': '44px',
      },

      boxShadow: {
        'admin-sm': '0 1px 2px 0 hsl(var(--admin-shadow) / 0.06)',
        'admin-md': '0 4px 12px -2px hsl(var(--admin-shadow) / 0.12), 0 1px 3px 0 hsl(var(--admin-shadow) / 0.08)',
        'admin-lg': '0 16px 40px -8px hsl(var(--admin-shadow) / 0.24), 0 4px 12px -4px hsl(var(--admin-shadow) / 0.12)',

        // --- Sign-in tier. Cast from the WARM shadow, not `--admin-shadow`: a cool
        // --- grey drop on a cream field reads as a smudge rather than a lift.
        'auth-card':
          '0 1px 2px 0 hsl(var(--admin-auth-shadow) / 0.05), ' +
          '0 30px 60px -28px hsl(var(--admin-auth-shadow) / 0.32)',
        'auth-field': '0 6px 18px -8px hsl(var(--admin-accent) / 0.40)',
        'auth-cta':
          '0 6px 18px -4px hsl(var(--admin-accent) / 0.42), ' +
          '0 2px 6px -2px hsl(var(--admin-accent) / 0.30)',
        'auth-notice':
          'inset 0 1px 0 hsl(var(--admin-surface) / 0.7), ' +
          '0 8px 22px -16px hsl(var(--admin-auth-shadow) / 0.5)',
      },

      maxWidth: {
        // The sign-in card. Narrower than the sibling's 452px, same ratio as the rest
        // of this tier.
        'auth-card': '420px',
      },

      backgroundImage: {
        // The signed-out environment: two soft washes over a warm paper gradient.
        'auth-environment': [
          'radial-gradient(60% 50% at 88% 4%, hsl(var(--admin-auth-glow) / 0.13) 0%, hsl(var(--admin-auth-glow) / 0) 60%)',
          'radial-gradient(52% 44% at 4% 100%, hsl(var(--admin-accent) / 0.07) 0%, hsl(var(--admin-accent) / 0) 60%)',
          'linear-gradient(158deg, hsl(var(--admin-auth-paper)) 0%, hsl(var(--admin-auth-paper-deep)) 100%)',
        ].join(', '),

        // Fine paper grain. A field this large and this flat bands visibly on an
        // ordinary monitor; ~4% of fractal noise over it does not. Inline SVG rather
        // than an image because this repo ships no assets at all (`assets: []`), and
        // a texture is not a reason to start.
        'auth-grain':
          "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22" +
          "%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence" +
          "%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.9%22%20numOctaves%3D%222%22" +
          "%20stitchTiles%3D%22stitch%22%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%22100%25%22" +
          "%20height%3D%22100%25%22%20filter%3D%22url(%23n)%22%20opacity%3D%220.55%22%2F%3E%3C%2Fsvg%3E\")",
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
