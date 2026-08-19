# Dinify Admin Portal — MVP Specification v2.3

**Status:** Phase 0.5 complete; Phase 1 ready to begin · August 2026 · **Supersedes v2.2 in full**
**What changed from v2.2:** an information architecture (§9) that v2.2 lacked entirely; a corrected readiness definition (§10) resolving a contradiction between v2.2 §9 and its own Definition of Done; Home reframed as an operator inbox rather than a dashboard (§11); a read-only Activity view promoted into MVP (§12); lifecycle transitions given preflight consequence screens (§13); the owner-invitation state machine specified (§14); and UI conventions locked (§16). Sections 1–8 carry over from v2.2 with light edits.

---

## 1. Purpose

The operator cockpit for a one-person platform company: take a signed restaurant from handshake to live, paying tenant — and keep it that way — without opening a Django shell. Three jobs: **Onboard**, **Operate**, **Collect & Observe**.

The **screen-worthiness rule** governs scope: a task earns a screen only when frequency × error-cost beats the shell alternative.

**The design principle v2.2 was missing, stated plainly:** design the interface around **decisions and exceptions**, not around the backend's models or the list of features implemented. The operator does not open this tool to admire metrics; they open it because something needs doing.

## 2. What is already built (Phase 0 + 0.5, merged and deployed)

Unchanged from v2.2 §2. In summary: the Falcon admin module and all platform-role authority are gone from the customer application, with source ratchets in both repos; `admin.dinifyapp.com` is a live separate origin with its own WSGI daemon, settings module and `ROOT_URLCONF`; authentication is opaque hashed cookie sessions with TOTP, recovery codes that survive Fernet-key loss, and progressive lockout; `AdminAuditLog` is append-only Postgres with redaction; the lifecycle vocabulary is `onboarding / live / suspended / offboarded` with a single transition service; order admission is synchronised with lifecycle transitions through transaction-scoped advisory locks; delegation is scoped, time-boxed, reasoned and audited.

Since v2.2: PR-H landed the dashboard metric definitions (`orders_placed` denominator, `payment_tracking_enabled` flag, `sales_amount` realigned onto `sale_filters`), fixed `tables.py`'s broken locking query, deleted `handle_add_order_items`, and collapsed the order-path N+1s (54 → 26 queries for a four-line order). The deploy pipeline moved to SSM with SHA pinning. The RDS point-in-time restore test is proven. External uptime monitoring is live.

## 3. Origin topology and deployment

`admin.dinifyapp.com` is Apache-served with Django mounted at `/api` on the same origin — Firebase Hosting cannot proxy to EC2, which is why the admin frontend is not on Firebase like its siblings.

**Deploy is build in CI → artefact to a private S3 prefix → GitHub OIDC → `aws ssm send-command` syncing into `/var/www/dinify-admin`**, with an **SPA fallback in Apache that excludes `/api`** so deep links such as `/restaurants/:id/readiness` survive a refresh.

> **EDITORIAL CORRECTION, applied when this document was version-controlled (2026-08-19).** v2.2 §3 and the v2.3 draft both described this transport as a build plus a file sync over SSH in a GitHub Action. That path was **retired by backend PR #281**: the UAT instance's security group does not admit GitHub-hosted runners, so it died at connect timeout, and the `UAT_SSH_*` secrets were deleted on 2026-08-18. The backend deploy now assumes a repo-scoped IAM role via GitHub OIDC and dispatches through SSM Send-Command; the admin frontend follows the same transport. The text above is corrected rather than merely annotated because a version-controlled spec instructs every future session, and leaving the stale sentence in place would instruct them to resurrect a path that cannot work.

## 4. Identity

Unchanged from v2.2 §4. One `User` table; `account_type` decides the plane; active platform staff hold zero restaurant memberships, enforced at four layers.

## 5. Delegation — Gate 1 decisions

Unchanged from v2.2 §5. Support delegation and assisted onboarding are separate authority domains. Delegation is a support session, never impersonation: no membership, no owner identity, full attribution. `view` reads the operational surface with **field-level allowlists**; `support` adds today's two writes (support-issue creation, menu-item stock toggle) and no more without demonstrated need. Delegation does not bypass suspension.

## 6. Onboarding and suspension — Gate 1 decisions

