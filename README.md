# Dinify Admin

The platform-admin control plane for Dinify — the operator cockpit that takes a
restaurant from handshake to live, paying tenant without opening a Django shell.

Served at `admin.dinifyapp.com`, same-origin with its API at `/api/admin/v1`.
Platform-staff accounts only; TOTP and opaque cookie sessions. This application shares
no runtime code with the restaurant portal or the diner app.

## Status

**Step 0 — scaffold.** This repo currently contains the system, not the screens:
the shell and navigation, the routing and URL-as-state layer, authentication against
the five admin auth routes, the HTTP layer (CSRF, the error classifier, the elevation
queue), the design tokens and the guard that enforces them, three primitives, and the
formatting helpers.

The restaurant directory, detail workspace, readiness engine, lifecycle controls,
owner invitation, delegated drill-in, support triage, receivables and activity feed
are **not built** — every destination renders a placeholder with a written empty
state. See `ADMIN_PORTAL_MVP_v2_3.md` §15 for the sequence.

There is **no deployment yet**. That is 0C.

## Getting started

```bash
npm ci          # plain ci — no --legacy-peer-deps, see CLAUDE.md
npm start       # http://localhost:4200, NO BACKEND NEEDED
```

`npm start` runs against a mock auth transport, so the complete shell, all five
destinations and a dev-only primitives gallery at `/__gallery` render with nothing
else running. Sign in with any username and password; a username containing `locked`
exercises the break-glass recovery-code path, and the code `000000` exercises a
failed second factor.

`ng serve --configuration=live` uses the real API instead (same-origin — it needs
something serving this app and proxying `/api`).

## Checks

```bash
./scripts/verify.sh          # everything CI runs, in the same order
npm run type-check
npm run lint
npm run check:tokens         # design-token gate (self-test, then the real scan)
npm run test:ci
npm run build:prod
npm run check:mock-isolation # after build:prod — scans dist/
```

## Documentation

- `CLAUDE.md` — the authoritative guide to this repo: conventions, tokens, the auth
  contract, the error classifier, what is mock and what is real.
- `AGENTS.md` — the same rules for non-Claude agents.
- `ADMIN_PORTAL_MVP_v2_3.md` — the product specification.
