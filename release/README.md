# release — certified promotion for the Admin control plane (D08 B2.4)

An Admin release reaches `admin.dinifyapp.com` only when the deployment can establish
four things from evidence it checks itself:

1. **Certified.** The exact payload was produced and checked by one selected, successful
   `validate` run on a push to `main`: that run, that attempt, and its candidate artifact
   by id and digest. It was built from the stated source and dependency inventory.
2. **Freshly assessed.** A new advisory query covers the candidate's retained dependency
   graph and the pinned scanner's own graph, under the trusted audit policy. It must be
   acceptable, and it must still be inside its 24-hour window when the host switches.
   Every exception it relied on must still be in force at that moment.
3. **The same bytes.** What the privileged job uploads, and what the host installs,
   reuses or rolls back to, is that payload. The host recomputes the payload tree digest
   from the files before it promotes anything.
4. **Honest failure.** Failing to obtain or validate any of that stops the promotion, and
   the run says which evidence was missing.

Nothing else changed. The transport is still GitHub OIDC → private S3 → SSM → an
immutable release directory → one symlink. There is no Firebase, no new platform and no
new credential.

This file is documentation, not the gate. The gate is `lib/` and the two workflows,
held by `tests/`.

## The three identities, kept apart

| identity | what it digests | where it is used |
|---|---|---|
| **payload tree digest** `sha256:…` | every served file: entries sorted by path, each `<utf8 length>:<path>\0<sha256>\n` (Dinify-Frontend's `treeDigest`, byte for byte) | the release directory name, the host's check before every promotion, `DEPLOYED-PAYLOAD`, the admission |
| **payload archive sha256** | `payload.tar.gz`: canonical ustar, regular files only, fixed mtime/owner/mode, sorted, gzip level 9, so it is reproducible | the S3 key `admin/<sha>/<archive>.tar.gz`, re-hashed before upload and again on the host |
| **artifact digest** | the zip GitHub stores for the candidate upload | selecting and downloading the candidate by id (`digest-mismatch: error`) |

None of them digests itself.

`release.txt` is still exactly `<sha>\n` at the release root, so every existing reader is
unchanged: the host, the ordering guard, and Dinify-Frontend's Admin serving check. The
certification record and the dependency evidence travel **beside** the payload, never in
it. No dependency report, inventory, receipt or CI-only record is in the webroot, and a
test pins that.

## Producer — certification inside `validate` (ci.yml)

```
npm ci → audit:snapshot → … every existing gate … →
release:prebuild → build:prod → check:mock-isolation → release:freeze →
audit:deps → release:certify → upload admin-candidate-<run>-<attempt>
```

- **`prebuild`** refuses any file, link or other entry already under `dist/`: output
  from anywhere else cannot be certified. Empty directories carry no byte, and are
  tolerated and recorded. That matters because `test:ci` runs first, and the Karma
  builder leaves an empty `dist/test-out/` behind. It also refuses an inventory that moved
  since the audit snapshot. It opens the chain in `release/.work/continuity.json`.
- **`freeze`** records the tree digest of exactly the output the mock-isolation gate
  scanned, and re-checks the inventory. The output must not contain `release.txt`, which
  is reserved.
- **`certify`** requires all of the following:
  - the output is still the frozen tree;
  - the inventory is still the snapshot;
  - the audit evidence belongs to this checkout, is passing, and re-evaluates to the same
    decision from its own raw output;
  - the run context is the policy's (`mugak1/Dinify-Admin`, `ci.yml`, job `validate`),
    and `GITHUB_SHA` is `HEAD`.

  It then writes `release/.work/candidate/`:
  - `payload.tar.gz`: the built output plus `release.txt`;
  - `certification.json`: schema `dinify.admin.certification/1`, the record;
  - `evidence/inputs/`: `package.json`, `package-lock.json`, `angular.json`, and the
    scanner's `package.json` and `package-lock.json`;
  - `evidence/audit/`: policy, snapshot, collection, result, and the four raw scanner
    outputs.
- **The upload has no `if:`.** A job in which any gate failed produces no candidate.
- **A pull-request run produces a candidate the same way, and it is never promotable.**
  Retention is 7 days for a pull request and 90 days for a push.

The record binds:
- the repository, commit and tree, and the git blob of every input;
- the workflow path, job, event, ref, run and attempt;
- the configuration, the Node and npm versions, and the environment;
- the inventory binding, the scanner identity, and the audit outcome and invocation time;
- the continuity chain;
- the payload: tree digest, entries, `index.html` digest, and archive digest and size;
- every evidence file's digest.

## Consumer — `deploy.yml`

### `prepare` — unprivileged (`contents: read`, `actions: read`)

1. **Resolve the identity.** Automatic runs come from the triggering run, re-fetched from
   the API and checked against the workflow id of `ci.yml`. Manual runs take `sha`,
   `mode`, and optionally `ci_run_id`.
2. **Check out the trusted verifier.** This is `release/` and `dependency-audit/` at
   `github.sha` (the workflow's own revision, never the target): sparse, depth 1, no
   persisted credential.
3. **Ancestry, and CI green on `main`** (unchanged).
4. **Read the facts from the API.** This covers the target commit and its tree (inputs by
   blob, and whether the tree carries `release/policy.json`). It also covers the
   `release/` and `dependency-audit/` trees at the workflow revision and on `main` now.
5. **Select the candidate.**
   - Automatic runs use the triggering run and nothing else.
   - Manual runs use `ci_run_id`, or the only successful push-to-main run for the SHA.
     More than one is ambiguous and refused.

   That run's own listing must name exactly one `admin-candidate-<run>-<attempt>` for its
   own attempt: unexpired, with an id and a digest. A complete listing is required.
6. **Download the candidate** by id, with digest enforcement.
7. **Evaluate.** This step inspects the candidate against the facts, runs the fresh
   assessment, and writes the admission. The admission and the raw assessment output are
   retained as `admin-admission-<run>-<attempt>` for 90 days, whatever the outcome.

### `deploy` — privileged (`id-token: write`)

It runs only workflow shell, first-party actions, the AWS CLI, and the trusted verifier
(`node trusted/release/cli.mjs`, which imports only `node:` built-ins, `release/` and
`dependency-audit/lib/`, as a test pins). It runs no `npm`, no build, no scanner, and no
checkout of the target.

1. Re-derive the identity and require exact agreement with `prepare`.
2. Re-certify against the current `main`.
3. Take its **own** sparse checkout of the verifier at `github.sha`, asserted pristine.
4. Re-read **its own** facts: the same commit, trees, run and listing, plus this run's own
   artifact listing, where the admission must appear under the id and digest that
   `prepare`'s upload reported.
5. Download the admission and the candidate, by id, with digest enforcement.
6. **Verify.** The same decision function runs again over this job's own facts. That
   includes the candidate's bytes and the assessment reproduced from its raw output under
   the trusted policy. The uploaded admission must bind exactly the same target, mode,
   source, run, attempt, artifact, certification digest, payload, assessment, trusted
   trees and evaluation. The deadline must also be at least the dispatch margin
   (30 minutes) away. Only bounded, validated values leave the step: kind, payload tree,
   archive digest, `index.html` digest and the deadline as an epoch second.
7. Run the ordering guard (below). Then, and only then: validate the role ARN, request
   OIDC credentials, and upload.
8. **Upload.** The candidate's `payload.tar.gz` is re-hashed against the verified digest
   immediately before `aws s3 cp`.
9. **SSM**, running the embedded host procedure.
10. **Public verification.** Check `release.txt` (exact SHA, `no-store`), health and `/`.
    For a certified release, fetch every admitted file back and compare it byte for byte.
    This is one vantage point at one moment, and is reported as nothing more.
11. **Record the outcome.** This covers what was admitted and on what evidence, and that
    OIDC capability exists in every step of this job. It also records whether credentials
    were obtained, which mutations were attempted (S3, SSM) and what was observed.

## The fresh assessment

`lib/assessment.mjs` runs over `dependency-audit/lib/retained.mjs`, which is copied
byte-for-byte from Dinify-Frontend (`5453f5f2…7ab5`; a test pins the digest).

- **Scan-only replay.** The scanner runs in a directory holding exactly the retained
  `package.json` and `package-lock.json`. `npm audit` reads the lock graph. No
  `node_modules`, no candidate script, no hook and no build run there.
- **The scanner** is installed from the **trusted** checkout's own scanner lock
  (`npm ci --ignore-scripts`), and its own graph is assessed as installed now.
- **What is not re-observed:** the node_modules certification installed. Those bytes are
  gone. They are the certification snapshot, which is checked to be exactly the retained
  graph. Nothing forges a `node_modules` directory, and nothing is described as observed
  that was not.
- **The TRUSTED policy decides.** This is `dependency-audit/policy.json` at the workflow
  revision, identified by the sha256 of its bytes. It is never the policy the candidate
  carries, which only reproduces what certification decided. An exception approved at
  certification and removed since therefore blocks, and a test shows it.
- **Bound to the candidate and the evaluator.** The assessment records the commit, run,
  attempt, artifact id and digest, certification digest, payload tree and archive, and
  the evaluating workflow, run, attempt and revision.
- **Freshness.** The window is 24 hours from the **start of collection**. The deadline is
  the earlier of the window end and the lapse (00:00 UTC on `expires`) of any record the
  decision applied. The same deadline is enforced three times:
  - by `prepare`;
  - by the privileged verification, with a 30-minute margin;
  - by the host, as an epoch second, at the start and again immediately before the
    switch.
- **A policy that moved** stops the promotion and requires a new evaluation. That is,
  `release/` or `dependency-audit/` on `main` differ from the verifier this run used.
- **A new advisory can refuse unchanged bytes.** A scanner failure, an error body,
  truncated output, a timeout or a failed scanner install is **incomplete**, never a pass.

## The host procedure

It is embedded in `deploy.yml`, so it is always `main`'s procedure, even for a rollback.

- **Certified releases live at `/var/www/dinify-admin-releases/<sha>-<payload tree hex>`.**
  - **Install.** Check the free-space floor, download, and verify the archive sha256.
    Validate every member before anything is written: regular files only, canonical
    names, each name once, never both a file and a parent, and no link, directory entry,
    pax header or traversal. Extract, fix the permissions, then check the tree digest of
    the staged directory **and** of the installed directory. A refused archive is a
    `DEPLOY-FAILED`.
  - **Reuse and rollback.** The directory is promoted only if its files **are** the
    admitted payload. A same-commit directory holding other bytes is refused. It is
    never selected, overwritten or repaired.
  - **Rollback** downloads nothing, extracts nothing, and does not check free space.
- **After the switch**, the host checks `release.txt`, then `index.html` byte for byte
  against the admitted digest, then health, `/` and a deep SPA route. On any failure it
  restores the previous target and the run stays red.
- **Markers.** A certified release reports `DEPLOYED-PAYLOAD: sha256:<tree>` and
  `DEPLOYED-HEAD: <sha>`. A legacy rollback reports `DEPLOYED-KIND: legacy-unassessed`.
  The workflow requires the one that matches the kind it verified.

## Automatic ordering

These are automatic runs only. Manual runs are never subject to them.

| served vs target | decision |
|---|---|
| target descends from the served commit | `AUTO-PROCEED` |
| same commit, **every** admitted file matches publicly | `AUTO-SKIP-IDENTICAL-ARTIFACT` |
| same commit, some file differs or is unreachable | `AUTO-SKIP-SAME-COMMIT`. Nothing deployed, and the summary says this is **not** evidence that this candidate is served |
| target is an ancestor of the served commit | `AUTO-SKIP-STALE` |
| diverged, unreadable, cacheable or failed read | **fail closed** |

An automatic run whose target predates the contract is refused at `prepare`: it fails
red, and is not a green skip. Only a re-run of a pre-merge CI run can produce one.

## Legacy rollback — the approval point

A commit whose tree has no `release/policy.json` predates this contract. That means
`eb54c92` and everything before it. Such a commit has no candidate, and none can be
manufactured.

- **Deploying one is refused** (`pre_contract_target`). A rebuild is not a certified
  candidate.
- **Rolling back to an already-installed one is preserved exactly as before:**
  `/var/www/dinify-admin-releases/<sha>`, validated by `release.txt`, permissions and
  shape. Every record and summary labels it **NOT certified, NOT freshly assessed**.

This is the owner's current emergency recovery, and it has not been removed. **Retiring
it is a decision for the owner, and it is not taken here.** It would mean refusing
legacy rollback outright once enough certified releases are installed to fall back on.
It is a one-branch change in `decideAdmission` plus the host's `legacy` case. It should
land only with an explicit approval that names which installed releases stay reachable.

**Rolling back to a CERTIFIED release** requires the same evidence as promoting it:
- the candidate artifact must still exist (it expires after 90 days, or less if the
  repository's retention cap is lower — that cap is not observable from here);
- the fresh assessment must pass.

If a newer advisory blocks the older release, its rollback is refused. What remains is a
legacy rollback (while those directories exist) or a forward fix. There is deliberately
no evidence-free override for a new promotion.

## Permissions

| job | before (`eb54c92`) | after |
|---|---|---|
| `validate` (ci.yml) | no `permissions:` block: the repository default, which is not observable from here | unchanged. It also uploads `admin-candidate-*`, which uses the runner's artifact token, not a new grant |
| `deploy.yml` → `prepare` | `contents: read`, `actions: read` | unchanged |
| `deploy.yml` → `deploy` | `id-token: write`, `contents: read`, `actions: read` | unchanged |
| IAM role, S3 key layout, instance, bucket | `admin/<sha>/<archive>.tar.gz` | unchanged |

**What moved** is which code runs where:
- `prepare` no longer runs `npm ci` or `ng build`. It runs the pinned scanner.
- `deploy` now runs the trusted verifier, which uses built-ins only.
- `ci.yml`'s `checkout` and `setup-node` are now SHA-pinned to the same reviewed commits
  `deploy.yml` already used.

## What merging does

Admin `main` deploys automatically.

1. `ci.yml` runs on the push of the merge commit `M`, certifies it, and uploads
   `admin-candidate-<run>-1`. This is the first candidate that exists.
2. `deploy.yml` starts from `workflow_run`. `prepare` installs the pinned scanner from
   the registry, assesses `M`'s retained graph live, and writes the admission. `deploy`
   verifies it. The ordering guard sees the served commit (currently `eb54c92`, unless
   something is deployed in between), and `M` descends from it, so the run proceeds.
3. The host installs `M` at `/var/www/dinify-admin-releases/M-<tree>` (a **new** naming
   scheme) and promotes it. Every existing directory is left untouched.
4. **Failure modes on this first run**, all fail-closed:
   - a new advisory against `M`'s graph: `M` is not deployed and `eb54c92` stays live;
   - a scanner or registry failure: incomplete, red, nothing deployed;
   - a public byte-for-byte check that fails after the host switched: red, **DEGRADED**.
     The host's own `index.html` check passed. The recovery is a manual legacy rollback
     to `eb54c92`.
5. `eb54c92` and earlier remain reachable by **legacy rollback only**, as above.

**Coordination.** `deploy.yml` is the file Dinify-Frontend's Admin peer receipt covers.
The Frontend compatible set still approves Admin `1993a087`. The first deployment of `M`
will turn Frontend's next readiness run red (`peers.admin_serving_unapproved`) until a
receipt for `M` is approved. That refresh is a separate change in Dinify-Frontend.

## How it is tested

`npm run test:release` (offline) runs the suites in `tests/`:

| suite | holds |
|---|---|
| `tree-archive` | the tree digest (Node and the host's Python, against Dinify-Frontend's vector); archive round trip and reproducibility; 13 refused archive shapes |
| `certification` | the producer interfered with at one boundary per case (stale output, inventory moved during the build or after the audit, output moved after freeze, blocking or incomplete audit, missing or forged raw output); the consumer refusing a PR candidate, the wrong run, attempt, commit, tree, repository, configuration or inputs, and a same-SHA substituted payload |
| `assessment` | a clean control; a newly published high advisory against unchanged bytes; four scanner failures, and scanner install failure; the trusted policy overriding the certification-time exception; record lapse inside the window; the reproduction refusing a rewritten outcome, swapped raw output, another candidate, an extra file, a moved window, a future decision |
| `admission` | run and artifact selection (13 refusal cases, including the other-attempt artifact, ambiguity and a truncated listing); the decision (legacy rollback, pre-contract deploy, moved policy, another evaluation's assessment, another artifact, a substituted payload); the privileged re-decision (disagreement, received-bytes mismatch, margin, legacy) |
| `remote` | the host procedure **as `deploy.yml` embeds it**, under a host model: install, identical reuse, **same-SHA substitution refused**, 9 hostile archives, digest mismatch, a consistent-but-different archive, the deadline at start and mid-install, certified and legacy rollback, health and `index.html` failures restoring, permissions. It also runs **the pre-change procedure** (`tests/baseline/remote-eb54c92.sh`, extracted verbatim and pinned to the history when present) against the same states as distinguishing controls |
| `workflow` | the privilege boundary (static); certification ordering and gate skipping (simulated sequencing); the verifier's import graph; the remote-script writer, the upload re-hash and the ordering guard **executed** under stubs; and the verify step executing the **real CLI** from a fixture checkout |
| `cli` | `choose-run` ambiguity; unknown options refused; the byte-for-byte served check against a local server |

**Mutation table.** Seventeen source mutations were each applied alone, and each failed
a named subset:
- the host skipping the tree check on reuse or rollback;
- the pre-switch deadline check removed;
- the disk floor applied to rollback;
- duplicate archive members accepted;
- a PR run selected;
- a moved policy ignored;
- the bindings not compared;
- no margin;
- the decision trusted rather than reproduced;
- no window;
- record lapse ignored;
- the policy identity not checked;
- the consumer ignoring the event;
- the candidate uploaded after a failed gate;
- the upload not re-hashing;
- the evaluation attempt not bound;
- the admission listing digest not compared.

**Two pre-existing oracles were corrected, not deleted.**
- `scripts/tests/mock-isolation.test.mjs` asserted that the deploy builds and gates the
  `dist/` it packages. It now asserts build → gate → freeze, adjacent, in `validate`, and
  that the deploy builds nothing.
- `dependency-audit/tests/workflow.test.mjs` expected only evidence retention after the
  scan. It now expects certify and the candidate upload (no `if:`) before it.

The invariant behind each is unchanged.

**What is MODELLED, not proved:**
- GitHub itself: queueing, concurrency, masking, the artifact store, and the API's
  answers, which are modelled as JSON built from real git objects;
- OIDC, S3 and SSM;
- the real host, whose paths are relocated. Apache is a `curl` stub, the bucket is a
  directory, and `df` and `date` are stubbed where a case needs them.
- **Ownership**, when the matrix is not root. GitHub's runner is the unprivileged
  `runner` user, so the model maps the procedure's two ownership lines (the `chown` to
  root, and the refusal of anything not owned by root) to the current uid. Each must
  match exactly once, or the model throws. Installed releases are given 0755/0644
  explicitly rather than inheriting the runner's umask. As root nothing is mapped.

The scanner's answers are canned in the suites. The live scanner is exercised by the real
end-to-end proof in the PR, and by every CI run. **No production substitution was
reproduced**, only the local host model and the local adapters.

## Remaining work, not done here

- **Backend promotion** is not bound to any of this.
- **B3: a host identity beyond `release.txt`.** The host attests the payload tree in its
  output, but there is no served identity document yet.
- **The owner prerequisites Frontend records** remain, and so does Frontend's legacy
  `deploy-prod.yml` cutover.
- **Optimized browser journeys** against a promoted Admin build.
- **The tooling-vulnerability disposition.** No triage records exist; lower-severity
  tooling findings stay visible as triage required.
- **Retiring legacy rollback.** This is the approval point above.
- **Branch protection** is unchanged.
