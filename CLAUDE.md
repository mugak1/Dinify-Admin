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

**Step 0 (scaffold) complete, plus spec §15 STEP 1 (restaurant directory + detail
workspace), the READ half of STEP 2C (the onboarding and owner-control projection),
STEP 3E.1 (the canonical commercial READ migration) and STEP 3E.2 (the
service-configuration WRITE controls), all rendered on Overview.** Step 2 as a whole is
NOT complete — nothing in this repo creates a restaurant, adopts one, attests owner
control or issues an invitation. **Step 3E is NOT complete either: 3E.2 shipped the two
SERVICE-CONFIGURATION writes, and the SUBSCRIPTION-TERMS writes (3E.3) do not exist.**
Steps 3–10 are otherwise not built.

- Shell, navigation and routing: ✅ the five §9 destinations, the §9.2 URL scheme,
  URL-backed filters
- Authentication against `/api/admin/v1/auth/*`: ✅ all five routes, both login
  states, the break-glass branch, bootstrap ordering, three bootstrap outcomes
- HTTP layer: ✅ CSRF interceptor, transport precondition, four-case error
  classifier, elevation queue, defect reporting, service-status signal
- Operator-visible auth observability: ✅ the service-unavailable view, the
  mid-session outage banner, the notice channel (low recovery codes, cleared
  lockout), and Re-authenticate in the operator menu
- Design tokens + the guard that enforces them: ✅
- Primitives (status pill, table, button): ✅ — the table now also takes
  page-projected cell templates, see "Primitives"
- Formatting (UGX, EAT time, server-anchored relative time): ✅
- Mock mode + primitives gallery: ✅ `npm start` renders everything with no backend,
  now including the directory and the workspace
- **Restaurant directory (`/restaurants`): ✅ BUILT.** Real reads against
  `GET /api/admin/v1/restaurants/`, the seven §15 columns, the three quick views plus
  a lifecycle filter and search, URL-backed filtering/paging, keyboard-first rows, and
  loading / rows / empty / failed as four distinct states.
- **Restaurant detail workspace: ✅ BUILT.** The §9.1 persistent header and a
  populated Overview tab, both from ONE `GET /api/admin/v1/restaurants/<id>/`.
- **Step 2C onboarding truth on Overview: ✅ BUILT (read-only).** An Onboarding panel
  beside Owner renders the backend's onboarding projection — provenance, when the admin
  record appeared, the owner-relationship check, owner control with its evidence, and
  the invitation state. Same one read; no new endpoint, no writer. See "The Onboarding
  Projection" below.
- **Step 3E.1 canonical commercial reads: ✅ BUILT (read-only).** Both the directory and
  the workspace now consume the backend's canonical `commercial` object — payment timing,
  payment collection mode and subscription terms. The directory's `Payment` and
  `Subscription terms` columns and Overview's Commercial panel all read it, and NOTHING
  reads the superseded compatibility fields any more. See "The Commercial Projection".
- **Step 3E.2 service-configuration writes: ✅ BUILT.** The FIRST restaurant-domain
  writes in this repo. Overview's Commercial panel can change **payment timing** and
  **payment collection mode** — two separate named endpoints, each elevation-gated,
  audited, and asserted against the exact axis value the operator loaded. Inline editors,
  no optimistic UI, one local mutation at a time, 409 reloads and requires review. See
  "The Service-Configuration Writes" below.
- **Readiness, Billing, Support and Activity tabs: ❌ still placeholders** with
  written empty states (spec §15 steps 3, 7, 6 and 8).
- **Restaurant creation, restaurant adoption, owner-control attestation, owner
  invitation (issue / reissue / cancel), owner reassignment, the readiness ENGINE,
  lifecycle controls, delegated drill-in, support triage, receivables, the Activity
  screen, Home needs-attention and portfolio metrics: ❌ NOT BUILT.** Spec §15 steps
  2–10. Step 2C gave this repo the onboarding facts to READ; every write in that domain
  is still unbuilt.
- **Deployment: 0C.1 ✅ EMPIRICALLY ACCEPTED (2026-08-20) · 0C.2 ✅ EMPIRICALLY
  ACCEPTED (2026-08-21).** `.github/workflows/deploy.yml` deploys over GitHub OIDC →
  private S3 → AWS SSM. The real Angular application is live on
  `admin.dinifyapp.com` — a real deploy, a real rollback to an older installed
  release and a real re-promotion all succeeded against the live host, and the
  platform-admin login (password + TOTP, session bootstrap, the CSRF-protected
  `auth/elevate/` write) was exercised end to end. 0C.2's first real automatic
  deployment ran on the Step-1 merge and succeeded — see "Deployment" below.

### What Step 1 deliberately does NOT claim
The backend reports several concepts as unconfigured because the models behind them do
not exist, and this repo renders that truth rather than filling the column:

- **Readiness** is the fail-closed `check_go_live_readiness` seam. `not_ready` +
  `readiness_not_configured` is a statement about the CHECKLIST not being built, and
  the portal says so — it never reads as this restaurant having failed one. Step 3
  fills the seam; `readinessLabel` already renders "3 blockers" when it does.
- **Payment mode** was `Not configured`, never inferred — SUPERSEDED by Step 3E.1. The
  backend froze `payment_mode` at null permanently and modelled TWO real axes instead
  (`payment_timing`, `payment_collection_mode`). The old label and its `paymentModeLabel`
  helper are both gone; `require_order_prepayments` remains a diner-checkout toggle and
  is still deliberately absent from the contract.
- **Subscription** was `Not configured` — SUPERSEDED by Step 3E.1. The canonical answer
  is `commercial.subscription_terms`, rendered as the recorded price and recurrence
  rather than a status. `subscriptionLabel` — the one function in this repo that could
  emit the word **Active** — is DELETED. The legacy `Restaurant` columns survive in a
  fenced-off block LABELLED legacy; `legacy_validity_flag` is never rendered as Active,
  Paid, Current, Trial or In good standing.
- **Owner claim** was `Not tracked yet` — SUPERSEDED by Step 2C, which built the
  difference. The Owner panel no longer carries that row at all; `onboarding` is the
  canonical answer and the Onboarding panel is where it is rendered. The
  `owner.claim_tracked` / `owner.claim_status` aliases remain in the typed model
  because the server still sends them, and nothing renders them.
