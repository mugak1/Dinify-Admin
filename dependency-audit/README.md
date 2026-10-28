# dependency-audit

A required dependency audit (D08 B2.1): what was inspected, what the advisory data says
about it, and one policy decision — enforced inside the existing `validate` check. The
same policy runs in Dinify-Frontend (this directory, byte-identical except `policy.json`,
this README, `tests/workflow.test.mjs` and the committed-policy section at the end of
`tests/audit.test.mjs`, which pins each repository's own records; `lib/retained.mjs` carries
the same scanner diagnostics in both, see below) and in Dinify-Backend (`dependency_audit/`, the Python port). `conformance.json` is identical in all three, and each suite pins its
digest.

**A clean application test suite is not a dependency audit, and a scheduled audit that no
required check consumes is not a gate.** This directory puts the audit inside the
required check.

## What is inspected

| graph | what it is | how it is inventoried |
|---|---|---|
| `application` | the lock graph `npm ci` installed for this job | `package-lock.json` (the graph `npm audit` reads — measured: arborist `audit()` calls `loadVirtual()`), reconciled against a walk of `node_modules` |
| `scanner` | the pinned npm that performs the scan | `scanner/package-lock.json`, installed with `npm ci --ignore-scripts` into `scanner/node_modules` |

The inventory is **refused**, not scanned, if the installed tree is not the lock graph: a
locked package that is absent without an explanation, a different installed version, an
extraneous package, a lockfile that does not match `package.json`, a declared dependency
missing from the graph, or an empty graph. Locked-but-absent packages are explained the
way npm decides them: a platform (`os`/`cpu`/`libc`) mismatch, an `engines.node` range this
Node does not satisfy, or an optional subtree npm pruned because its only dependents were
themselves skipped. On Node 20.20.2 this repository's 794 locked packages are 692 installed
plus 96 platform, 1 engines and 5 pruned-subtree absences — every one accounted for.

A package is **runtime** unless its lock entry is `dev` only, in which case it is
**tooling**. `devOptional` (a dev package that is also an optional dependency of a
non-dev one) is runtime, the stricter scope. A devDependency classification decides which
rule applies; it is not evidence that the package never executes or cannot affect the
artifact.

## The policy

| finding | decision |
|---|---|
| critical or high, any scope | **blocking** |
| high on tooling, INHERITED and inside its 7-day window (see "Dated obligations" below) | **deferred** — provenance from the base, the date from GitHub (A-2, below) |
| any severity on a runtime package | **blocking** |
| moderate / low / info on tooling | visible, **triage required** — counted, never reported as zero findings |
| anything the policy cannot evaluate (unknown severity on tooling, unknown scope below high) | **incomplete** |

Five outcomes, and the process exit status follows them:

| outcome | exit | meaning |
|---|---|---|
| `within_policy` | 0 | complete; nothing the policy blocks |
| `exceptions_only` | 0 | complete; passes ONLY because of approved, unexpired exception records — the headline says so |
| `obligations_pending` | 0 | complete; passes ONLY because an inherited high tooling finding is inside its dated window — the headline says so, with the date it starts to block |
| `blocking` | 1 | complete; a blocking finding, or a disposition record was refused |
| `incomplete` | 2 | no trustworthy result: scanner, network, parse, coverage, binding or provenance failure |

Precedence: `incomplete` > `blocking` > `obligations_pending` > `exceptions_only` >
`within_policy`.

### Dated obligations (CI-signal A-1): the evaluator half

Disposition records apply first, unchanged. Then a finding the policy would block, and
that no record covers, is **deferred** (class `deferred`, a `deadline`, counted under
`deferred`) only when ALL of these hold:

- its scope is `tooling` and its severity is `high` — **critical is never deferred**, and
  moderate, low and info stay triage;
- its optional `provenance` is exactly `"inherited"` (the advisory was already reportable
  for the base the change was made on, so the change did not introduce it);
- its optional `reportableSince` is a calendar date `YYYY-MM-DD`, by the same check records
  use, no later than the decision day;
- the decision is made before 00:00 UTC on the deadline, `reportableSince` +
  `HIGH_DEFERRAL_DAYS` (7). The window is a constant beside the rule in `lib/core.mjs`,
  not a `policy.json` value: changing it is a reviewed code change in all three
  repositories.

