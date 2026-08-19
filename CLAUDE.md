# Dinify Admin — Claude Code Context

## Project Overview
The platform-admin control plane for Dinify — the operator cockpit for a one-person
platform company. It takes a signed restaurant from handshake to live, paying tenant
and keeps it that way, without opening a Django shell.

This is a **separate origin** (`admin.dinifyapp.com`), a separate identity plane
(`account_type = 'platform_staff'`), and a separate API (`/api/admin/v1`). It shares
NOTHING with the restaurant portal or the diner app at runtime. Dinify-Frontend has
contained no code path that can authenticate an administrator since its PR-6.

The governing specification is **`ADMIN_PORTAL_MVP_v2_3.md` at the repo root** — read
it before designing anything. This file records how the code implements it; the spec
records what it has to do and why.

A parallel `AGENTS.md` carries Codex/other-agent instructions that defer to this file
— `CLAUDE.md` remains the authoritative project guide, so keep it current when
conventions change.

## Current Implementation Status

**Step 0 (scaffold) only.** This repo currently contains the system, not the screens.

- Shell, navigation and routing: ✅ the five §9 destinations, the §9.2 URL scheme,
  URL-backed filters
- Authentication against `/api/admin/v1/auth/*`: ✅ all five routes, both login
  states, the break-glass branch, bootstrap ordering
- HTTP layer: ✅ CSRF interceptor, four-case error classifier, elevation queue,
  defect reporting
- Design tokens + the guard that enforces them: ✅
- Primitives (status pill, table, button): ✅
- Formatting (UGX, EAT time, server-anchored relative time): ✅
- Mock mode + primitives gallery: ✅ `npm start` renders everything with no backend
- **Restaurant directory, detail workspace, readiness engine, lifecycle controls,
  owner invitation, delegated drill-in, support triage, receivables, activity feed:
  ❌ NOT BUILT.** Every destination is a placeholder with a real written empty state.
  These are spec §15 steps 1–10.
- **Deployment: ❌ NONE.** See "Deployment" below.

## Tech Stack
- Angular **21.2.x**, esbuild `@angular/build` application builder
- TypeScript **~5.9.3** (`tsconfig.json` mirrors Dinify-Frontend's exactly)
- Tailwind CSS **3.4.x** — auto-wired by `@angular/build` from `tailwind.config.js`;
  there is deliberately no PostCSS config file, matching the sibling
- Node **20** (pinned in both workflows)
- Karma + Jasmine via `@angular/build:karma`, `ChromeHeadlessNoSandbox` in CI
- ESLint **9** with flat config, typescript-eslint 8, angular-eslint 21.4
- Repo: `mugak1/Dinify-Admin`

### Dependencies — two deliberate omissions, so nobody copies them across
- **`--legacy-peer-deps` is NOT used, and must not be added.** CI runs plain `npm ci`.
  Evidence gathered during recon: a clean install of this dependency set resolves with
  zero peer conflicts, and so does Dinify-Frontend's own `package.json` today (a fresh
  `npm install --dry-run` with no lockfile succeeds without the flag). The flag there
  is a historical artefact. Carrying it over would suppress real conflict reporting
  for no benefit.