- **TEST tenants now come from the real `Restaurant.is_test`** (backend migration
  `restaurants_app/0057`), not from mock data. See "Primitives".

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
/restaurants/:id/activity         /unavailable
```

Plus a `**` → `/` fallback, which is not a destination — it stops a mistyped URL
rendering a blank frame. `app.routes.spec.ts` pins the exact set.

- `/login` and `/unavailable` sit **outside** the shell. Everything else is behind
  `authGuard` on the shell parent — one guard, not twelve that can drift apart.
- **`/unavailable` is not a destination and not navigable** — it is the third bootstrap
  outcome (below), guarded by `serviceUnavailableGuard` so a bookmarked URL cannot claim
  an outage that is not happening.
- The restaurant tabs are **children** of `/restaurants/:id`, so the §9.1 persistent
  header is genuinely persistent and cannot drift between tabs. That route also carries
  `providers: [RestaurantWorkspaceStore]`, which is what makes the detail read happen
  ONCE for the whole workspace — see "The Restaurant Read Contract".
- `withComponentInputBinding()` binds `:id` / `:issueId` / `:invoiceId` straight to
  component `input()`s.

### FILTERS LIVE IN THE URL, NOT COMPONENT STATE
`core/url/query-param.ts` (`urlState()` + `stringParam` / `booleanParam` /
`enumParam`) binds a query parameter to a signal and writes back with
`replaceUrl: true` + `queryParamsHandling: 'merge'`, batched to one navigation per
microtask.

**Step 1 inherited this rather than reinventing it.** Home's needs-attention items link
INTO a filtered directory ("3 restaurants have outstanding go-live blockers" → the
filtered list); if the filter lived in a component field those links could not exist, and
the inbox §11 builds the product around would not work. `/restaurants` now binds
**`?search=` `?status=` `?attention=` `?page=`** — exactly the parameters
`parse_directory_params` accepts and nothing speculative, because that query string is
DENY-BY-DEFAULT and an unknown key is a 400.

`integerParam` is the fourth codec, and it fails soft like the others: `?page=abc`,
`?page=0` and `?page=1.9` all read as 1 rather than throwing, and since the default is
then omitted the request the client actually emits is still well-formed. **The server
stays the authority on what it will accept** — a filter is not a security boundary and
must never break a page before a request is made.

Three properties worth not undoing: writes REPLACE rather than push (Back leaves the
screen, it does not undo a keystroke); writes MERGE (one filter cannot drop another);
and a parameter at its default is OMITTED (`?attention=false` never appears).

### Deep links need the server's help
Under `ng serve` the dev server rewrites unknown paths to `index.html`, so refreshing
`/restaurants/abc/readiness` works. **In production this requires an Apache SPA
fallback that serves `index.html` for unmatched paths while EXCLUDING `/api`.** That
fallback is configured and live on `admin.dinifyapp.com`: a deep route answers the SPA
document, `/api/...` reaches Django instead, and an asset-shaped path that does not
exist returns a real 404 rather than HTML. `deploy.yml` re-asserts all of that after
every promotion — on the box and again from the public origin — so a regression in the
fallback fails the deploy instead of shipping a portal whose deep links are broken.

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
`provideAppInitializer` runs `GET /auth/session/` before the shell renders. **This is
also what guarantees the CSRF cookie exists before any write can be attempted**,
because `session/` is one of only two places the server issues it. Do not move it.
`bootstrap()` must never reject — a rejection in an app initializer is a blank page
rather than a diagnosis.

### THE BOOTSTRAP READ HAS THREE OUTCOMES, AND THEY ARE GENUINELY THREE

| | Store | `AdminServiceStatus` | The guard sends them to |
|---|---|---|---|
| **200** | adopt | reachable | the shell |
| **401** | **cleared** | reachable | `/login` |
| **no usable answer** | **UNTOUCHED** | unavailable + request id | `/unavailable` |

The third case is status 0, any 5xx, or a 2xx whose body is not a session — see
`classifyTransportFailure` below.

**It was two, and collapsing them cost the operator the diagnosis.** A bare `catch`
cleared the store for all three, so a dead backend routed to the login form, and the
sign-in attempt that followed answered a correct password with **"Invalid
credentials."** — the uniform failure message (a deliberate disclosure control) firing
about a situation it knows nothing about, because `extractErrorMessage` finds nothing
readable in a `ProgressEvent` or an Apache error page and falls back. The operator then
spends the afternoon doubting their password.

So:

- **Never clear a session the server did not deny.** A signed-out state is a claim
  about the operator's credentials; an outage supports no such claim. `isAuthenticated()`
  therefore stays true through a MID-SESSION outage, the shell stays up, and the outage
  shows as a banner inside it — only the cold-start case gets the whole view.
- **The unavailable view must not offer a login form.** A warning beside one still
  invites credentials that cannot work. It states the fact, shows the request id when
  there is one, and offers a MANUAL retry that re-runs `bootstrap()`. No auto-retry and
  no full-screen spinner: the operator needs to KNOW the plane is unreachable, and a
  screen that quietly re-attempts hides exactly that.
- **`SUPPRESS_DEFECT_REPORT` does not apply to unavailability.** Suppressing a 401 on
  an auth route is right — the login form renders it. Suppressing a 502 is how an
  afternoon disappears.

### Logout does NOT clear the CSRF cookie
Deliberate. It is inert without a session, and `verify/` rotates it on the next
sign-in — clearing it would only add a second place that touches CSRF state. Client
state is cleared regardless of the logout response: a failed revoke must not leave the
operator looking at a portal they believe they have left.

### TRANSPORT vs RESPONSE — `core/api/transport-failure.ts`
**"Did we get a usable response at all" is PRIOR to "what did the server say."**
`classifyTransportFailure(error)` answers the first question and returns
`'unavailable'` (status 0, any 5xx, a 2xx whose body fails to parse or fails to adopt),
`'denied'` (401) or `'other'`.

It is called from **three** places, and the reason there is more than one is the same
each time — **the caller must work when no interceptor runs**:

1. `error.interceptor.ts`, as a **precondition ABOVE the four cases, not a fifth case**.
   None of 401 / elevation / CSRF can apply when the answer is "no response".
2. `AdminAuthService.bootstrap()` (and the post-verify read), **because mock mode never
   touches `HttpClient`** — a branch only the interceptor could reach would be dead code
   in the only mode this work is reviewed in.
3. `ElevationService.submit()`, for the same reason: in mock mode nothing else would
   raise the banner that explains why the dialog just closed.

**IT DUCK-TYPES `status`, AND MUST — never `instanceof HttpErrorResponse`.** See the
mock-mode rule under Mock Mode below.

One consequence worth knowing: **5xx and status 0 no longer reach the classifier's
defect tail**, because the precondition claims them first. What remains there is the
unexpected 4xx.

## The Restaurant Read Contract — `core/restaurants/`

Two routes, both `GET`, both session-gated, **neither elevation-gated and neither
audited** — reading the portfolio is ordinary authenticated work, and demanding a second
factor to look at a list is what trains an operator to elevate reflexively.

```
GET /api/admin/v1/restaurants/            -> {status, data: {results[], pagination}}
GET /api/admin/v1/restaurants/<uuid>/     -> {status, data: {...detail}}
```

Shaped like the auth seam and for the same reason — a PORT (`RESTAURANT_API`) plus a
typed transport, so `npm start` renders both screens with no backend and everything above
the port is identical in both modes:

| file | what it is |
|---|---|
| `restaurant.model.ts` | the wire types, mirroring `platform_admin_app/restaurant_reads.py` |
| `restaurant.api.ts` | the `RestaurantApi` port + `RESTAURANT_API` token |
| `restaurant.http.ts` | the real transport, through the ordinary `HttpClient` stack |
| `restaurant.labels.ts` | backend machine values → operator English, in ONE place |
| `load-failure.ts` | classify a failed read, and raise the shared outage state |
| `restaurant-workspace.store.ts` | the detail read, scoped to the `/restaurants/:id` route |

**CLOSED UNIONS WHERE THE SERVER HAS ONE, `string` WHERE IT DOES NOT.** Lifecycle state,
readiness state, audit result, order status, all five Step 2C onboarding vocabularies and
the three Step 3E.1 commercial ones (`PaymentTiming`, `PaymentCollectionMode`,
`BillingIntervalUnit`) are enumerated on the server and are enumerated here.
`readiness.blockers` is `string` because the vocabulary is not written yet, and
`currency` is `string` because it is any three-letter ISO-4217 code the server accepts
rather than a list this repo gets to choose — a union invented for either would be wrong
the day one lands.

**THE TRANSPORT NORMALISES NOTHING.** A null `location`, `last_activity_at`,
`latest_order`, `subscription_terms.current` and a null commercial axis `value` each say
something different from `''` or `0`, and a helpful `?? ''` in the transport would
destroy the distinction the screens render. `recurring_amount` in particular stays the
EXACT decimal string the server sent — see "Formatting".

**ROUTE STRINGS LIVE IN `api.constants.ts`** beside `AUTH_ROUTES`, never concatenated in
a component. `RESTAURANT_ROUTES.detail(id)` encodes the segment.

### One read for the whole workspace
`RestaurantWorkspaceStore` is provided **on the `/restaurants/:id` route**, so exactly
one instance exists per open restaurant and it dies with the route. The PARENT calls
`load()`; the tabs inject and READ. Overview therefore issues no request of its own — the
§9.1 header and Overview are one screen, and two reads can disagree about the same
tenant. A test asserts a single `detail()` call across a tab change.

The load effect wraps `load()` in `untracked()`, and that is load-bearing rather than
tidy: `load()` reads the store's own signals to decide whether the id really changed and
then writes them, so inside a reactive context the write re-triggers the effect that made
it — an unbounded loop that presents as a hung tab, not as an error.

### LOADING, EMPTY, BEYOND-THE-END and FAILED are four different answers
"No restaurants match these filters" is a real answer an operator will act on. A failed
read is not an answer at all. Rendering the second as the first is the same class of
defect as a dead backend presenting as "Invalid credentials." — so a failure clears the
rows, renders a failure state with the request id and a retry, and **never** produces an
empty table.

**ZERO ROWS WITH A NON-ZERO `count` IS ITS OWN STATE**, and missing it was a real defect
(found in review of the Step-1 PR, fixed in the follow-up). The endpoint answers a page
number past the end of the portfolio with an empty `results` and honest metadata rather
than a 404 — deliberately, so the client can see `count` and `pages` and say something
true. Read as "empty" it produced **"No restaurants yet" on a platform with 34
restaurants**, reachable from a stale bookmark, a hand-edited `?page=`, or a last page
whose rows have since been filtered away. The directory now names the case, states how
many restaurants and pages there really are, and offers the last page that holds rows.
`rangeLabel` is guarded for the same case — the naive arithmetic runs backwards with no
rows and renders "24951–34 of 34".

`toLoadFailure()` also reports through `AdminServiceStatus` itself. The interceptor
already does that on the real transport, but **mock mode never touches `HttpClient`**, so
a branch only the interceptor could reach would be invisible in the one mode this work is
reviewed in. Same reasoning as `bootstrap()` and `ElevationService.submit()`; it uses the
shared `classifyTransportFailure` rather than a second implementation.

**THE REPORT IS SYMMETRIC, AND BOTH HALVES ARE REQUIRED.** A read that fails raises the
outage state; a read that SUCCEEDS must clear it, which is what `reportReadReachable()`
is for. Writing only the failure half is easy and invisible on the real transport — the
interceptor's `reachableOnResponse` covers it there — but in mock mode nothing else
clears the flag, so the shell banner kept claiming the control plane was down long after
a retry had succeeded. That was a real defect too, fixed alongside the one above; both
readers now call it on their success path.

### Race safety is `switchMap`, not a sequence counter
Both the directory and the workspace run every read through one `switchMap`, so an older
in-flight response is CANCELLED rather than allowed to land on top of a newer one. Typing
"Kam" then "Kampala" must not leave the wider result under the narrower query: rows that
do not match what the controls say are how an operator opens the wrong tenant.

### The labels are where truthfulness is enforced
`restaurant.labels.ts` is the single place a machine value becomes operator English,
which makes it the single place the portal could start asserting something the database
cannot support. **The rule is: translate, never upgrade.** `legacy_validity_flag` never
becomes "Paid"; `not_applicable` never becomes "Ready"; `readiness_not_configured` is
translated to a sentence about the CHECKLIST, never about the restaurant; an unknown
blocker or audit action is humanised rather than shown raw or dropped. Step 2C added
five more vocabularies under the same rule — `legacy_adopted` becomes "Pre-existing
restaurant" and never "Imported"; `attested` and `invitation_redeemed` both become
"Established" while their EVIDENCE lines stay distinct; `not_applicable` never becomes
"Not issued"; `stale_attestation` becomes "Stale evidence" and never "Established".
`restaurant.labels.spec.ts` pins each of those directly.

Step 3E.1 added the commercial vocabulary under the same rule, and it is where the
pressure is highest: `offline` becomes "Restaurant collects" and never "Cash only";
`psp_online` becomes "Dinify via PSP" and never "Connected", "Ready" or "Live"; an open
terms row becomes its own price and recurrence and never "Active"; a `count` of 2 becomes
"every 2 months" and never a plan name; and a zero price becomes `UGX 0` and never
"Free". The spec asserts each of those as a NEGATIVE as well as a positive, because the
failure mode is a word that reads fine until an operator acts on it.

## The Commercial Projection — spec §15 step 3E.1, READ ONLY

`commercial` is the CANONICAL answer to a restaurant's **recorded** commercial
configuration and terms — recorded, never *agreed*. An administrator writing down a price
is not an owner accepting one, and nothing in this projection carries owner consent.
(Owner go-live approval is a separate concept and will bind to these exact facts later.)

It arrives on **BOTH** `GET /restaurants/` rows and the detail payload — the
backend computes it once in `commercial_reads.commercial_summary` and hands the same
object to each read — so it lives on the SHARED shape (`RestaurantCommon`), not as a
detail-only extra. No new endpoint, no second store, no second request.

### It answers THREE INDEPENDENT questions, and they stay three

| field | question | vocabulary |
|---|---|---|
| `payment_timing` | does the diner pay before or after eating? (SERVICE MODEL) | `pay_first` / `pay_after` |
| `payment_collection_mode` | does Dinify initiate the diner's payment at all? (CUSTODY) | `offline` / `psp_online` |
| `subscription_terms` | what has Dinify recorded that this restaurant pays IT? | an open terms row, or none |

Each axis carries its own `configured` / `value` / `set_at`. **THERE IS NO
`commercial_configured` BOOLEAN on the server and there must be none here.** Every
partial combination is real — timing decided while collection is not, terms recorded
while both axes are still open — and collapsing three facts into one word makes
"partially configured" unrepresentable, which is the state an operator most needs to
see. The directory cell therefore NAMES the missing half (`Pay first · Collection not
configured`) rather than flattening to `Configured`.

### `configured` IS THE SERVER'S BOOLEAN
The transport passes the projection through unchanged and derives nothing. It does not
compute `configured` from a value, does not fill a null, does not reformat a decimal
string and does not read a legacy field. **The transport is a pipe, not a commercial
rules engine.** Everything that renders guards on the VALUE (or on
`subscription_terms.current`) rather than on the boolean beside it — what is displayed
is what is checked — so a server that ever sent the two inconsistently degrades instead
of crashing.

### OPEN TERMS ARE TERMS, NOT STATUS — the highest-risk mistake in this slice
`subscription_terms.configured === true` means ONE thing: **an open
`RestaurantSubscriptionTerms` row exists.** It is not Active, Paid, Current, Trial, In
good standing, an invoice, an invoice paid, a successful collection or an owner's
agreement. There is no invoice model on the server, no receivable and no collection
path — Dinify has never taken a subscription payment through this system — so any word
implying money changed hands is an assertion the database cannot support. The backend
named the model TERMS and not `Agreement` for exactly this reason.

So the cell states **the terms themselves** — `UGX 150,000 · every month` — and never a
verdict about them. `subscriptionLabel`, which rendered `has_commercial_subscription`
as **Active**, is deleted rather than fixed. There is deliberately no success treatment:
a recorded price is not an achievement.

### `offline` is a FIRST-CLASS MODE, `psp_online` is NOT A READINESS CLAIM
`offline` means Dinify does not initiate the diner payment and the restaurant collects
through whatever tender it likes. It is **never** cash-only (that names one tender out
of many and misreports a restaurant running its own card machine), never degraded,
never a fallback, never pre-launch — a restaurant is fully entitled to go live in it.
`psp_online` records an INTENTION and proves nothing about a provider being connected:
this platform has no PSP integration, so there is no provider, no merchant id and no
readiness verdict to report. Both get one clarifying sentence on Overview, because the
first is read DOWN and the second is read UP.

### THE CANONICAL OBJECT OUTRANKS THE COMPATIBILITY FIELDS
The wire carries BOTH contracts and **they disagree by design.** The server FREEZES
`payment_mode` null, `payment_mode_configured` false and `has_commercial_subscription`
false — `restaurant_reads` calls that last line "the single most important line in this
module to leave alone", precisely because the deployed portal rendered it as **Active**
— while `legacy_validity_flag` still varies and defaults TRUE.

**WHERE THEY DISAGREE, `commercial` WINS.** Nothing infers a canonical value from a
legacy one, nothing falls back to legacy when `commercial` is unconfigured, and nothing
synthesises canonical state client-side. The legacy types stay in the model for two
reasons only: the wire carries them, and the contradictory regression fixtures need to
be able to state a legacy half. **A regression test proves both directions on BOTH
screens** — canonical configured while legacy says unconfigured, and canonical
unconfigured while legacy validity is true — asserting on the VISIBLE cell, because the
failure being designed out is a screen quietly reading the wrong field.

The Overview "Legacy record" block survives, below a literal fence, labelled
`Superseded columns … the state above is authoritative`. It is for reconciliation and
is never a second opinion.

### Absence is not "Not configured"
`NOT_CONFIGURED` says the server was asked and answered: no decision is recorded.
`NO_VALUE` (`—`) says the server did not answer at all — a `commercial` object missing
from the payload entirely. Rendering the second as the first manufactures a commercial
verdict out of a missing payload, which is the same defect class as a dead backend
presenting as "Invalid credentials." Both label entry points take
`CommercialSummary | null | undefined` for exactly this.

### NO CLIENT-SIDE COMMERCIAL INFERENCE, in any direction
Not from `require_order_prepayments`, table configuration, transaction tender,
`flat_fee`, `preferred_subscription_method`, the legacy validity or expiry columns,
lifecycle state, or `is_test`. `is_test` affects portfolio visibility later; it does not
rewrite the commercial facts a restaurant has recorded.

### THE COMMERCIAL WRITES THAT EXIST, AND THE ONES THAT DO NOT
Step 3E.2 added exactly two: `setPaymentTiming` and `setPaymentCollectionMode`. Still
absent, and must stay absent until Step 3E.3 owns them: `recordSubscriptionTerms`,
`replaceSubscriptionTerms`, `endSubscriptionTerms` — and, permanently, any generic
`post()`, `mutateCommercial`, `setAxis` or `ApiService`.

**SUBSCRIPTION TERMS REMAIN STRICTLY READ-ONLY.** No Record, no Replace, no End, and no
disabled placeholder — a control that cannot work still tells an operator the capability
is there. A test pins the exact button set on Overview as `['Change', 'Change']`.

## The Service-Configuration Writes — spec §15 step 3E.2

**THE FIRST RESTAURANT-DOMAIN WRITES IN THIS REPO.** An administrator can change one
canonical service-configuration axis, with a stated reason, against the exact value they
loaded, through the EXISTING elevation/CSRF machinery, without optimistic UI and without
silently overwriting somebody else's decision.

```
POST /api/admin/v1/restaurants/<uuid>/commercial/payment-timing/
POST /api/admin/v1/restaurants/<uuid>/commercial/payment-collection-mode/