Anything not established blocks, exactly as before: a missing, `null`, malformed or
unknown provenance; a missing, `null`, malformed, impossible or future date; a deadline
already reached. It never falls back to deferral, and never to incomplete. The one
exception is a provenance or date of the wrong JSON type (a number, a boolean, a list, an
object): that is an adapter that could not fill in a finding, which the existing
malformed-finding rule answers — **incomplete**. `null` reads as absent, as the existing
rule already treats it for the required fields. Each deferred finding gets a
`deferred_finding` reason naming its deadline, and the headline names the earliest one.

**Byte for byte when nothing is deferred.** Until A-2 no adapter emitted `provenance` or
`reportableSince`, so no result carried the new outcome; since A-2 they are emitted only
for an audit given a base (next section). A result in which nothing was deferred is
byte-identical to the one the evaluator produced before the rule: `counts.deferred`, a
finding's `deadline` and the `deferred_finding` reason appear ONLY when a deferral
applied. That is load-bearing, because the release consumers re-decide retained results
and compare `counts` exactly; an always-present `deferred: 0` would make every result
certified before A-1 unreproducible. **The runtime self-test holds it too** (A-2
follow-up): `lib/self-test.mjs` compares each vector's deferred deadlines exactly and
refuses a result that carries `counts.deferred`, a `deadline` or the `deferred_finding`
reason when the vector deferred nothing, so a build whose unit suite was never run still
cannot pass the gate with an evaluator that emits `deferred: 0` or dates a deadline a day
late. `tests/core.test.mjs` pins the full result of each of the 41 vectors that predate
the rule, by digest; the same digests are pinned in Dinify-Backend's Python suite, because
the two evaluators already produced identical bytes.

The shared vectors are now 61 (the 41 before, plus 20 deferral vectors appended after
them), digest `6365e880c55153f5ce50ca144434cb42d5c937be48218445da36cefb8ffb9653`,
byte-identical in the three repositories. The release consumers' passing set accepts
`obligations_pending` and nothing else new.

### Provenance and the clock (CI-signal A-2): the adapters supply both inputs

A-1's rule needs two facts per finding. A-2 supplies them from evidence, and nothing else
can: there is no flag that sets a provenance or a date.

**Provenance is read from a base commit, through git.** `audit --base <commit>` reads
`package-lock.json` and `dependency-audit/scanner/package-lock.json` as that commit held
them (`git show`). A finding is `inherited` only when the base lock has an entry at the
SAME path with the same `version` and the same `integrity`. Anything else is `introduced`:
a path the base does not hold, a package that moved to another path, a changed version or
integrity. **A BUNDLED entry carries no `integrity` of its own** (it ships inside its
bundling package's tarball: all 143 bundled entries of the committed scanner lock's 144),
so for it a version match proves nothing — npm 12 could bundle a different file under the
same version. It is `inherited` only when the NEAREST ancestor that has an integrity (the
bundling package) is itself unchanged in the base, by path, version and integrity;
otherwise it is `introduced` (A-2 follow-up, `npm.mjs` `provenanceOf`). A base with no
lockfile for a graph makes every finding of that graph introduced. The base must be in the
clone and an ancestor of HEAD; otherwise it is recorded as `unavailable`, with the reason,
and treated as no base. **With no base** (an empty or all-zero `--base`, a push that
created a branch, a force push, the scheduled re-scan) findings carry no provenance and
nothing can be deferred, which is today's rule. The collection records the base commit and
each base lock's digest, and `evaluate` re-derives both from git: a base that no longer
reproduces is incomplete (`evidence_base_mismatch`).

**The date is GitHub's, asked once and retained.** After the scans `lib/advisories.mjs`
asks `GET https://api.github.com/advisories/{ghsa_id}` once per distinct GHSA id among the
findings a date could DEFER — an INHERITED, HIGH, TOOLING finding (`awaitsDate`) — from a
child process: 15 seconds per request, no redirects, and the token only when one is given
(`GH_TOKEN`, which the scanner never sees). A critical, a runtime finding, a lower
severity and an introduced finding are never asked about: a date changes nothing for them,
so they simply carry no date (the A-2 follow-up narrowed this; before it every finding
with a provenance was asked about). Dating is unchanged: a date the record holds is
applied to any finding with a provenance, so evidence retained before the narrowing
re-decides byte-identically. `reportableSince` is the UTC calendar date of
`github_reviewed_at`, else of `published_at`. Every answer (a record, a failure, a rate
limit, a timeout) is retained in `advisories.json`, each body with its own digest, and the
collection names the file's digest. **An answer that is not a record of THAT advisory with
a valid date gives no date, and the finding blocks**: an outage, a 403 or a 404 never
defers anything, and never makes the audit incomplete either. A tampered or missing
`advisories.json` is incomplete (`evidence_tampered`, `evidence_unreadable`).