Unchanged from v2.2 §6. White-glove onboarding is a hands-on operational service performed through the restaurant portal with the owner present; **no admin-plane onboarding API in Phase 1**. Owner-controlled always: account claim, credentials, privileged staff, payment-provider connection, payment-mode confirmation, **go-live approval**, anything contractual.

Suspension policy, to be settled and built within the lifecycle slice: ordinary suspension blocks new trading but lets already-accepted orders progress to terminal states; emergency freeze is a separate exceptional action; cancellation requires a defined financial resolution; offboard is refused while active orders remain; freeing a table is a consequence of reaching a terminal order state.

## 7. Cross-origin handoff — Gate 2 decisions

Unchanged from v2.2 §7. Popup opened synchronously on click; workspace generates a PKCE verifier and announces readiness; code minted only after readiness with a ~60-second TTL; `postMessage` with exact origin and source validation over a transferred `MessagePort`; redemption by POST with the verifier; 15-minute in-memory header-only session; minimal uncached bootstrap route; COOP tested; countdown at two minutes, warning at thirty seconds, explicit audited renewal, never silent.

## 8. Receivables

Unchanged from v2.2 §8. `RestaurantSubscription` + `SubscriptionInvoice` + `SubscriptionPayment`. Manual mark-paid is the sole write. **The receivables seam (`has_outstanding_receivables`) must be wired in the same PR that makes invoices capable of becoming overdue.**

---

## 9. Information architecture — NEW

v2.2 listed features without saying how they compose. This section fixes that, and it is the most consequential addition in v2.3.

**One dominant object: the restaurant.** Nearly every Phase 1 task is restaurant-scoped — readiness, lifecycle, owner claim, payment mode, subscription, invoices, support issues, delegation, QR provisioning, audit history. If those become top-level destinations the portal fragments immediately.

**Global navigation is five destinations and nothing more:**

```
Home          — needs attention (§11)
Restaurants   — directory → detail workspace
Support       — issue inbox
Receivables   — invoices
Activity      — audit trail (§12)
──────────────
<operator name> / Sign out
```

**Onboarding, Readiness, Lifecycle, QR, Delegation and Payments do not appear in global navigation.** They are things done *to* a restaurant and live inside it. Future capability usually becomes another restaurant-detail tab or another needs-attention condition rather than a new sidebar item.

### 9.1 Restaurant detail workspace

The most important screen in the portal. A persistent header carrying state, then tabs:

```
← Restaurants

Kampala Bistro                                    [Primary action]
Kololo, Kampala · REST-0018
● ONBOARDING    Cash only    Trial    [TEST if applicable]

Overview | Readiness | Billing | Support | Activity
```

**The primary action is lifecycle-dependent**, so the interface says what should happen next rather than merely displaying state: `onboarding` → **Review readiness**, or **Go live** once ready; `live` → **Open workspace**; `suspended` → **Review suspension**; emergency freeze → **Resolve incident**.

Consequential, infrequent actions live in an overflow menu — go live, suspend, offboard — with **emergency freeze visually and interactionally separated** from ordinary suspension, per §6's insistence that they are different operations.

**Overview** shows: a needs-attention block if anything blocks go-live; owner and claim status; payment mode; subscription and trial end; operational summary (last order, tables, dining areas); and the three or four most recent activity entries with a link to the full tab.

### 9.2 URL scheme

Meaningful, deep-linkable, refreshable, with working browser Back:

```
/restaurants                      /support
/restaurants/:id                  /support/:issueId
/restaurants/:id/readiness        /receivables
/restaurants/:id/billing          /receivables/:invoiceId
/restaurants/:id/support          /activity
/restaurants/:id/activity
```

**Filters persist in the URL**, not component state: `/restaurants?status=onboarding&attention=true`. This is what makes needs-attention links from Home actually work.

## 10. Go-live readiness — CORRECTED

**v2.2 contradicted itself.** §9 listed five blockers (published menu item, QR-provisioned table, completed test order, payment mode set, subscription record) while §13's Definition of Done additionally required "the owner having claimed their own account and confirmed go-live." Both were written by me; they never agreed. §10 is the reconciliation, and the Definition of Done wins because owner control is a Gate 1 decision.

**Readiness is a rules engine, not a list of booleans**, because some requirements are conditional on restaurant configuration:

**Restaurant setup** — at least one published, available menu item; at least one enabled table with a valid current-`qr_version` QR; a completed end-to-end test order (`has_completed_test_order()`).