{ "value": "pay_first", "expected_current": null, "reason": "…" }
      -> 200 { "changed": true, "commercial": { …the canonical projection… } }
```

### TWO NAMED OPERATIONS, AND THEY STAY TWO
`RestaurantApi` grew `setPaymentTiming` and `setPaymentCollectionMode` — never
`setCommercialField(field, …)`, `mutateCommercial`, `setAxis` or a generic `post()`.
Payment timing is a SERVICE-MODEL decision and collection mode is a CUSTODY decision:
different vocabularies, different consequences, plausibly different future write
authority. A parameterised route or method would make "what did this operator change?" a
question about an argument, and would let one grant of access reach both.

`RestaurantHttp`'s envelope-unwrapping helper is a REAL `#private` method, not a
TypeScript `private` one — the latter is erased and leaves a generic `write(route, body)`
on the instance, which is the exact surface this slice is supposed not to have.

### `expected_current` IS REQUIRED, AND SEPARATELY NULLABLE
This is the whole optimistic-concurrency story and the easiest thing here to get quietly
wrong.

| body | meaning |
|---|---|
| `{"expected_current": null}` | "nobody had configured this when I loaded it" — the ONLY assertion that succeeds against a fresh restaurant |
| `{}` | no assertion at all — a 400 |

They are not the same request, **and TypeScript will not save anyone**: `JSON.stringify`
DROPS an `undefined` property, so a value arriving as `undefined` instead of `null`
silently becomes the second case. Every producer coalesces to `null` explicitly, and
three tests pin the literal `"expected_current":null` on the wire — including one through
the elevation replay.