**Re-deciding never asks.** `evaluate` and every release consumer read `advisories.json`
back and re-apply its dates. A result re-decided from its retained evidence at the same
instant is byte-identical; the deadline passing is the same evidence re-decided at a
later instant. Evidence without `advisories.json` (every result before A-2) carries no
provenance and re-decides exactly as before.

**What a run costs**: one request per distinct GHSA id on inherited high tooling findings in
the application and scanner graphs, and none without a base. Unauthenticated, GitHub allows
60 requests an hour per address; with the job token, 1,000 an hour per repository.

**The summary says why a high was not deferred**: `blocking (introduced: not in the base)`,
`blocking (inherited, reportable since <date>; its window has closed)`, or
`blocking (inherited; no reportable date)`. A deferred one reads
`deferred: inherited, blocks from <date>`.

**Where the base comes from in this repository.** `validate` (`ci.yml`) passes
`github.event.pull_request.base.sha || github.event.before`: the pull request's base on a
PR, the previous tip on a push to main. Its checkout is depth 1, so the audit step first
deepens it (`git fetch --no-tags --quiet --unshallow origin "$GITHUB_SHA"`); under the
runner's `bash -e` a failed fetch fails the step, never a silent no-base audit. It passes
`github.token` as `GH_TOKEN`, and the job grants that token `contents: read` and nothing
else (since the A-2 follow-up; it used to take the repository's default grant). The weekly
`audit.yml` re-scan passes no base, so it decides by today's rule. **At promotion**
(`deploy.yml`, `prepare`) the fresh assessment gives the application and scanner graphs
provenance against the candidate's OWN retained locks (nothing can be introduced into
fixed bytes, so an unchanged package is inherited and a trusted scanner that moved since
certification makes what changed introduced). **Its dates are REUSED from the
certification**: the deploy workflow names the downloaded candidate in
`CERTIFIED_CANDIDATE_DIR`, and wherever the certification's own retained `advisories.json`
(bound by sha256 in the certification record) dates an advisory, that date is used and
nothing is asked. Only an advisory it does not date is asked of GitHub, and WITHOUT a
token, so an unanswered request blocks (A-2 follow-up; `release/README.md` says why Admin
cannot give that question a token). The privileged re-decision re-reads the retained
`advisories.json` and never asks; an obligation's deadline cuts the assessment deadline
short. Certification retains the record too (`release/lib/certification.mjs`). See
`release/README.md` → "CI-signal A-2".

**An incomplete audit fails the required check.** An empty report, truncated JSON, an error
body, a scanner that timed out or never ran, a count that is not the lock graph, an
exit status the body contradicts, or an inventory that moved since the snapshot is never
read as clean. npm uses exit 1 both for "vulnerabilities found" and for "the audit
failed", so the status is only accepted when the body agrees with it.

**Every vulnerability the report declares is accounted for, or the audit is incomplete.**
Being unable to interpret a reported vulnerability is not evidence that there is none.
The contract is the pinned scanner's own. It was read from npm 11.19.1 and Arborist 9.9.1;
the pinned npm 11.21.1 bundles Arborist 9.9.3, and the files that write the report (npm's
`lib/commands/audit.js`, Arborist's `audit-report.js`, `vuln.js` and `load-virtual.js`,
`@npmcli/metavuln-calculator` 9.0.3 and `npm-audit-report` 7.0.0) are byte-identical between
the two releases. `vulnerabilities`
is an object keyed by package name, and each entry's `via` holds either an advisory
object (whose `name` and `dependency` are that package) or a STRING naming another entry
the package is vulnerable through. Arborist links every such name before it writes the
report, so a string cause is ordinary and never itself a finding — the finding is the
advisory it leads to, attributed to the advisory's own package, counted once per
(advisory, path). What the reader refuses as **incomplete** (exit 2, raw output and
diagnosis retained):

