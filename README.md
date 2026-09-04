# Dinify Admin

The platform-admin control plane for Dinify — the operator cockpit that takes a
restaurant from handshake to live, paying tenant without opening a Django shell.

Served at `admin.dinifyapp.com`, same-origin with its API at `/api/admin/v1`.
Platform-staff accounts only; TOTP and opaque cookie sessions. This application shares
no runtime code with the restaurant portal or the diner app.

## Status

**Steps 0 through 3E, plus 2G, of the spec's §15 sequence are built and deployed.**
The shell and navigation, URL-as-state filtering, authentication against the five admin
auth routes, the HTTP layer (CSRF, the error classifier, the elevation queue), the
design tokens and their guard, the restaurant directory and detail workspace, the
onboarding and commercial projections on Overview, the five commercial writes, and —
as of Step 2G — restaurant creation (`/restaurants/new`, with the one-time owner claim
code) and the owner-invitation reissue and cancel controls on the Readiness tab.

The readiness engine, lifecycle controls, restaurant adoption, owner-control
attestation, delegated drill-in, support triage, receivables, the Activity screen and
Home's needs-attention list are **not built**; those destinations render a placeholder
with a written empty state. See `ADMIN_PORTAL_MVP_v2_3.md` §15 for the sequence.

Deployment is live and automatic — a successful CI run on `main` deploys that exact
commit over OIDC and SSM. See `CLAUDE.md` › Deployment.

## Getting started

```bash
npm ci          # plain ci — no --legacy-peer-deps, see CLAUDE.md
npm start       # http://localhost:4200, NO BACKEND NEEDED
```

`npm start` runs against mock transports, so the complete shell, all five destinations,
the restaurant directory and workspace, restaurant creation, the owner-claim controls
and a dev-only primitives gallery at `/__gallery` render with nothing else running.
Sign in with any username and password; a username containing `locked` exercises the
break-glass recovery-code path, and the code `000000` exercises a failed second factor.
The unhappy paths of creation and the invitation writes have console levers — see
`CLAUDE.md` › Mock Mode.

`ng serve --configuration=live` uses the real API instead (same-origin — it needs
something serving this app and proxying `/api`).

## Checks

```bash
./scripts/verify.sh          # everything CI runs, in the same order
npm run type-check
npm run lint
npm run check:tokens         # design-token gate (self-test, then the real scan)
npm run check:claim-code     # claim-code gate: a raw owner claim code reaches no sink
npm run test:ci
npm run build:prod
npm run check:mock-isolation # after build:prod — scans dist/
```

## Documentation

- `CLAUDE.md` — the authoritative guide to this repo: conventions, tokens, the auth
  contract, the error classifier, what is mock and what is real.
- `AGENTS.md` — the same rules for non-Claude agents.
- `ADMIN_PORTAL_MVP_v2_3.md` — the product specification.