**THE TOKEN IS CAPTURED WHEN THE EDITOR OPENS**, into a plain signal and deliberately NOT
a computed. The operator is asserting "this is the value I reviewed"; a computed would
track a background store change and turn an ordinary-looking Save into an assertion about
a value nobody saw. It is never derived from `configured`, a legacy field, the other
axis, lifecycle, or a form default, and never re-read at submit time.

### ELEVATION IS THE EXISTING MACHINERY, UNTOUCHED
The component reads no CSRF cookie, calls no `/auth/elevate/`, inspects no elevation
clock and preflights nothing. The POST goes through the ordinary `HttpClient` stack:

```
Save -> POST -> 403 elevation-required -> errorClassifierInterceptor case 3
     -> ONE dialog -> /auth/elevate/ -> THE ORIGINAL HttpRequest replayed once
```

**The replay carries the original body**, which is what makes the concurrency token
survive re-authentication. A component that rebuilt the request after elevation would
assert a token nobody reviewed — and would do it silently, with the conflict check
passing. `error.interceptor.spec.ts` pins both the populated and the explicit-null case.

### NO OPTIMISTIC UI, AND ONE MUTATION AT A TIME
The row keeps showing what the server last confirmed until a 200 arrives; §16 forbids
optimistic UI for consequential writes, and a write is real once its `AdminAuditLog` row
commits. Only then is `response.commercial` adopted, the editor closed and the draft
cleared.

**ONLY ONE AXIS EDITOR IS OPEN AND ONLY ONE WRITE IS IN FLIGHT.** Each successful write
returns the WHOLE canonical object, so two concurrent writes from this panel could land
out of order and the older snapshot would repaint the other axis. That is a race this
client would be doing to itself; it is NOT a substitute for server concurrency, which
`expected_current` and the 409 still own.

### THE OUTCOMES ARE GENUINELY DIFFERENT
| outcome | what happens |
|---|---|
| `changed: true` | adopt, close, "Payment timing recorded." |
| `changed: false` | adopt, close, "…was already set to that value. Nothing was changed." |
| 400 | form and draft STAY OPEN, server's field errors beside the field they name |
| 409 | no auto-retry, editor discarded, `reload()`, "review the current value" |
| 404 | editor discarded, `reload()` — the established not-found path takes the screen |
| elevation cancelled | draft KEPT, "Nothing was changed." |
| elevation abandoned | draft kept, global auth/outage state stays authoritative |
| 5xx / status 0 | INDETERMINATE — never claims it failed to commit, draft kept for a deliberate retry |

**`changed: false` IS A SUCCESS.** The server answers a same-state request that way even
when `expected_current` has gone stale, so a lost response followed by an exact retry is
not a false conflict and does not re-stamp attribution. Nothing manufactures a fresh
`set_at` for it, and it is never described as a new decision.

**A 409 IS NEVER RETRIED AUTOMATICALLY.** Replaying with a fresh token would overwrite
whatever the other operator just decided — the precise thing `expected_current` exists to
prevent. The operator gets a fresh choice, a fresh reason and a fresh token.

### THE COPY MUST NOT OVERSTATE WHAT THESE WRITES DO
`offline` is "Restaurant collects" — never cash-only, never degraded, fallback or
pre-launch. `psp_online` is "Dinify via PSP", recorded as INITIATING the diner payment
through a licensed provider on the restaurant's behalf; the RESTAURANT remains merchant
of record, funds settle directly to it, and Dinify takes custody of diner money in
neither mode.

**`psp_online` IS SELECTABLE AND MUST STAY SELECTABLE.** It is a legitimate commercial
decision; the safety mechanism is fail-closed readiness later, not a control that refuses
to record what an operator decided. Selecting it shows a warning that it connects no
provider, creates no merchant account, and cannot satisfy future go-live readiness yet.

Payment timing records a service model and claims NO runtime consequence — nothing in the
order or kitchen path consumes the value yet, so no copy promises that changing it alters
current order behaviour.

### THE REASON IS THE OPERATOR'S
Required, trimmed, minimum 10 characters (`MIN_REASON_LENGTH`, mirroring the server), max
1000. The client bar is ADVISORY and the server stays authoritative — a 400 from it still
renders. Nothing generates a reason: no "Admin update", no "Changed via portal".