| shape | reason code |
|---|---|
| `vulnerabilities`, `metadata`, a counter block or an entry that is not the container npm writes (a list, `null`, a scalar); a `via`/`nodes` that is not a non-empty list; a `via` member that is neither a name nor an advisory object | `scanner_shape` |
| counters that do not add up to the entries, a severity distribution the entries do not have, an entry or advisory naming a different package, an entry less severe than its own advisory, an exit status the severity counters contradict | `scanner_inconsistent` |
| a string cause naming an entry the report does not list | `scanner_dangling_cause` |
| an entry no advisory is reachable from — including a cycle of string causes with nothing concrete in it | `scanner_ungrounded` |
| an entry declared more severe than any advisory it reaches | `scanner_unaccounted` |
| an entry on a runtime path whose reachable advisories are attributed to tooling only | `scanner_unattributed` |

A cycle is NOT refused for being a cycle — only when nothing in it reaches an advisory —
and the traversal is a bounded worklist, so a long or cyclic chain can neither hang nor
overflow the stack. An empty `vulnerabilities` object with zero counters is a legitimate
clean report. Optional fields npm omits stay optional; nothing here is a general schema.

**The invocation is hardened because narrowing is invisible.** Measured on main
(`3521ebd`): with an inherited `NODE_ENV=production`, `npm audit --json` reported **zero**
vulnerable packages where it otherwise reports five (ten findings by advisory and path),
while `metadata.dependencies.total` still counted all 794 packages. So
the scanner runs with every dependency type `--include`d, `--package-lock=true`, the
public registry named explicitly, and `NODE_ENV`, `NODE_OPTIONS` and every `npm_*`
variable removed from its environment.
The job's token and the runner's five file-command paths (`GITHUB_ENV`, `GITHUB_PATH`,
`GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, `GITHUB_STATE`) are withheld from it too. That is not a
boundary, since a process on the same runner can still find those files; the boundary is that
the scanner is the pinned, integrity-checked npm, run with scripts disabled.
The audit level is pinned too (`--audit-level=low`, npm's own default): it moves only the
exit code, never the JSON body, but npm reads it from any npmrc the environment scrub
cannot reach, and the exit-status check above assumes it. Measured with the pinned npm, an
`audit-level=none` in `~/.npmrc` made a five-moderate report exit 0; a command-line value
outranks every npmrc, so the invocation and the check cannot disagree.

## Exceptions and triage records

**Three records are approved.** The first is
**`application-http-cache-semantics-GHSA-ch52-4w7c-c8xp`, a
`kind: "exception"` with `scope: "tooling"`, approved by the owner on 2026-10-23 (#46). It
expires on 2026-12-31: valid through 2026-12-30, and it lapses at 00:00 UTC on 2026-12-31 with
no automatic extension.** It replaces the record for the same subject approved on 2026-10-07
(#42), which would have lapsed at 00:00 UTC on 2026-10-31. It covers `http-cache-semantics`
4.2.0 in the APPLICATION graph (GHSA-ch52-4w7c-c8xp). It arrives through `@angular/cli`
21.2.28 → `pacote` 21.5.1 → `make-fetch-happen` 15.0.6, and that traced consumer constructs
its cache policy with `shared: false`. In the runs measured on 2026-10-23, build, test, lint and
`ng version` did not load it. Package operations (`ng add`, `ng update`) were traced in the
source, not exercised. The advisory lists no patched version and 4.3.0 is the latest release.
**http-cache-semantics 4.3.0 is not a fix**: it falls outside the scanner's recorded range, but
the vulnerable max-stale and shared `Set-Cookie` handling is byte-identical. Taking it in the
application graph would hide the finding without remediating it, so it is deliberately not
installed there.

**The other two cover GHSA-xjj6-f33q-929c (`undici`, high: "Denial of Service via unhandled
error on excessive content-encodings"), one per graph, approved by the owner on 2026-10-24
(#48). Both expire on 2026-11-30: valid through 2026-11-29, and they lapse at 00:00 UTC on
2026-11-30 with no automatic extension.** Fixed releases exist (7.30.1 and 6.29.1, both
published 2026-10-15), but neither copy can take one in the lock:
- `application-undici-GHSA-xjj6-f33q-929c` covers `undici` 7.29.1 in the APPLICATION graph.
  `@angular/build` pins it exactly, including the latest 21.2.28, and this repository uses no
  overrides. Its only requirer is the dev server's SSR SSL plugin, which is added only when
  SSR is enabled; `angular.json` configures none. It is not in the production bundle.
- `scanner-undici-GHSA-xjj6-f33q-929c` covers `undici` 6.29.0 bundled in the pinned scanner,
  npm 11.21.1. That is the latest npm 11.x, and npm 12.x needs Node 22. Its only requirer in
  the bundle is `node-gyp`'s download code, which `npm audit` does not run. A scanner crash
  would leave the audit incomplete, which fails closed.

In runs measured on 2026-10-24 with a load probe and positive controls, `ng version`, lint, the
production build, the test suite and the scanner's exact audit argv against both graphs
loaded no file from either copy. `ng serve` was traced in the source, not exercised. The third
copy, `node-gyp`'s in the application graph, took 6.29.1 in the lock in the same change, so
no record covers it.

With these records the audit is **`exceptions_only`**, and the headline says so. It is never
"clean" or "no vulnerabilities". From 00:00 UTC on 2026-11-30 the two `undici` records are
refused as expired, and from 00:00 UTC on 2026-12-31 the http-cache-semantics one is. A
lapsed record's finding blocks, unless a new, separately approved record replaces it.

**Five records were removed when the scanner moved to npm 11.21.1, and only three of the
removals are remediations.** npm 11.21.1 is the first npm whose distributed tarball bundles
fixed copies; 11.19.1, 11.20.0 and 11.21.0 do not, and 12.x requires Node 22.22.2 or later.

| removed record | disposition |
|---|---|
| `scanner-undici-GHSA-rfgv-xxqx-mfg5` | REMEDIATED: npm 11.21.1 bundles `undici` 6.29.0 (patched 6.28.1); the WebSocket handshake now refuses a subprotocol when none was requested |
| `scanner-brace-expansion-GHSA-qhr7-859c-m2p7` | REMEDIATED: `brace-expansion` 5.0.12 (patched 5.0.11); nesting depth is bounded (`EXPANSION_MAX_DEPTH`) |
| `scanner-brace-expansion-GHSA-6j4f-fj2g-mc7p` | REMEDIATED: `brace-expansion` 5.0.12 (patched 5.0.10); `parseCommaParts` is iterative |
| `scanner-http-cache-semantics-GHSA-ch52-4w7c-c8xp` | STALE, **NOT a remediation**: npm 11.21.1 bundles `http-cache-semantics` 4.3.0, outside the recorded range `<=4.2.0`, with the vulnerable mechanism unchanged. npm's own cache policies are still built with `shared: false` |
| `application-braces-GHSA-vfj7-8cjw-p6xm` | STALE, **NOT a remediation**: GitHub WITHDREW GHSA-vfj7-8cjw-p6xm on 2026-10-23 ("not a practically exploitable vulnerability") and npm's advisory feed stopped reporting it. `braces` 3.0.3 is unchanged and still the latest release |

If either stale advisory is reinstated or widened, or the scanner is rolled back, the
finding blocks again with no record. The CONTRACT in `tests/audit.test.mjs` pins that.

Nothing is triaged. The lower-severity tooling findings stay visible as TRIAGE REQUIRED:
- in the application graph: `postcss-selector-parser` 6.1.5, and `undici` 7.29.1 for
  GHSA-4qv8-2p9j-2685 and GHSA-f72v-6w45-q472;
- in the scanner graph: `undici` 6.29.0 for GHSA-4qv8-2p9j-2685, and `ip-address` 10.7.2.

The CONTRACT in `tests/audit.test.mjs` pins the set by id, graph, kind, scope, provenance and
expiry. It drives each record through the real evaluator against its exact subject, asserts
what it must keep refusing (including the other graph's `undici` copy and `node-gyp`'s), and
drives the five former subjects through the evaluator, each of which must block with nothing
covering it.

Several advisories with a supported fixed release were fixed in the lock instead of being
excepted:
- With the 2026-10-01 records: `@angular/router` GHSA-ff3f-86qr-9cv3, `brace-expansion`,
  `engine.io` GHSA-2gc4-cqfq-p2gv, and `undici` GHSA-rfgv-xxqx-mfg5 and GHSA-w293-vg96-wgc3.
  The fix was Angular 21.2.24 (whose `@angular/build` pins `undici` 7.29.1) and in-range
  updates.
- With the 2026-10-07 records: `piscina` GHSA-67c8-pqhq-4rmx, `@modelcontextprotocol/sdk`
  GHSA-6qxp-vccf-f47h, `proxy-addr` GHSA-jqcg-44mw-7w3h and `source-map-js` GHSA-68fv-2mgg-jv7q.
  The fix was `@angular/build` / `@angular/cli` 21.2.26, framework 21.2.25, and in-range
  updates.

A record is refused — and the audit is `blocking` — unless it names the advisory (and aliases),
the exact package, the exact version, the exact graph paths and the scope; carries
applicability evidence and a reason; names an owner; links the mugak1 pull request or issue
that approved it, with who and when; and expires within 90 days of that approval. Wildcards,
ranges, an extra path that matches no current finding, a record that matches nothing
(stale), a mismatched version or scope, a triage record on a blocking finding, an
exception on a triage finding, duplicate ids and unknown fields (an `approved: true` flag,
say) are all refused. A record is valid through the day before `expires`.

**Which advisories are the same is the scanner's statement, never the record's.** A record
names a finding through the finding's own identifier or an alias the scanner reported for
it, and every alias the record lists must be one the scanner reports for that finding. An
alias it does not corroborate refuses the record — otherwise a record for one advisory
could list a second as its "alias" and except both on one approval.

`kind: "exception"` covers a blocking finding; `kind: "triage"` records the decision on a
lower-severity tooling finding. Neither is self-approving: the schema can check that
provenance is *stated*, not that the linked review exists — that is the reviewer's job.

## The state at delivery

`main` (3521ebd) audited **blocking**: five HIGH findings on tooling — `fast-uri` 3.1.5
(GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp) and
`js-yaml` 4.3.1 (GHSA-2883-xcg3-v3hh) — plus five moderate `hono` / `qs` findings requiring
triage. The lock-only repair in this change (in-range `npm update`, no same-day release)
removes all ten: the delivered head audits **within policy with no advisories reported**,
and the production `dist/` is byte-identical to main's.

That was the state when B2.1 was delivered, and it has not held since.

On 2026-10-07, `main` (89d2cf1) audited **blocking** with seven blocking findings. Four had
a fixed release and were fixed in the lock, as listed above. Three had none and are covered
by the 2026-10-07 exceptions. After that change the measured graphs audit **`exceptions_only`**
and are not within policy. The only shipped-byte change is `@angular/router` 21.2.25.

Measured for this change on 2026-10-23 at about 18:35 UTC. The runs were local on Node 20.20.0,
credential-free, with install scripts disabled and against the live advisory data.
- **`main` (e864c826) audited blocking.** The braces record matched no finding and was refused
  as stale. The other five records still applied: 20 findings, 5 excepted and 15
  lower-severity tooling findings requiring triage.
- **With this change, the same application graph audits `exceptions_only`.** The scanner is
  npm 11.21.1 and the policy holds the one 2026-10-23 record. There are 8 findings: 1 under
  that record and 7 lower-severity tooling findings requiring triage. Nothing blocks and no
  record is refused. The 7 are:
  - in the application graph: `ip-address` 10.5.0 (five advisories) and
    `postcss-selector-parser` 6.1.4;
  - in the scanner graph: `ip-address` 10.7.2.

No application dependency moved.

Later on 2026-10-23, a lock-only update (AD-1 from the reviewed lower-severity triage) moved
two application tooling entries: `ip-address` 10.5.0 → 10.7.4 and `postcss-selector-parser`
6.1.4 → 6.1.5. No `package.json` edit, no override, and no exception or triage record was
added or changed. It was measured at about 22:09 UTC under the same conditions as the
previous measurement (local, Node 20.20.0, credential-free, install scripts disabled, live
advisory data). Against that, `main` (ed6430d) still audited as described above.
- **The audit is still `exceptions_only`**, now with 3 findings across both graphs: 1 under the
  2026-10-23 record and 2 lower-severity tooling findings requiring triage. Nothing blocks and
  no record is refused.
- The five application `ip-address` advisories are gone: the scan reports none against
  `ip-address` 10.7.4.
- The 2 are:
  - in the application graph: `postcss-selector-parser` 6.1.5 (GHSA-rj75-hqrm-r3gf). 6.1.5 is
    the upstream 6.x backport of the fix, inside Tailwind 3's `^6.1.2`. The advisory data
    still lists it as affected, so the finding stays visible;
  - in the scanner graph: `ip-address` 10.7.2 (GHSA-rxp7-6hxx-x8q5), which this update does
    not touch.
- The production `dist/` is byte-identical to main's.

That did not hold through the merge. Advisories published afterwards made `main` (c88a75b)
audit **blocking** on 2026-10-24, measured at 18:25 UTC: 15 findings, 4 of them blocking.
`body-parser` GHSA-27r3-jxmh-p828 (high; karma's copy, 1.20.8) was published between #47's PR
audit and its merge audit. `undici` GHSA-xjj6-f33q-929c (high) appeared at three paths.
`fast-uri` 3.1.8 and `undici` gained lower-severity advisories. #48 answers it as follows:
- Lock-only, in range: karma's `body-parser` 1.20.8 → 1.20.9, `node-gyp`'s `undici` 6.29.0 →
  6.29.1, and `fast-uri` 3.1.8 → 3.1.9. No `package.json` edit and no override.
- The two `undici` exceptions above, for the copies with no lock-only fix.

Measured at 18:53 UTC under the same conditions, the audit is **`exceptions_only`** with 8
findings across both graphs: 3 under approved exceptions and 5 lower-severity tooling findings
requiring triage. Nothing blocks and no record is refused. The production `dist/` is
byte-identical to main's.

## How it runs

```
npm ci
npm run audit:snapshot   # offline — right after install, before any repository code
…                        # every existing gate, plus `npm run test:audit` (offline matrix)
npm run audit:deps       # NETWORK — self-test, then the bound scan and the decision
```

`audit:deps` refuses to scan anything but the snapshotted inventory, installs the pinned
scanner, scans both graphs, re-checks the inventory before and after each scan, and writes
`evidence/`: `snapshot.json`, `collection.json` (bindings, argv, exit statuses, digests),
`result.json` (the decision), and each graph's complete raw stdout and stderr. CI uploads
it as the artifact `dependency-audit-<run>-<attempt>` whether the job passed or not.
`node dependency-audit/cli.mjs evaluate` re-decides retained evidence offline, and refuses
evidence recorded for another revision, lockfile or environment, or raw output that is not
the bytes that were recorded.

`./scripts/verify.sh` runs the same sequence; the network step is labelled as such and a
failed scan fails the run.

## What this does not cover

Stated so none of it is inferred:

- **The deploy no longer re-installs or rebuilds (D08 B2.4).** `deploy.yml` promotes the
  exact candidate `validate` certified, and before promotion it runs a FRESH assessment of
  that candidate's RETAINED lock graph (the `package.json` / `package-lock.json` the
  certification bound) and of the pinned scanner's own graph, under the trusted policy at
  the deploy workflow's own revision. That replay is `lib/retained.mjs`, the module
  Dinify-Frontend uses for the same purpose, INCLUDING the scanner diagnostics Frontend #709
  added: each scan also keeps a bounded, sanitized projection of npm's own debug log beside
  its raw output (a test pins the file's digest; see `release/README.md` → "Scanner
  diagnostics"). It is SCAN-ONLY: a directory holding exactly
  the two retained files, no `node_modules`, no candidate script. It does not re-observe
  what was installed at certification (those bytes are gone); that is the certification
  snapshot, checked to be exactly the retained graph. The window is 24 hours from the
  start of collection and the host enforces it. See `release/README.md`.
- **Not audited here:** the GitHub Actions used by the workflows, the runner image's own
  tooling (the AWS CLI the deploy job uses included), and anything installed on the host.
- **Branch protection is not changed.** "The audit is wired into `validate`" and "GitHub
  settings prevent bypassing `validate`" are separate facts; this change establishes only
  the first.
- The mock-isolation scanner's self-test and coverage qualification landed separately (B2.3).