**Ownership** — owner account **claimed** (not merely invited); owner **go-live approval** recorded.

**Commercial** — subscription record created; payment mode confirmed.

**Conditional** — if `vat_registered` is true, TIN is required. If payment mode is `psp_live`, PSP merchant onboarding must be complete; if `cash_only`, PSP status is irrelevant and must not appear as a blocker. The engine evaluates applicability before evaluating satisfaction.

All are **hard, server-side** blockers enforced by `check_go_live_readiness()` at the `onboarding → live` transition. Soft warnings — missing imagery, additional staff not provisioned, optional training — surface but do not block.

**Presentation:** completed items recede visually; incomplete blockers are prominent. Do not give every item a bright badge — the point is to draw the eye to what remains, following task-list research rather than decorating what is already done.

**Open question requiring a decision before this ships:** *how* does an owner record go-live approval? A confirmation in their own portal is the obvious candidate, but it needs designing, and it is the last owner-controlled gate before a restaurant trades. Flagged, not assumed.

## 11. Home — an operator inbox, not a dashboard — REVISED

v2.2 had "Dashboard, last." That was right about *metrics* and wrong about *Home*.

**`/` is a needs-attention list.** Every item is computable from existing lifecycle, receivables, support and delegation state — **no event infrastructure**, satisfying the condition v2.1 §8 already set for a derived panel. Deferring the event bus was correct; deferring the concept was not.

Conditions that produce an item: a restaurant with outstanding go-live blockers; an owner invitation nearing expiry or expired; an overdue invoice; a support issue open beyond a threshold; an unresolved emergency freeze; an open delegated session. Each item names the restaurant, states the condition in one line, and links directly to the place it is resolved.

Beneath it, a **small portfolio summary** — live, onboarding, overdue invoices, open issues — as context, not as a dashboard.

**Metrics and charts come last**, and only when a chart answers an operational question that a number cannot. Test restaurants (`is_test`) are excluded from every portfolio figure.

## 12. Activity — read-only audit view — PROMOTED TO MVP

`AdminAuditLog` is synchronous, transactional, redacted and attribution-aware. If the only way to read it is `psql`, most of that value is unrealised — and "why is this restaurant suspended?" and "what did I change yesterday?" are questions a solo operator asks often.

A **read-only** view, presented as narrative rather than a raw table: timestamp, actor, action in plain language, and the affected resource. Expanding a row reveals request ID, delegation ID, before/after state, source IP, result — with redaction intact.

Available globally at `/activity` and filtered per restaurant under its Activity tab. No write actions, no deletion, no export in Phase 1.

## 13. Lifecycle transitions — preflight required — NEW

**Do not build a status dropdown.** A consequential state machine presented as a profile field invites accidents.

Present current state with its meaning, then actions:

```
Lifecycle: LIVE
Restaurant is currently accepting diner orders.
[Pause ordering]   [More actions ▾]
```

**Every transition runs a preflight that states consequences against current conditions before the operator commits** — for suspension: how many accepted orders will continue to fulfilment, how many tables are occupied, what value is outstanding on those orders, whether any payment incident is unresolved. Consequences vary with state, so they must be computed and shown, not written as static copy.

A **written reason is required** on every transition, consistent with the audit contract. **Emergency freeze** is presented as a distinct operation with its own entry point and its own confirmation, never as another option in the same menu.

**After execution, close the loop:** confirm what changed, state what remains — "New orders blocked. 3 accepted orders remain in fulfilment" — and link to them.

## 14. Owner invitation state machine — NEW

"Invite owner to claim" needs more than a button, because owner claim is a hard readiness blocker.

**States:** not invited → invitation sent → claimed; plus expired and cancelled. **Actions:** send, resend, cancel. **Displayed:** recipient, sent timestamp, expiry timestamp.

**Delivery failure must be visible.** The Yo SMS gateway reports outcomes inside HTTP 200 bodies, so "the notification service accepted the request" is not "the owner can claim their account." The UI must distinguish accepted-for-delivery from delivered, and surface failures rather than showing an optimistic Sent.

This lives on the restaurant's Readiness tab, where the blocker it satisfies also lives.

## 15. Phase 1 scope and sequence

**0. Scaffold** — `mugak1/Dinify-Admin`, tokens, shell with the §9 navigation, auth against `/api/admin/v1/auth/*`, table/status/button primitives. Deploy (S3 + OIDC + SSM, per §3) is **0C** and is deliberately not part of the scaffold PR.

