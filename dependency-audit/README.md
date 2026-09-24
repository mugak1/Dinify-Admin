# dependency-audit

A required dependency audit (D08 B2.1): what was inspected, what the advisory data says
about it, and one policy decision — enforced inside the existing `validate` check. The
same policy runs in Dinify-Frontend (this directory, byte-identical except `policy.json`,
this README and `tests/workflow.test.mjs`) and in Dinify-Backend (`dependency_audit/`,
the Python port). `conformance.json` is identical in all three, and each suite pins its
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
| any severity on a runtime package | **blocking** |
| moderate / low / info on tooling | visible, **triage required** — counted, never reported as zero findings |
| anything the policy cannot evaluate (unknown severity on tooling, unknown scope below high) | **incomplete** |

Four outcomes, and the process exit status follows them:

| outcome | exit | meaning |
|---|---|---|
| `within_policy` | 0 | complete; nothing the policy blocks |
| `exceptions_only` | 0 | complete; passes ONLY because of approved, unexpired exception records — the headline says so |
| `blocking` | 1 | complete; a blocking finding, or a disposition record was refused |
| `incomplete` | 2 | no trustworthy result: scanner, network, parse, coverage, binding or provenance failure |

**An incomplete audit fails the required check.** An empty report, truncated JSON, an error
body, a scanner that timed out or never ran, a count that is not the lock graph, an
exit status the body contradicts, or an inventory that moved since the snapshot is never
read as clean. npm uses exit 1 both for "vulnerabilities found" and for "the audit
failed", so the status is only accepted when the body agrees with it.

**The invocation is hardened because narrowing is invisible.** Measured on main
(`3521ebd`): with an inherited `NODE_ENV=production`, `npm audit --json` reported **zero**
vulnerable packages where it otherwise reports five (ten findings by advisory and path),
while `metadata.dependencies.total` still counted all 794 packages. So
the scanner runs with every dependency type `--include`d, `--package-lock=true`, the
public registry named explicitly, and `NODE_ENV`, `NODE_OPTIONS` and every `npm_*`
variable removed from its environment.

## Exceptions and triage records

`policy.json → records` is empty, and **nothing in this change approves anything.** A record
is refused — and the audit is `blocking` — unless it names the advisory (and aliases),
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

- **The deploy re-installs; it does not re-audit.** `deploy.yml` builds from the same
  lockfile (so the same graph, integrity-checked) and requires a successful `ci.yml` run on
  main for the exact SHA — which now includes this audit. It does not bind a FRESH audit to
  the built artifact, and a manual deploy or rollback can run long after that CI run. That
  binding, and the 24-hour promotion freshness window, are the next B2 delivery.
- **Not audited here:** the GitHub Actions used by the workflows, the runner image's own
  tooling (the AWS CLI the deploy job uses included), and anything installed on the host.
- **Branch protection is not changed.** "The audit is wired into `validate`" and "GitHub
  settings prevent bypassing `validate`" are separate facts; this change establishes only
  the first.
- The pre-existing mock-isolation scanner's self-test/coverage work is a separate B2 item.