### MOCK MODE RUNS THE REAL INTERACTION
`MockRestaurantApi` implements both writes with the server's own rules in the server's own
order — vocabulary, reason, then concurrency, with same-state checked BEFORE the
assertion. A successful write overlays the fixture so later reads (workspace AND
directory) reflect it. **There is no mock-only UI path** and no simulated elevation: that
machinery has its own tests, and a second implementation in a fixture would prove nothing
about the real one.

```js
// Review the conflict UI. Fires once, then disarms so the whole
// conflict -> reload -> fresh token -> retry path can be walked.
sessionStorage.setItem('dinify-admin.mock-commercial', 'stale')
```

### THE DIRECTORY STAYS READ-ONLY
No write controls on `/restaurants`. Writes belong inside the workspace, where the
restaurant's identity and context stay visible while the change is made. The directory's
stub API THROWS on both write methods, so a control added there fails a test rather than
quietly working.

> **Step 3E.3 is the SUBSCRIPTION-TERMS controls** — record, replace, end. Its
> concurrency token is `subscription_terms.current.id` rather than a value, and its
> exact-retry rules differ from an axis's. Not built.

## The Onboarding Projection — spec §15 step 2C, READ ONLY

`RestaurantDetail.onboarding` is the CANONICAL contract for how a restaurant entered the
admin onboarding domain and who controls it. It arrives inside the EXISTING detail
payload — there is no `GET /restaurants/<id>/onboarding/`, no second store and no second
request. The workspace's one-read architecture is unchanged.

It answers **five separate questions, and they stay five.**

| row | field | why it is its own row |
|---|---|---|
| Source | `source` | `legacy_adopted` / `admin_created` — where it came from |
| Recorded in Admin | `recorded_at` | when the ADMIN RECORD appeared, NOT `created_at` |
| Owner relationship | `owner_relationship.status` | a STRUCTURAL check on owner-role membership |
| Owner control | `owner_control.status` + `evidence` + `evidence_at` | whether anyone has PROVED control, and by what |
| Invitation | `invitation.status` | the invitation lifecycle, where invitations apply |

**THE FAILURE MODE IS ANSWERING ONE WITH ANOTHER, ALWAYS UPWARDS.** Structural
consistency is not control. An administrator's attestation is not an observed sign-in. A
legacy tenant's `not_applicable` invitation is not a missing one. Evidence recorded
against a PREVIOUS owner (`stale_attestation`) establishes nothing about the current one.
And `tracked: false` means the questions were NEVER ASKED — rendering it as "Not
established" or "Not issued" manufactures a verdict out of an absence of data, which is
the same defect class as a dead backend presenting as "Invalid credentials."

So: **owner control is never inferred client-side**, there is no combined "Onboarding
complete" status, and there is deliberately no green success treatment — §10 wants a
completed state to recede. Warning emphasis is reserved for `stale_attestation`, the
three owner-relationship inconsistencies and an `expired` invitation, and it is always ON
TOP of wording that stands without colour (§22).

**Live Baba House is the reference shape**, and its SEMANTICS — not its UUID — are a test
fixture: tracked, `legacy_adopted`, `consistent`, `not_established`, no evidence,
invitation `not_applicable`. Nothing in this repo may branch on which restaurant it is.

`recorded_at` and `evidence_at` both go through `formatEat`, like every other timestamp
here. A null renders `—`.

**IT IS DETAIL-ONLY.** `GET /restaurants/` did not gain onboarding, and `RestaurantRow`
must not grow it: the directory answers "which restaurants need me", and five more
per-row states would be five more columns nobody scans.

**THE OWNER PANEL NO LONGER MENTIONS CLAIMS.** It carries name, email, phone and account
state. `owner.claim_tracked` / `owner.claim_status` are backend compatibility aliases
that MIRROR `onboarding` (`tracked`, and the owner-control status while tracked); they
stay in the typed model and nothing renders them. Two panels answering one question is
how a screen starts disagreeing with itself.

**THERE ARE NO ONBOARDING WRITES IN THIS REPO.** No adopt, no attest, no invite, no
reissue, no cancel, no owner reassignment, no restaurant creation — and no disabled
buttons standing in for them. A test asserts Overview ships zero `<button>` elements.

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

## The Notice Channel — `core/notices/notice.service.ts`

`verify/` and `elevate/` report two things **no other surface ever mentions again**:
that a sign-in cleared an account lockout, and how many recovery codes are left. Both
used to reach `console.warn` — which is to say nobody — and `elevate/`'s copy was
dropped on the floor entirely, even though **a re-elevation spends a recovery code
exactly as a sign-in does**. Running out with a lost authenticator means
`manage.py reset_platform_admin_totp` on the box.

**THE BOUNDARY, because this is how toast systems get born:**

- **ONE notice visible at a time.** No stacking, no queue, no auto-dismiss, no timers.
- **Two conditions COMPOSE into one notice**, one line per fact — never joined into a
  sentence. "Something was fixed" and "a resource is running out" are different facts,
  and `lockout_cleared` is kept apart from the low-code warning for exactly that reason.
- **It persists and it returns.** Dismissal is remembered; a fresh statement of the
  facts undismisses, so the warning comes back on the next sign-in while the condition
  holds. A routine re-elevation with codes to spare does not resurrect it.
- Rendered by `ui/notice-banner.component.ts` in `--admin-warning` — "careful", not
  "something is wrong". **Do not introduce a toast library.**

### The recovery-code reload gap, and its queued fix
`GET /auth/session/` returns **exactly six fields** and `recovery_codes_remaining` is
NOT among them — only `verify/` and `elevate/` ever state it. So a mid-session page
reload loses the count, and the service will not re-assert a warning it can no longer
verify. The gap is **accepted**, not papered over with `sessionStorage`: persisting a
security-adjacent count in the browser is a new surface for a marginal gain.

**TODO(backend), queued rather than deferred: add `recovery_codes_remaining` to
`GET /auth/session/`.** When it lands, wiring it is one `notices.record(...)` call in
`AdminAuthService.bootstrap()` — the TODO marks the exact line. A source change, not a
redesign.

## Navigation — spec §9

**Exactly five destinations:** Home, Restaurants, Support, Receivables, Activity. Then
the operator name, **Re-authenticate**, and Sign out.

**Re-authenticate is an ACTION on the current session, not a sixth destination** — it
lives in the operator block beside Sign out. It opens the EXISTING elevation dialog
through the EXISTING queue (`ElevationService.request('deliberate')`, which swaps one
sentence via the `reason` signal); there is no second prompt anywhere in this repo, and
there must not be.

**IT IS ALSO THE WRITE-PATH SMOKE TEST, and that is why it shipped before step 4.**
`POST /auth/elevate/` is the only unsafe request this scaffold can make, so this button
is the only thing that exercises the CSRF cookie read, the `X-CSRFToken` header and the
server's double-submit check in a browser. **After 0C ships the deploy, it is what
proves that path works against real Apache** — until step 4 puts a lifecycle transition
behind it. It is a real affordance either way: an operator about to do something
consequential would rather clear the window deliberately than be interrupted
mid-action.

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

   **A column is EITHER text OR page-drawn, and the type says which.** `AdminTextColumn`
   carries `value: (row) => string`; `AdminTemplateColumn` carries `cell: true` and the
   page projects `<ng-template [appAdminTableCell]="'<key>'" ...>` matched by column
   key. That is what let the directory grow a lifecycle pill and a two-line restaurant
   cell WITHOUT a second table primitive and without the table learning any domain — there
   is no `if (column.key === 'lifecycle')` and no `row.is_test` in `table.component.ts`,
   and there must not be. The directive's second input (`appAdminTableCellOf`, bound to
   the same rows) is never read at runtime: it exists so `T` is inferred and `let-row`
   is typed, the same trick `*ngFor="let x of items"` uses.

   It deliberately has NO loading mode. A page that owns a real distinction between
   loading, failed and empty renders those itself; a spinner in the empty slot would let
   all three collapse back into one.