**1. Restaurant directory + detail workspace shell** — the §9.1 structure with Overview populated. Directory columns: restaurant, lifecycle, **readiness**, payment mode, subscription, open issues, last activity. Filters: All / Needs attention / Onboarding, plus status and search. No bulk actions or saved views — nothing legitimate happens in bulk across tenants.

**2. Create restaurant shell + owner invitation** (§14).

**3. Readiness engine + QR generation** (§10) — landing as **one vertical slice with step 2**. Never ship restaurant creation that leaves tenants permanently stranded.

**4. Lifecycle controls** (§13), including the §6 suspension policy as design-then-build.

**5. Delegated drill-in** — §5 scope, §7 handoff.

**6. Support triage** — rebuilt natively on `/api/admin/v1`; PR-A deleted the old endpoints.

**7. Receivables** (§8).

**8. Activity view** (§12) — could land earlier if the audit surface is stable; it is read-only and cheap.

**9. Home needs-attention list** (§11) — grows incrementally as its source conditions become available; the shell exists from step 0.

**10. Portfolio metrics** — last.

**Do not finalise PSP-shaped models ahead of counsel and PSP answers.**

## 16. UI conventions — NEW

**Status badges sparingly.** Lifecycle, subscription and incident status are enough. Not every noun becomes a coloured pill; badges are status, never interactive.

**Test restaurants must be unmistakable.** A persistent `TEST` treatment on the detail header, the directory row and the delegated workspace, and exclusion from every portfolio and financial figure.

**Time is East Africa Time, explicitly.** `15:42 EAT · 19 Aug 2026`, optionally with relative time alongside. Administration may happen from another timezone; "yesterday at 23:50" must never be ambiguous.

**Currency is `UGX 150,000`** — no decimals, no faux precision.

**No optimistic UI for consequential writes.** Lifecycle transitions, go-live, offboard, mark-paid and incident resolution remain visibly pending until the server has committed and audited them.

**Keyboard-first, desktop-first, not mouse-only.** Interactive rows and controls at 40–44px rather than designing to the WCAG 2.2 minimum. Visible focus states. A command palette is welcome where it fits naturally.

**Visual distinctness from the restaurant portal is a safety requirement**, not a preference: during a delegated session both are open simultaneously, and confusing them means acting in the wrong place. Dark chrome with a light working area; one typeface (Plus Jakarta Sans) with tabular numerals in numeric columns; tighter radii and denser rows than the consumer surfaces; tables over card grids. **Brand red `#FF2C32` remains the interactive colour** pending a visual review at real density — with a darker red for destructive actions and amber for warning states, so the palette still distinguishes "do this" from "careful" from "something is wrong."

## 17. Explicitly deferred

WebAuthn/passkeys. Separate `support-workspace` origin. Postgres append-only trigger — immutability is honestly documented as application-enforced. A deployment check refusing non-PostgreSQL production. Payment-event observability (Phase 3, post-counsel). Event-driven action queue infrastructure — the §11 list is derived, not evented. CRM, dunning, generic reports centre, broadcast comms, EFRIS integration (fields only), DSR console, multi-admin RBAC UI, feature-flag console, diner-PII browser, incident management platform, advanced analytics, saved views, bulk actions, mobile-first admin.

## 18. Follow-up queue

Diner reads inconsistent at `suspended` (menu 503; order-details, payment-details and review all succeed). A delegated administrator still reads the kitchen board of a suspended restaurant. Both are product decisions belonging to the §13 lifecycle slice. A customer-plane liveness endpoint so the customer API can be monitored the same way the admin plane is.

## 19. Definition of done

*A restaurant goes from signed to live — every hard blocker in §10 enforced server-side, including the owner having claimed their own account and approved go-live — with its first `SubscriptionInvoice` recorded and later marked paid, entirely from `admin.dinifyapp.com`, by a platform-staff account authenticated with TOTP over an opaque cookie session, with every control-plane and delegated action attributable in `AdminAuditLog` and readable in the Activity view.* Nothing contradicts the non-custodial rule.

## 20. Still open, non-engineering

Ugandan payments counsel on the non-custodial flow. PSP confirmation of per-restaurant merchant onboarding. First paying restaurant. **These remain the binding constraints on the business, not the architecture.**
