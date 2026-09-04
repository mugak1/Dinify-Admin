# Dinify Admin — Agent Instructions

This repo uses `CLAUDE.md` as the main project context and development guide, and
`ADMIN_PORTAL_MVP_v2_3.md` as the governing product specification.

Before making changes:
1. Read `CLAUDE.md`, then the relevant section of `ADMIN_PORTAL_MVP_v2_3.md`.
2. Follow the repo's existing Angular/Tailwind patterns — standalone components,
   signals, built-in control flow, `inject()`, inline templates.
3. Never spell a design value in a component. Colours, sizes and radii live in
   `src/styles.css` and `tailwind.config.js`; `scripts/check-design-tokens.mjs`
   enforces it.
4. Make the smallest safe change.
5. Do not make broad refactors unless explicitly requested.
6. Run `./scripts/verify.sh` before preparing a PR and paste the output.

Eight rules that are easy to break by habit:
- Global navigation is FIVE destinations. New capability becomes a restaurant-detail
  tab or a needs-attention condition, never a sixth sidebar item.
- Filters go in the URL via `core/url/query-param.ts`, never in component state.
- Never branch on `instanceof HttpErrorResponse`. Mock-mode errors are an `Error`
  subclass carrying `status`, so an instanceof check is dead code in the one mode this
  work gets reviewed in. Use `classifyTransportFailure` from
  `core/api/transport-failure.ts`.
- An unreachable service is NOT a signed-out operator. Never clear the session store
  for a failure the server did not answer — see the three bootstrap outcomes in
  `CLAUDE.md`.
- LOADING, EMPTY and FAILED are three different answers and must never look alike. A
  failed read never renders as an empty list.
- A mock is chosen at BUILD TIME, never reached for when a request fails. Real failure
  is not mock data, and a control plane showing fixtures for an unreachable server is
  showing a portfolio that does not exist.
- Templates are inline, so a BACKTICK inside one terminates the TypeScript template
  literal — including inside an HTML comment. Write prose, or single quotes.
- A raw owner claim code is a BEARER CREDENTIAL shown once. It may live in a
  component's transient state to be displayed and copied, and nowhere else — never
  storage, the URL, router state, the workspace store, a canonical model, a log, a
  notice, or a fabricated claim link. `scripts/check-claim-code-handling.mjs` enforces
  it, and the vocabulary is issue / reissue / cancel — never send, resend, sent or
  delivered, because nothing is delivered.

For Codex Desktop work:
- Use Worktree mode by default.
- Keep changes isolated to the requested task.
- Summarize the diff before committing or creating a PR.