- **There is no `overrides` block, and none is needed.** The sibling's four entries
  (`lodash-es`, gaxios's `uuid`, `@grpc/grpc-js`, `esbuild`) exist to hold
  `firebase-tools` / `ng2-charts` / `gaxios` transitives at audit-zero. None of those
  packages are dependencies here, and `npm audit` reports 0 vulnerabilities without
  them.

### No component library, no icon package
Inline SVG only. `lucide-angular` is absent by design — the sibling removed it in
PR-6, and reintroducing it here would be a regression in both repos. There is no
`@angular/cdk` either: three primitives do not justify it, so the one dialog in this
repo implements its own focus trap (see `ui/elevation-dialog.component.ts`).

## Code Conventions — CRITICAL

- **STANDALONE COMPONENTS ONLY. No `NgModule` anywhere, including specs.** The
  `@angular-eslint/prefer-standalone` rule is left ON (the sibling disables it because
  it still has seven NgModules; that reason does not apply here).
- **Built-in control flow only** — `@if` / `@for` / `@switch`. Never `*ngIf` /
  `*ngFor`.
- **Signals for component state throughout.** `input()` / `output()` /
  `computed()` / `signal()`. `inject()` rather than constructor DI —
  `@angular-eslint/prefer-inject` is ON for the same reason as above.
- **Templates are inline** (`template:` in the `@Component`), so the explanatory
  comments and the markup they explain stay adjacent. `angular.processInlineTemplates`
  is configured, so template lint rules apply to them.
- **Zone-based change detection**, matching Dinify-Frontend — but nothing in this repo
  depends on zone behaviour (no `NgZone.run`, no `setTimeout` used to force a tick,
  every component `OnPush`, every piece of state a signal), so a later zoneless flip is
  a one-line provider swap in `app.config.ts`.

### Three deliberate divergences from Dinify-Frontend
These are intentional modernisation, not drift. Architecture stays in lockstep with
the sibling (Angular major, zone-based CD, standalone, signals); the mechanisms below
are where the sibling is legacy and this repo is not.

| | Dinify-Frontend | Here |
|---|---|---|
| HTTP interceptors | class-based, `HTTP_INTERCEPTORS` + `withInterceptorsFromDi()` | **functional**, `provideHttpClient(withInterceptors([...]))` |
| Bootstrap | `platformBrowserDynamic().bootstrapModule(AppModule)` | **`bootstrapApplication()`** |
| Guards | class-based `@Injectable` `AuthGuard` | **functional `CanActivateFn`** |

A fourth divergence is the lint toolchain — see below.

### ESLint 9 flat config
The sibling is on ESLint 8 + `.eslintrc.json`. ESLint 8.57.1 is end-of-life and npm
says so on every install; an unsupported linter in the CONTROL-PLANE repo is a posture
cost that only grows. The **rule set is mirrored rule-for-rule** even though the file
format is not — the constraints on code are the same. **This repo is the reference for
the sibling's eventual flat-config migration.**

## Design Tokens — spec §16

**Visual distinctness from the restaurant portal is a SAFETY requirement, not a
preference.** During a delegated support session both applications are open at once,
and confusing them means acting in the wrong place. Four things carry it: dark chrome
around a light working area, a denser and smaller type scale, much tighter radii, and
a single typeface.

- **16px root font.** NOT the sibling's 14px — its own `tailwind.config.js` records
  that root as the cause of the arbitrary `text-[..px]` (and half-pixel) values it
  later had to sweep out. Every size here is px-fixed regardless.
- **Semantic, px-fixed type scale**, denser than the sibling's:
  `text-admin-page` (20) / `text-admin-section` (15) / `text-admin-body` (13) /
  `text-admin-label` (12) / `text-admin-meta` (11) / `text-admin-micro` (11, uppercase,
  tracked). **11px is the hard floor.** No component may use an arbitrary size.
- **Three radius steps, 8px maximum**: `rounded-sm` 3 / `rounded`(`-md`) 5 /
  `rounded-lg` 8. Far tighter than the sibling's 20px `rounded-card`.
- **`--admin-accent` is THE single interactive colour token**, set to brand red
  `#FF2C32` (byte-identical HSL to the sibling's `--primary`, so the two cannot
  drift). Every button, link, focus ring and selected state reads it and nothing else.
  §16 keeps brand red under an explicit review trigger, so **retinting the entire
  interactive surface is one line in `src/styles.css`** — which is only true because
  of the guard below.
- **`--admin-danger`** (a darker red, ~6.4:1 on white) is for destructive actions ONLY
  — never the accent. **`--admin-warning`** (amber) is for "careful". The palette must
  distinguish *do this* from *careful* from *something is wrong*.
- **Lifecycle state colours** for `onboarding` / `live` / `suspended` / `offboarded`,
  plus a distinct TEST treatment. `suspended` shares the warning hue deliberately —
  suspension IS the careful state, and a second amber would be a distinction without a
  difference. **TEST is the only SOLID-FILLED pill in the system**, so it differs in
  FORM as well as hue: an operator scanning a directory reads shape before colour.
- **ONE typeface: Plus Jakarta Sans.** Gabarito and Bricolage Grotesque are absent by
  design — they carry the customer surfaces' identity, which is exactly what must not
  be reproduced here.
- **`.tabular-figures`** on every numeric column (§16). In a proportional font a
  column of figures does not align on the digit, which defeats the point of putting
  money in a table.
- **Chrome metrics are spacing tokens**, not one-off values: `topbar` 56 / `sidebar`
  232 / `row` 44 / `control` 40. §16 asks for explicit pixel heights on any chrome
  element whose height feeds a sticky offset or scroll margin, never a value inferred
  from font math — expressing them as tokens means the height (`h-topbar`) and the
  offset that must match it (`top-topbar`, `scroll-mt-topbar`) cannot drift apart.
  Interactive rows and controls are 40–44px, above the WCAG 2.2 minimum.
- **Visible focus everywhere**, declared once in `styles.css` as a `:focus-visible`
  outline in the accent, so nothing has to remember to add it and nothing can suppress
  it by omission. An element managing its own ring opts out with
  `data-focus-ring="self"` (the table does, so the ring sits inside the row bounds).

### The token guard — `scripts/check-design-tokens.mjs`
Modelled on Dinify-Frontend's `scripts/check-platform-roles.mjs`, **including its
`--self-test` mode**. It fails the build if anything under `src/app` contains a hex
colour literal, an `rgb()`/`hsl()` literal, an arbitrary `text-[..]`/`rounded-[..]`
value, or a font family other than the single token.

**Without it the tokens are a suggestion.** The §16 brand-red review is only cheap
while the accent lives in one place; one `bg-[#FF2C32]` in a component and it stops
being a one-line change, and nobody finds out until the review lands and half the
buttons do not move.

Scope is `src/app` only — `src/styles.css` and `tailwind.config.js` are where design
values BELONG. The `ALLOWLIST` is empty and should stay that way: if you are about to
add an entry, the question is whether the token system is missing a token.

One thing worth knowing about the matcher: **Angular template reference variables
collide with short hex colours** (`<input #fed />` is three hex digits). The self-test
caught that before the tree did, and `hasHexColour` disambiguates by context. That is
the case study for why `--self-test` exists.

## URL and Routing — spec §9.2

```
/                                 /support
/restaurants                      /support/:issueId
/restaurants/:id                  /receivables
/restaurants/:id/readiness        /receivables/:invoiceId
/restaurants/:id/billing          /activity
/restaurants/:id/support          /login
/restaurants/:id/activity
```

Plus a `**` → `/` fallback, which is not a destination — it stops a mistyped URL
rendering a blank frame. `app.routes.spec.ts` pins the exact set.

- `/login` sits **outside** the shell. Everything else is behind `authGuard` on the
  shell parent — one guard, not twelve that can drift apart.
- The restaurant tabs are **children** of `/restaurants/:id`, so the §9.1 persistent
  header is genuinely persistent and cannot drift between tabs.
- `withComponentInputBinding()` binds `:id` / `:issueId` / `:invoiceId` straight to
  component `input()`s.

### FILTERS LIVE IN THE URL, NOT COMPONENT STATE
`core/url/query-param.ts` (`urlState()` + `stringParam` / `booleanParam` /
`enumParam`) binds a query parameter to a signal and writes back with
`replaceUrl: true` + `queryParamsHandling: 'merge'`, batched to one navigation per
microtask.

**Step 1 must inherit this, not reinvent it.** Home's needs-attention items link INTO
a filtered directory ("3 restaurants have outstanding go-live blockers" → the filtered
list); if the filter lives in a component field those links cannot exist, and the
inbox §11 builds the product around does not work. `/restaurants` already binds
`?status=` and `?attention=` as the working proof, and the round trip is spec-pinned.

Three properties worth not undoing: writes REPLACE rather than push (Back leaves the
screen, it does not undo a keystroke); writes MERGE (one filter cannot drop another);
and a parameter at its default is OMITTED (`?attention=false` never appears).

### Deep links need the server's help
Under `ng serve` the dev server rewrites unknown paths to `index.html`, so refreshing
`/restaurants/abc/readiness` works. **In production this requires an Apache SPA
fallback that serves `index.html` for unmatched paths while EXCLUDING `/api`** — that
is 0C's job. Until 0C ships, deep links work under `ng serve` only.

## The Backend Auth Contract

All five routes, read from `platform_admin_app` source. Browser paths are
`/api/admin/v1/...`: Apache mounts the admin WSGI app at `/api` and **strips** that
prefix, so Django's `admin/v1/...` routes are reached with it.

| | login/ | verify/ | logout/ | session/ | elevate/ |
|---|---|---|---|---|---|
| Method | POST | POST | POST | GET | POST |
| `authentication_classes` | **`[]`** | **`[]`** | **`[]`** | `AdminSessionAuthentication` | `AdminSessionAuthentication` |
| CSRF required | No | No | No | No (safe method) | **YES** — `X-CSRFToken` |
| Body | `{username, password}` | `{method, code}` | none | — | `{method, code}` |
| Success | `200 {data:{second_factor_required, recovery_code_required}}` | `200 {data:{username, expires_at, used_recovery_code, lockout_cleared, recovery_codes_remaining}}` | `200` always | `200 {data:{…6 fields}}` | `200 {data:{elevated_at, used_recovery_code, recovery_codes_remaining}}` |
| Failure | `401 {status,message:"Invalid credentials."}` · `429` | `401 {status,message:"Invalid or expired verification."}` · `429` | *cannot fail* | `401 {detail}` | `403 {status,message}` · `403 {detail:"CSRF Failed: …"}` · `401` · `429` |
| Cookies | sets `__Host-dinify_admin_challenge` (5 min) | sets `__Host-dinify_admin_session` (8 h); **ROTATES** CSRF; clears challenge | clears session + challenge | **ENSURES** CSRF | none |

- **`verify/` ROTATES the CSRF token** (`rotate_token`) — a fresh secret per session,
  mirroring `django.contrib.auth.login()`. Another tab signing in therefore
  invalidates this one's token.
- **`session/` ENSURES it** (`get_token`) — reuses an existing secret, so bootstrapping
  from any tab at any time cannot invalidate what the others hold.
- CSRF cookie: `__Host-dinify_admin_csrftoken`, `HttpOnly=false` (the SPA must read
  it), `Secure`, `Path=/`, no `Domain`, `SameSite=Strict`. **Not** Django's default
  `csrftoken` — that belongs to the customer plane.
- **Every login and verify failure returns ONE byte-identical body** — unknown user,
  wrong password, not platform staff, inactive, unenrolled, holding a restaurant
  membership, and locked out are indistinguishable, and the password check runs
  against a dummy hash for unknown users so response TIME does not leak existence
  either. **Display the server's message verbatim. Never interpret it, elaborate on
  it, add client-side hints, or offer "did you mean" help.** The uniformity is a
  disclosure control.
- **`recovery_code_required: true` is the BREAK-GLASS branch**: the account is locked
  out and the password was correct, and the challenge accepts a RECOVERY CODE ONLY (a
  TOTP code is refused as an ordinary bad code). Honouring it is what makes a lockout
  clearable from the portal; without it the only way back in is
  `manage.py unlock_platform_admin` on the box.
- **`method` is explicit and has no default.** The backend removed
  try-TOTP-then-fall-through-to-recovery: TOTP decrypts the stored secret before it
  can reject a code and the crypto layer fails closed, so one lost
  `ADMIN_SECRET_ENCRYPTION_KEY` took the recovery codes down with it.
- Challenge: 5-minute TTL, `ADMIN_CHALLENGE_MAX_ATTEMPTS = 5`. A plain bad code KEEPS
  the challenge cookie so the operator can retry; an exhausted or expired challenge
  clears it. The login page allows ONE retry at step 2 and then returns to step 1
  cleanly, rather than stranding the operator on a dead challenge.

### BOOTSTRAP ORDERING IS LOAD-BEARING
`provideAppInitializer` runs `GET /auth/session/` before the shell renders. 200 →
authenticated; 401 → the guard routes to `/login`. **This is also what guarantees the
CSRF cookie exists before any write can be attempted**, because `session/` is one of
only two places the server issues it. Do not move it.

### Logout does NOT clear the CSRF cookie
Deliberate. It is inert without a session, and `verify/` rotates it on the next
sign-in — clearing it would only add a second place that touches CSRF state. Client
state is cleared regardless of the logout response: a failed revoke must not leave the
operator looking at a portal they believe they have left.

## The Error Classifier — one place, four cases

`core/api/error.interceptor.ts`. They are genuinely different things, not four shades
of "an error happened".

1. **401 — the session is gone.** 8-hour absolute expiry, the 30-minute idle timeout,
   or revocation. Clear client state, route to `/login?returnUrl=`. **Never retry.**
   Exception: a 401 from `login/` or `verify/` is a rejected credential, and the
   bootstrap `session/` read is expected to 401 for a signed-out operator.
2. **403 carrying the CSRF message** — the token is stale (another tab signed in and
   `verify/` rotated it). Re-bootstrap with `GET /auth/session/` **once**, retry
   **once**, then hard-fail as a defect. Not an infinite retry.
3. **403 carrying the ELEVATION message** — an EXPECTED SECURITY STATE, not an error.
   Open one re-elevation modal, `POST /auth/elevate/`, and **replay the original
   request** on success. The failure mode being designed out is: click Suspend, get a
   mysterious 403, lose what you were doing.
4. **403 from `/auth/elevate/` itself** — the re-elevation ATTEMPT failing (wrong
   code, locked out, ineligible). Surfaced inside the modal. **Never treated as "needs
   elevation"**, or the operator loops.

Everything else surfaces.

### The two match strings, and why they are fragile
```
ELEVATION_REQUIRED_DETAIL   = 'This action requires recent re-authentication.'
CSRF_FAILURE_DETAIL_PREFIX  = 'CSRF Failed'
```
Both live in `core/api/api.constants.ts` and are spelled nowhere else. They carry a
`TODO(backend)`: a follow-up PR should attach stable machine-readable error codes and
normalise the response envelope, at which point these and the classifier get simpler.

**MATCH ONLY AGAINST `detail`.** There is no custom DRF exception handler on the admin
plane, so two body shapes coexist: everything DRF raises is `{detail}`, every
hand-written endpoint denial is `{status, message}`. Cases 2 and 3 are `detail`; case
4 is `message`, so they cannot collide. The elevate route is ALSO excluded from case 3
explicitly — redundant given the shape difference, and stated anyway because an
invariant this important should not rest on a property a backend tidy-up could change.

### Bounded recovery
Both recoveries re-enter the classifier on the replayed request (`catchError` catches
from its source, not from what its handler returns — without re-entry the second
failure would sail past unclassified and the bound would exist only in the comments).
`HttpContext` flags `CSRF_RETRIED` and `ELEVATION_REPLAYED` force the exhausted branch
and terminate the recursion. **One elevation, one replay. One re-bootstrap, one
retry.**

### The elevation queue
`ElevationService` is a **singleton with a queue**: three concurrent 403s show ONE
modal and replay all three on success. Escape/Cancel fails every queued request with
an explicit `ElevationCancelledError` — nothing hangs silently.

### One error-message extractor
`core/api/error-message.ts::extractErrorMessage` reads `detail`, then `message`, then
field errors, then falls back. **Use it in every error path**, or every screen from
step 1 onward reinvents the two-shape problem and they diverge.
`extractDetail` is the narrower reader the CLASSIFIER uses — keeping them separate is
what makes the three 403s impossible to confuse rather than merely unlikely to be.

### Defects surface the request ID
`X-Request-ID` is the only header the admin plane adds, a server-generated uuid4, and
the correlation key into the append-only `AdminAuditLog`. Any error reaching the
operator as a defect (unclassified 4xx/5xx, exhausted CSRF retry, exhausted elevation
replay) shows it. That is the difference between "it broke when I clicked suspend" and
a report that resolves to one server log line.

### Elevation staleness is computed against `server_time`, never `Date.now()`
`SessionStore.serverNowMs()` = the last `server_time` the server stated, advanced by
elapsed `performance.now()`. Two properties: it survives an operator administering
from another timezone on a machine with a skewed clock, and it survives the system
clock being changed mid-session. `elevationStale()` is exposed as a signal so a future
preflight screen can PRE-EMPT the modal rather than discovering staleness via a 403.
`ELEVATION_MAX_AGE_MS` mirrors a server constant this client cannot read — it is
ADVISORY, and the server's 403 stays authoritative.

### DO NOT BUILD A SESSION COUNTDOWN
`ADMIN_SESSION_IDLE_TIMEOUT` (30 minutes) appears in **no response body and no
response header** — verified by grep across `platform_admin_app`. Only the 8-hour
`expires_at` is visible. A countdown built from it would read "6h 12m remaining" to an
operator whose session died half an hour ago: not an imprecise indicator, a confident
false statement, on the surface where they decide whether it is safe to start
something consequential. The reasoning is in a comment on `SessionStore` so nobody
adds one later. If a warning is genuinely wanted, the fix is a backend PR exposing the
idle deadline.

## Navigation — spec §9

**Exactly five destinations:** Home, Restaurants, Support, Receivables, Activity. Then
the operator name and Sign out.

**Onboarding, Readiness, Lifecycle, QR, Delegation and Payments MUST NOT appear in
global navigation.** They are things done TO a restaurant and live inside it.

> **THE RULE for future capability: it becomes another restaurant-detail tab, or
> another needs-attention condition on Home. NOT a sixth sidebar item.**

One object dominates this portal — the restaurant. If each restaurant-scoped concern
became a top-level destination the portal would fragment immediately, and the operator
would spend their day asking "which screen was that on". `app.routes.spec.ts` pins the
count and the labels.

## Primitives — three, and no more

1. **`app-status-pill`** — the four lifecycle states, plus TEST and neutral. **NEVER
   INTERACTIVE**: a plain `<span>`, no click handler, no `tabindex`, no `role`, no
   hover state, no `cursor-pointer`. §16: badges are status, never a control.
2. **`app-admin-table`** — dense rows, 44px interactive rows, tabular numerals on
   numeric columns, roving tabindex with Arrow/Home/End/Enter, visible focus, and a
   REQUIRED written empty state. Tables, not card grids.
3. **`app-admin-button`** — `primary` (accent) / `secondary` / `destructive` (danger) /
   `ghost`, plus a `pending` state. **`pending` is the mechanism that enforces §16's
   ban on optimistic UI for consequential writes**, not decoration: a lifecycle
   transition is only real once its `AdminAuditLog` row commits, and a button that
   springs back before that has told the operator something that may not be true.

A page-header/empty-state helper is the obvious first addition in step 1; it was
deliberately not pre-built, which is why the placeholder pages repeat a little markup.

### `Restaurant.is_test` does not exist yet
Confirmed against `restaurants_app/models.py`. What exists is **`Order.is_test`**
(migration `orders_app/0035`), and it means something different: an order placed while
the restaurant was still `onboarding` — a pre-go-live REHEARSAL order, operationally
real and commercially invisible. **The `test` pill variant is mock-driven until the
step-1 backend PR adds a restaurant-level flag.** Do not derive it from order data;
those are different facts.

## Formatting

Pure functions in `core/formatting/`, plus thin pipes, so nothing downstream
reinvents them.

- **Currency**: `UGX 150,000`. No decimals, no faux precision, **never a float** — the
  backend's money fields are Postgres `DecimalField`s that arrive as STRINGS precisely
  so no float touches a money value, and `formatUGX` groups a decimal string
  TEXTUALLY rather than parsing it. A missing amount renders `—`, distinct from `UGX 0`.
- **Time**: `15:42 EAT · 19 Aug 2026`. Always `Africa/Kampala`, always labelled.
  Administration may happen from another timezone and "yesterday at 23:50" must never
  be ambiguous — a lifecycle decision against the wrong day is not a cosmetic error.
- **Relative time anchors on `server_time`**, passed in as a REQUIRED argument so a
  caller with no anchor shows an absolute time rather than silently using the
  browser's clock.

## Mock Mode — how the founder reviews this work

The auth transport sits behind the `ADMIN_AUTH` injection token. `npm start` (the
default `development` serve configuration) resolves it to `MockAdminAuthApi`, so **the
complete shell, all five destinations and the dev-only primitives gallery
(`/__gallery`) render with NO backend running.** This is the only way the visual
direction gets reviewed before 0C ships a deploy, and it is how the §16 brand-red
decision will actually be made.

Only the five-route TRANSPORT is mocked. `AdminAuthService`, the login component, both
interceptors and the elevation queue are the same code in both modes, so what gets
reviewed is the real flow.

Levers for the unhappy paths (documented in the mock itself): a username containing
`locked` → the break-glass branch; containing `low` → the low-recovery-codes warning;
code `000000` → the uniform verification failure; empty credentials → the uniform 401.

`ng serve --configuration=live` uses the real transport against `/api/admin/v1`.

### Neither the mock nor the gallery reaches production
`angular.json`'s production configuration **file-replaces** `src/app/dev/dev-tools.ts`
with `dev-tools.prod.ts`, whose exports are empty and which imports nothing from
`src/app/dev`. So they are not merely unreachable — they are not in the production
module graph at all, rather than depending on the bundler eliminating dead code.

`scripts/check-mock-isolation.mjs` CHECKS that against the built output by scanning
for two build markers (emitted through `console.warn` and a rendered `data-` attribute
so a minifier cannot drop them). It fails loudly when `dist/` is missing, so a green
result can never mean "there was nothing to look at". It has been verified to fail
when a marker is deliberately reintroduced.

## Verification

There is **no `/dinify-check`** for this repo — that command is backend-only. CI is
the gate. `./scripts/verify.sh` runs the same checks locally in the same order.

Before raising a PR:
1. `npm run type-check` — zero errors
2. `npm run lint` — clean
3. `npm run check:tokens` — self-test then the real scan
4. `npm run test:ci` — headless Chrome
5. `npm run build:prod` — zero errors
6. `npm run check:mock-isolation` — **after** the build; it scans `dist/`

`.github/workflows/ci.yml` (job `validate`, on `pull_request` to `main`) runs all six
on Node 20 with plain `npm ci`. `.github/workflows/audit.yml` runs a weekly
`npm audit --audit-level=high` — scheduled and manual only, never a PR check.

## Deployment — THERE IS NONE YET

**Deployment is 0C and does not exist in this repo.** When it lands it is:
build in CI → artefact to a private S3 prefix → GitHub OIDC → `aws ssm send-command`
syncing into `/var/www/dinify-admin`, with an Apache SPA fallback that **excludes
`/api`**.

**Do NOT add** `firebase.json`, `.firebaserc`, rsync, `appleboy/ssh-action`, or any
stored SSH secret. That transport was deliberately retired by backend PR #281: the UAT
instance's security group does not admit GitHub-hosted runners, which is why the old
SSH path died at connect timeout. The backend's `UAT_SSH_*` secrets were deleted
2026-08-18.

## Backend Facts Step 1 Onward Should Not Rediscover

- **`check_go_live_readiness` FAILS CLOSED.** It returns not-ready with the single
  blocker `readiness_not_configured`, so `onboarding → live` is refused on EVERY path
  until Phase 1 builds the real checklist. It used to return ready unconditionally —
  a safety gate that always said yes — and there is deliberately no override. Step 4
  should not discover this as a surprise.
- **`suspended` is the one lifecycle state with distinct diner behaviour**: the diner
  menu answers a graceful **503** there (a diner at a printed QR is told the place is
  temporarily unavailable), while `offboarded` is a flat 404.
- **THE LIFECYCLE CONTROL READS ITS OPTIONS OFF THE SERVER.** `POST
  admin/v1/restaurants/<id>/transition/` already serialises `allowed_transitions` in
  its response (from `lifecycle.allowed_targets`). **Never hardcode the transition
  matrix in this repo** — one authority, on the server, where the row lock and the
  audit entry are.
- In-flight orders are **frozen, not drained**, at `suspended`: staff cannot see,
  advance or cancel them, so the table is never freed. Two consequences are known and
  left for Phase 1 (see the backend's lifecycle section).
- The transition endpoint is elevation-gated (`IsRecentlyElevated`) — which is exactly
  the 403 the error classifier's case 3 exists for.

## Available Slash Commands
None specific to this repo yet.