3. **`app-admin-button`** — `primary` (accent) / `secondary` / `destructive` (danger) /
   `ghost`, plus a `pending` state. **`pending` is the mechanism that enforces §16's
   ban on optimistic UI for consequential writes**, not decoration: a lifecycle
   transition is only real once its `AdminAuditLog` row commits, and a button that
   springs back before that has told the operator something that may not be true.

A page-header/empty-state helper is still not built. Step 1 did not need one: the
directory owns four distinct states whose copy is specific to it, and the remaining
placeholder tabs share one `PANEL` constant. Extract it when a THIRD screen wants the
same shape, not before.

**The three banners are SHELL FURNITURE, not primitives, and the count is still three.**
`defect-banner`, `notice-banner` and `service-unavailable-banner` are each mounted
exactly once in `ShellComponent` and are never composed into a screen — three global
channels holding at most one message each (a live outage state, one defect, one composed
notice). A primitive is something screens reach for; these are things the frame owns.

### `Restaurant.is_test` NOW EXISTS, and is what drives the TEST pill
Migration `restaurants_app/0057` (backend PR #290) added it: **platform-owned** metadata
marking a tenant that is not a real commercial customer. It is absent from BOTH
`EDIT_INFORMATION['restaurants']` and `SerializerPutRestaurant`, so no restaurant user
can set it, and the migration backfills **nothing** — whether an existing restaurant is a
test tenant is an explicit operator decision, never inferred from its name. The admin
directory and detail reads surface it, and the directory row and detail header both mark
it with the solid TEST pill.

**It is NOT `Order.is_test`** (migration `orders_app/0035`), which is a different fact
about a different object: ONE order that is operationally real and commercially
invisible, either because its tenant is a test tenant or because it was placed
pre-go-live as a rehearsal. A real restaurant can have test orders. **Neither flag may
be derived from the other.** Overview marks a test LATEST ORDER with the same pill, for
the same reason: "a rehearsal happened" and "a sale happened" are different statements.

## Formatting

Pure functions in `core/formatting/`, plus thin pipes, so nothing downstream
reinvents them.

- **Currency**: `UGX 150,000`. **Never a float** — the backend's money fields are
  Postgres `DecimalField`s that arrive as STRINGS precisely so no float touches a money
  value (`commercial_reads` calls `str()` on the `Decimal` for exactly this), and the
  formatter groups the string TEXTUALLY rather than parsing it. A missing amount renders
  `—`, distinct from `UGX 0` — zero is a real, deliberate price.

  **`formatMoney(amount, currency)` is the rule and `formatUGX` is a one-line wrapper**,
  so there is ONE money rule rather than two that can drift. **The currency is an
  argument and is never assumed**: `RestaurantSubscriptionTerms.currency` is stored with
  no default, and relabelling a different code as shillings is a quiet corruption of a
  money value.

  **An ALL-ZERO fraction is dropped (§16's no-faux-precision rule); a NON-ZERO fraction
  is KEPT, verbatim.** `"150000.00"` → `UGX 150,000`, but `"150000.50"` → `UGX 150,000.50`.
  Step 3E.1 changed this: the formatter used to truncate unconditionally, which deleted a
  stored digit from a price an operator is expected to reconcile. Truth beats typography
  — rounding a recorded amount away on screen is the same defect class as rendering
  unconfigured state as `Active`.
- **Time**: `15:42 EAT · 19 Aug 2026`. Always `Africa/Kampala`, always labelled.
  Administration may happen from another timezone and "yesterday at 23:50" must never
  be ambiguous — a lifecycle decision against the wrong day is not a cosmetic error.
- **Relative time anchors on `server_time`**, passed in as a REQUIRED argument so a
  caller with no anchor shows an absolute time rather than silently using the
  browser's clock.

## Mock Mode — how the founder reviews this work

**TWO PORTS, TWO MOCKS.** The auth transport sits behind `ADMIN_AUTH` and the restaurant
reads behind `RESTAURANT_API`. `npm start` (the default `development` serve
configuration) resolves both to their mocks, so **the complete shell, all five
destinations, the real restaurant directory, the restaurant workspace and the dev-only
primitives gallery (`/__gallery`) render with NO backend running.** This is how the
visual direction gets reviewed, and it is how the §16 brand-red decision will actually be
made.

Only the TRANSPORTS are mocked. `AdminAuthService`, the login component, both
interceptors, the elevation queue, the directory page, the workspace store, the labels
and the formatting are the same code in both modes, so what gets reviewed is the real
flow.

**A MOCK IS NEVER A FALLBACK.** It is chosen at build time by `DEV_PROVIDERS`, never
reached for when a request fails. A control plane that quietly substitutes fixtures for
an unreachable server shows an operator a portfolio that does not exist, and the
decisions they take from it are taken against fiction. REAL FAILURE ≠ MOCK DATA.

**THE FIXTURES ARE NOT RICHER THAN THE BACKEND.** `mock-restaurants.fixtures.ts` DERIVES
readiness, `needs_attention`, the commercial projection, the legacy compatibility fields,
the onboarding projection and the owner-claim aliases from the same rules
`restaurant_reads.py` and `commercial_reads.py` apply, rather than writing pleasant
values per row — a fixture that cannot disagree with the rule. The commercial derivation
applies the backend's own consequences too: each axis's `configured` follows its VALUE,
an undecided axis carries no `set_at`, and `subscription_terms.configured` is simply
whether an open row exists.

**AND THE MOCK KEEPS THE LEGACY FIELDS FROZEN, exactly as the server freezes them** —
`payment_mode` null and `has_commercial_subscription` false even for a restaurant with
open terms. That is deliberate and is the point: every configured seed is therefore a
LIVE canonical-versus-legacy contradiction, which is what the deployed wire actually
carries. A mock that quietly flipped the boolean would agree with a screen that is
wrong. The
onboarding derivation applies the backend's own consequences: untracked forces every
nested status to `unavailable`, a legacy adoption's invitation is always
`not_applicable`, the evidence follows from the control state, and the claim aliases are
mirrored off `onboarding` rather than written beside it. The corpus covers
onboarding-with-attention, an ordinary live tenant, a live TEST tenant, suspended,
offboarded, open issues and none, no admin activity, a null location, a missing owner, a
rehearsal (TEST) latest order, no orders at all, an UNTRACKED tenant, the live Baba House
shape, a valid legacy attestation, a redeemed invitation, one pending, one not issued,
one expired, one cancelled, one superseded, all three owner-relationship inconsistencies
and a stale attestation. Step 3E.1 added the commercial states: nothing configured, both
service axes configured, TIMING ONLY (Ankole), COLLECTION ONLY (Garden City), open terms,
ZERO-PRICED terms (the internal Demo Kitchen), an interval whose count is 2 (Mbarara),
terms recorded while BOTH axes are still undecided together with a non-zero decimal
fraction (Gulu Highway), and the reverse contradiction — legacy validity true with no
commercial state at all (Speke Road, Bugolobi). There are enough rows to page at the
default 25. The mock also FILTERS and PAGES
server-side, mirroring `apply_directory_filters` and the endpoint's slicing — otherwise
`npm start` would review a directory that works differently from the deployed one, and
the pagination arithmetic would never be exercised.

Levers for the unhappy paths (documented in the mocks themselves): a username containing
`locked` → the break-glass branch; containing `low` → the low-recovery-codes warning;
code `000000` → the uniform verification failure; empty credentials → the uniform 401.
And the two console levers:

```js
// AUTH — the third bootstrap outcome
sessionStorage.setItem('dinify-admin.mock-unavailable', '1')     // no answer at all
sessionStorage.setItem('dinify-admin.mock-unavailable', '502')   // answers badly, WITH a request id
sessionStorage.removeItem('dinify-admin.mock-unavailable')       // back to normal

// RESTAURANTS — the directory's failure and empty states
sessionStorage.setItem('dinify-admin.mock-restaurants', 'error')  // 500, WITH a request id
sessionStorage.setItem('dinify-admin.mock-restaurants', 'empty')  // a well-formed empty page
sessionStorage.removeItem('dinify-admin.mock-restaurants')        // back to normal
```

The detail 404 needs no lever: navigate to `/restaurants/<any-other-uuid>`. `error` and
`empty` are separate levers on purpose — telling "the read failed" apart from "there is
nothing here" is the whole point of keeping those states distinct.

### MOCK-MODE ERRORS ARE NOT `HttpErrorResponse` — DUCK-TYPE OR IT IS DEAD CODE
Both mocks throw `MockHttpError` (`src/app/dev/mock-http-error.ts` — one shape, one
place), an `Error` subclass carrying `status` and, where the failure reached a server, a
`headers.get()` stand-in so the request-id path is reviewable. Neither goes near
`HttpClient`, **so no interceptor runs in mock mode**.

Two rules follow, and they will trap someone otherwise:

1. **Anything branching on the SHAPE of an error must duck-type.** An
   `instanceof HttpErrorResponse` check makes the branch dead in the one mode this work
   is reviewed in before a deploy exists. `classifyTransportFailure` is the shared
   implementation — use it rather than writing a second one.
2. **A failure path that only the interceptor handles is invisible in mock mode.** That
   is why `bootstrap()` and `ElevationService.submit()` classify directly rather than
   leaning on the interceptor alone.

`ng serve --configuration=live` uses the real transport against `/api/admin/v1`.

### Neither the mock nor the gallery reaches production
`angular.json`'s production configuration **file-replaces** `src/app/dev/dev-tools.ts`
with `dev-tools.prod.ts`, whose exports are empty and which imports nothing from
`src/app/dev`. So they are not merely unreachable — they are not in the production
module graph at all, rather than depending on the bundler eliminating dead code.

`scripts/check-mock-isolation.mjs` CHECKS that against the built output by scanning
for **three** build markers — the mock auth transport, the mock restaurant transport and
the gallery — each emitted in a way a minifier cannot drop (`console.warn`, or a rendered
`data-` attribute). It fails loudly when `dist/` is missing, so a green result can never
mean "there was nothing to look at". Adding a development-only module means adding its
marker HERE and to the `--self-test` cases; the self-test is what proves the matcher
still fires.

Verified both ways at step 1: all three markers are present in a `development` build and
absent from `dist/` after `build:prod`, so the gate has something real to catch.

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

`.github/workflows/ci.yml` (job `validate`, on `pull_request` to `main` **and on push
to `main`**) runs all six on Node 20 with plain `npm ci`. `.github/workflows/audit.yml`
runs a weekly `npm audit --audit-level=high` — scheduled and manual only, never a PR
check.

**The push-to-`main` trigger is load-bearing for deployment, not redundant with the PR
one.** A PR's CI runs against a merge preview of the branch with main as it was then;
the commit that actually lands on main was never itself tested. `deploy.yml` certifies
its target against a successful `ci.yml` run whose `head_branch` is `main`, so it is
gating on the commit it is actually shipping. Do not remove that trigger.

`deploy.yml` is NOT part of CI and is never a PR check — it is `workflow_dispatch` only.

## Deployment — 0C.1 AND 0C.2 BOTH ACCEPTED

`.github/workflows/deploy.yml` is the deploy mechanism: **build → tar.gz artefact to a
private S3 prefix → GitHub OIDC → `aws ssm send-command` → immutable release directory
→ symlink promotion.**

**0C.1 (the manual exact-SHA path) was empirically accepted on 2026-08-20.** What was
proven against the real host and public origin, not merely reviewed:

- a real `deploy` succeeded and `https://admin.dinifyapp.com/release.txt` publicly
  returned that exact SHA with `Cache-Control: no-store`;
- the real Angular application replaced the host placeholder, and deep SPA routing
  survived direct navigation and refresh;
- platform-admin login worked end to end — password + TOTP, session bootstrap, and
  **Re-authenticate** exercising the authenticated CSRF-protected `auth/elevate/` POST
  against real Apache/Django (the write-path smoke test finally fired for real);
- on-box inspection confirmed `/var/www/dinify-admin` is a symlink to the exact
  immutable SHA release, directories `root:root 0755`, files `root:root 0644`, no
  internal symlinks;
- a manual `rollback` to a second installed release succeeded, `release.txt` followed
  it, and re-promotion via `mode=rollback` returned the origin to the newer SHA.

**0C.2 (automatic forward-only deployment after a successful main CI run) was
EMPIRICALLY ACCEPTED on 2026-08-21.** Its first real automatic run was its own
acceptance gate, and it passed on the Phase-1 Step-1 merge:

- merging PR #8 put `cfd4ba7` on `main`; `ci.yml` ran on the **push** and succeeded
  (run #13, 12:38→12:39 UTC);
- `deploy.yml` then started on its own through **`workflow_run`** — not a dispatch —
  targeting that exact `head_sha` (run #14, 12:39→12:40 UTC), and succeeded;
- `https://admin.dinifyapp.com/release.txt` was read back over the public internet and
  returned exactly `cfd4ba7e7067a946cd696af3058bb0dee0874a82` with
  `Cache-Control: no-store`.

So the whole chain — merge → CI on main → automatic exact-SHA deploy → served-state
attestation — is now proven end to end rather than reviewed. The forward-only guard has
still never had to REFUSE a stale automatic run; that path remains reasoned but
unexercised.

**TRANSPORT IS SSM OVER OIDC, NEVER SSH. Do NOT add** `firebase.json`, `.firebaserc`,
rsync, `appleboy/ssh-action`, or any stored SSH secret. That transport was deliberately
retired by backend PR #281: the instance's security group does not admit GitHub-hosted
runners, which is why the old SSH path died at connect timeout. The backend's
`UAT_SSH_*` secrets were deleted 2026-08-18. **No workflow in this repo references
`secrets.` at all** — OIDC needs no stored credential, and the role ARN lives in the
`AWS_DEPLOY_ROLE_ARN` repository *variable* (an ARN is not a secret) which the workflow
compares byte-for-byte against the ARN pinned in the file before authenticating.

### THE PRIVILEGE BOUNDARY — TWO JOBS, AND IT MUST STAY TWO JOBS

**No application or npm dependency code may ever run in a job carrying
`id-token: write`.** That is the invariant; everything below is how it is kept.

`id-token: write` is a JOB-level permission. When a job holds it the runner exports
`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` into **every** step
of that job from the first one onward, so any code executing there — including an
`npm ci` lifecycle script from any transitive dependency — can mint an OIDC token and
exchange it for the deploy role's AWS credentials. `configure-aws-credentials` is a
CONSUMER of that capability, not its source. **Putting the build before the AWS action
is therefore NOT a boundary**, which is what an earlier revision of the workflow
incorrectly claimed. Step ordering inside one job protects nothing.

| job | `id-token` | runs |
|---|---|---|
| `prepare` | **absent** (`contents: read`, `actions: read` only) | certification, `npm ci`, `build:prod`, mock-isolation, packaging |
| `deploy` | `write` | artifact validation, OIDC, S3, SSM, served-state assertions |

`deploy` has **no checkout at all**, no `npm`, no package.json script and no Angular
build. It runs workflow shell, first-party actions and the AWS CLI, and it treats the
incoming tarball strictly as DATA — validated, hashed, uploaded, never extracted and
never executed on the privileged side. Do not merge these jobs, and do not add a build
or a checkout to `deploy`.

Two consequences worth keeping straight:

- **Identity crosses the boundary as step/job OUTPUTS, never `$GITHUB_ENV`.** The
  untrusted npm phase sits between certification and the privileged job, and
  `$GITHUB_ENV` is mutable job-wide state. `deploy` additionally re-derives the SHA and
  mode from the raw workflow inputs and requires exact equality with what `prepare`
  certified, and re-runs the ancestry and CI checks against *current* main through the
  API — no checkout needed.
- **The authoritative artifact digest is computed in `deploy`, not in `prepare`.** The
  build job's digest is diagnostic only. What names the S3 key and what the box
  re-derives is the SHA-256 of the bytes that actually arrived, so the attestation
  covers what crossed the boundary rather than what the build claimed it sent. The
  archive is also validated there — member shapes, and `release.txt` read out of the
  tarball in memory and required to attest the revalidated SHA — all **before** OIDC
  authentication.

`prepare` checks out with `persist-credentials: false` and then asserts no
`http.*.extraheader` credential is present, because that job goes on to run `npm ci`.
Nothing after checkout needs an authenticated git operation: `fetch-depth: 0` brings the
history down, so the ancestry proof and the target checkout are both purely local.

### The release layout on the box
```
/var/www/dinify-admin                      → SYMLINK to the live release
/var/www/dinify-admin-releases/<sha>/      → immutable, root:root, dirs 0755 / files 0644
/var/www/dinify-admin-releases/placeholder/→ the pre-0C.1 holding page
```
A release is never edited in place, never synced into, and never extracted over. A new
one is staged in a temporary directory INSIDE the release root (same filesystem), fully
validated, then `mv`-renamed into its final path — so it either appears complete or not
at all. **`release.txt` at the release root is the served-commit attestation**: it holds
exactly the deployed 40-char SHA. Apache serves both `release.txt` and `index.html`
`no-store` (one-year immutable caching applies only to `js css woff woff2 svg png jpg
jpeg webp map` — deliberately not `txt`/`json`), which is what makes reading it back a
real check rather than a cached echo.

### The two ways it runs

**AUTOMATIC (`workflow_run`)** — after the Admin CI workflow completes successfully for
a **push to main**, the exact SHA that CI certified is deployed. Never "whatever main is
now": the target is the triggering run's `head_sha` and nothing else. Automatic runs are
always `deploy` — there is no automatic rollback — and they are **forward-only** (below).

`workflow_run.workflows` can only match a workflow's mutable DISPLAY NAME, so `"CI"` in
the trigger is a coarse pre-filter GitHub forces on us and is **deliberately not the
security proof**. Both jobs independently re-fetch the triggering run from the API and
require it to belong to the workflow id resolved from `.github/workflows/ci.yml`, to be
`completed`/`success`, and to be a `push` on `main`. A different workflow that merely
happens to be named "CI" can never satisfy that.

A CI run that did not succeed produces a cleanly **skipped** deployment run, not a red
one — a failed CI is not a deployment incident, and turning every one into a failed
deploy would train the operator to ignore this workflow's red.

**MANUAL (`workflow_dispatch`)** — the operations and emergency interface, unchanged:

| input | value |
|---|---|
| `sha` | full 40-character lowercase commit SHA |
| `mode` | `deploy` (default) or `rollback` |

Both paths run from `refs/heads/main` — the workflow refuses any other ref, because the
OIDC role's trust is pinned there. That holds for `workflow_run` too: GitHub takes the
workflow file from the default branch and reports the run against it.

Every target, manual or automatic, requires the SHA to be **an ancestor of current
`main` AND to have a successful `ci.yml` run on branch `main`**. Neither alone is
enough: ancestry alone
admits an untested commit, and CI-green alone admits a PR-branch run (CI runs on
`pull_request` too, where it tests a merge preview rather than the commit that landed)
or a commit since dropped from main.

**`mode=rollback` re-points the symlink at an already-installed release and does
nothing else** — no build, no `npm ci`, no artifact upload or download, no S3 transfer,
no extraction, no repair. If the release directory is not already on the box it fails;
rollback never reconstructs one. That makes reverting a seconds-scale operation rather
than a rebuild of old code.

**The free-space floor does not apply to rollback**, and that is deliberate. The 512 MiB
check guards the one path that writes bytes — installing a NEW release — and lives
inside that branch. A rollback downloads nothing, extracts nothing and installs nothing,
so gating it on free space would withhold emergency recovery in exactly the degraded
situation that most needs it. Re-promoting an already-installed release is the same case
and is likewise ungated.

### Automatic runs are FORWARD-ONLY, and the guard reads served state
Successful main CI runs do not finish in commit order. CI for commit A can complete
after B has already deployed, and a queued or re-run older automatic deployment can
execute later still. Without a guard, A would silently downgrade the live portal.

The guard compares the target against **what the public origin is actually serving**,
read back from `release.txt` — not against a commit ordering the workflow assumes. The
served SHA is the only statement of live state that is not the workflow's own opinion,
which is the same principle `DEPLOYED-HEAD` and the public assertion rest on. It runs
**before the artifact is consumed, before the role is validated and before OIDC**, so a
stale automatic run never authenticates to AWS at all.

| situation | decision | effect |
|---|---|---|
| target descends from served SHA | `AUTO-PROCEED` | deploy normally |
| target == served SHA | `AUTO-SKIP-IDENTICAL` | green no-op; no AWS, S3 or SSM |
| target is an ancestor of served SHA | `AUTO-SKIP-STALE` | green skip; no AWS, S3 or SSM |
| histories diverge, or served state is unreadable/not `no-store`/not one 40-hex SHA | **fail closed** | no AWS; recover with a manual dispatch |

**It applies to automatic runs only.** Manual deploy and manual rollback are never
blocked by it — deliberate backward movement and re-promotion are proven operational
capabilities and must stay available. A skip is reported honestly in the job summary
with the target, the served SHA and the reason; it is never dressed up as a deployment.

### What makes the run green
Nothing the workflow believes about itself. The box asserts `DEPLOYED-HEAD: <sha>` only
after its own local checks pass through Apache (release.txt, admin health, root, a deep
SPA route); if any fail it atomically restores the previous symlink target and **still
exits non-zero** — a successful restoration is not a successful deployment. The runner
then independently re-reads `https://admin.dinifyapp.com/release.txt` over the public
internet and requires it to equal the requested SHA and to be `no-store`. A missing or
mismatched marker, or an SSM status other than `Success`, fails loudly. This is the
defect class backend PR #283 closed after a deploy reported success while the box stayed
39 hours behind.

### Still deliberately out of scope
- **No `push` or `schedule` trigger.** Automatic deployment hangs off `workflow_run`
  after CI, so the deployed commit is always one CI actually certified. A `push`
  trigger would deploy commits whose CI had not finished — or had failed.
- **No release pruning.** Every deployed SHA and the original placeholder are retained.
  Retention is what keeps recovery cheap, and rollback is now a proven, exercised path;
  pruning would trade that away for disk that is not scarce.
- **The backend's forward-only mechanism was NOT ported.** It compares
  `git merge-base --is-ancestor` against a Git checkout on the box, and the admin box
  has no checkout. The served-state guard above solves the same problem with the
  evidence this plane actually has.

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
  its response (from `lifecycle.allowed_targets`), and so does the Step-1 DETAIL read —
  `RestaurantDetail.allowed_transitions` is already typed and already arriving, unused
  until step 4. **Never hardcode the transition matrix in this repo** — one authority,
  on the server, where the row lock and the audit entry are.
- **`GET admin/v1/restaurants/` and `GET .../<id>/` are DEPLOYED** (backend PR #290) and
  are what step 1 consumes. Query parameters are `search` / `status` / `attention` /
  `page` / `page_size`, and the query string is DENY-BY-DEFAULT: an unknown key is a 400
  with a field-keyed `errors` map, never a cheerfully unfiltered 200. Add a filter and
  you must add it to `KNOWN_PARAMS` too. There is **no ordering parameter**, so a sort
  header would be a control with nothing behind it; ordering is `name` then `id`.
- **There is no human-readable restaurant reference.** No `REST-0018`. The backend has
  no such column, and minting a sequential business key in a read endpoint would create
  a persistent identifier nothing else writes. The `Restaurant` UUID is the identity,
  and the workspace header shows it subdued.
- In-flight orders are **frozen, not drained**, at `suspended`: staff cannot see,
  advance or cancel them, so the table is never freed. Two consequences are known and
  left for Phase 1 (see the backend's lifecycle section).
- The transition endpoint is elevation-gated (`IsRecentlyElevated`) — which is exactly
  the 403 the error classifier's case 3 exists for.

## Available Slash Commands
None specific to this repo yet.
