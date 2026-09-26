#!/usr/bin/env node
/**
 * release — the CLI the Admin workflows call. See release/README.md.
 *
 * CERTIFICATION (inside `validate`, ci.yml):
 *   prebuild                          before `npm run build:prod`
 *   freeze                            after the mock-isolation gate
 *   certify                           after the dependency audit; writes the candidate
 *
 * PROMOTION (deploy.yml):
 *   commit-facts   --target --facts DIR                        the target as the API holds it
 *   choose-run     --target [--explicit ID] --listing F         the ONE eligible certifying run
 *   select         --target --facts DIR                        its candidate, by id and digest
 *   evaluate       (prepare, UNPRIVILEGED; NETWORK) inspect the candidate, assess it now,
 *                  decide, and write the admission
 *   verify         (deploy, PRIVILEGED; no network, no npm) decide AGAIN over its own facts
 *                  and require the uploaded admission to agree
 *   served         --origin --admission F [--cache-bust X]      fetch every admitted file back
 *
 * Exit status: 0 success · 1 refused · 2 unusable input · 64 usage. There is no option that
 * skips a check, substitutes a scanner or policy, or accepts a refusal.
 *
 * IMPORTS ONLY node: BUILT-INS AND FILES UNDER release/ AND dependency-audit/lib/. The
 * privileged job runs this file from a sparse checkout of exactly those two directories at
 * the workflow's own revision, with no npm; a test holds the import graph to that.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnRunner, loadPolicy } from '../dependency-audit/lib/audit.mjs';
import { assess } from './lib/assessment.mjs';
import { ADMISSION_DOC, commitFacts, decideAdmission, selectCertification, trustedTrees, verifyAdmission } from './lib/admission.mjs';
import { certify, freeze, inspectCandidate, prebuild } from './lib/certification.mjs';
import { ID_RE, SHA_RE, admissionArtifactName, isObject, loadReleasePolicy, parseJson, recordBytes, reason } from './lib/common.mjs';
import { sha256Hex, walkTree } from './lib/tree.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clock = () => new Date().toISOString();

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    out[key] = value;
    i += 1;
  }
  return out;
}

const readJson = (path) => {
  if (!existsSync(path)) return null;
  const r = parseJson(readFileSync(path));
  return r.ok ? r.value : null;
};

function setOutputs(file, values) {
  if (!file) return;
  appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]/g, ' ')}\n`).join(''));
}

function report(problems, label) {
  for (const p of problems) console.error(`  ✗ ${p.code}: ${p.detail}`);
  console.error(label);
}

/** The trusted checkout, proven to be the revision the workflow names, and loaded into memory. */
function trustedState(revision, factsDir) {
  const problems = [];
  const git = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']).stdout?.trim();
  if (!SHA_RE.test(String(revision)) || head !== revision) problems.push(reason('trusted_unreadable', `the verifier checkout is ${head}, the workflow revision is ${revision}`));
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', 'release/lib', 'release/cli.mjs', 'release/policy.json', 'dependency-audit/lib', 'dependency-audit/policy.json', 'dependency-audit/scanner/package.json', 'dependency-audit/scanner/package-lock.json']);
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') problems.push(reason('trusted_modified', `the verifier checkout has local changes: ${dirty.stdout.trim().split('\n').slice(0, 5).join(', ')}`));
  const { policy, problems: pp } = loadReleasePolicy(ROOT);
  problems.push(...pp);
  const local = {};
  for (const p of policy?.trusted.paths ?? []) local[p] = git(['rev-parse', `HEAD:${p}`]).stdout?.trim();
  const trees = trustedTrees(readJson(join(factsDir, 'trusted-tree.json')), policy?.trusted.paths ?? []);
  const mainTrees = trustedTrees(readJson(join(factsDir, 'main-tree.json')), policy?.trusted.paths ?? []);
  if (!trees || JSON.stringify(trees) !== JSON.stringify(local)) problems.push(reason('trusted_unreadable', 'the API tree of the workflow revision is not the checkout the verifier runs from'));
  const { policy: auditPolicy } = loadPolicy(ROOT);
  const read = (p) => readFileSync(join(ROOT, p));
  return {
    problems,
    policy,
    trusted: {
      revision,
      trees,
      mainTrees,
      releasePolicyBytes: read('release/policy.json'),
      auditPolicy,
      auditPolicyBytes: read('dependency-audit/policy.json'),
      scannerManifest: read('dependency-audit/scanner/package.json'),
      scannerLock: read('dependency-audit/scanner/package-lock.json'),
    },
  };
}

function readCandidate(dir) {
  if (!dir || !existsSync(dir)) return { files: new Map(), problems: [] };
  const w = walkTree(dir);
  return { files: w.files, problems: w.problems.map((p) => reason('candidate_unsafe', p)) };
}

function certificationFacts(factsDir) {
  const f = (n) => readJson(join(factsDir, n));
  return { ciWorkflow: f('ci-workflow.json'), run: f('run.json'), artifacts: f('artifacts.json') };
}

function commitOf(target, factsDir) {
  return commitFacts({ target, commit: readJson(join(factsDir, 'commit.json')), tree: readJson(join(factsDir, 'tree.json')) });
}

/** The options each command accepts. Anything else is a usage error, never ignored. */
const OPTIONS = {
  prebuild: [], freeze: [], certify: [],
  'commit-facts': ['target', 'facts', 'outputs'],
  'choose-run': ['target', 'event-run', 'explicit', 'listing'],
  select: ['target', 'facts', 'outputs'],
  evaluate: ['target', 'mode', 'source', 'facts', 'candidate', 'out', 'replay', 'run-id', 'run-attempt', 'revision', 'outputs'],
  verify: ['target', 'mode', 'source', 'facts', 'candidate', 'admission', 'run-id', 'run-attempt', 'admission-id', 'admission-digest', 'admission-attempt', 'revision', 'out', 'outputs'],
  served: ['origin', 'admission', 'cache-bust'],
};

function main(argv) {
  const [command, ...rest] = argv;
  let a;
  try { a = args(rest); } catch (error) { console.error(error.message); return 64; }
  const unknown = Object.keys(a).filter((k) => !(OPTIONS[command] ?? []).includes(k));
  if (command in OPTIONS && unknown.length) { console.error(`${command}: unknown option ${unknown.map((k) => `--${k}`).join(', ')}`); return 64; }
  switch (command) {
    case 'prebuild':
    case 'freeze': {
      const r = (command === 'prebuild' ? prebuild : freeze)(ROOT, { now: clock() });
      if (!r.ok) { report(r.problems, `release ${command}: REFUSED — no candidate can be certified from this build.`); return 1; }
      console.log(command === 'freeze' ? `release freeze: the output the mock-isolation gate scanned is ${r.treeDigest} (${r.entryCount} files)` : `release prebuild: no prior output bytes${r.emptyDirectories.length ? ` (${r.emptyDirectories.length} empty director${r.emptyDirectories.length === 1 ? 'y' : 'ies'} tolerated: ${r.emptyDirectories.join(', ')})` : ''}; the installed inventory is still the audit snapshot`);
      return 0;
    }
    case 'certify': {
      const r = certify(ROOT, { now: clock() });
      if (!r.ok) { report(r.problems, 'release certify: REFUSED — no candidate is produced.'); return 1; }
      console.log(`release certify: candidate for ${r.record.commit} (run ${r.record.workflow.runId} attempt ${r.record.workflow.runAttempt}, ${r.record.workflow.event})`);
      console.log(`  payload tree     ${r.record.payload.treeDigest} (${r.record.payload.entryCount} files)`);
      console.log(`  payload archive  sha256:${r.record.payload.archive.sha256}`);
      console.log(`  certification    ${r.recordDigest}`);
      console.log(`  audit            ${r.record.audit.outcome} (collection invoked ${r.record.audit.invokedAt})`);
      return 0;
    }
    case 'commit-facts': {
      const c = commitOf(a.target, a.facts);
      if (!c.facts) { report(c.problems, 'commit-facts: the target commit could not be read'); return 2; }
      setOutputs(a.outputs, { has_contract: c.facts.hasContract ? 'true' : 'false', tree: c.facts.tree });
      console.log(JSON.stringify(c.facts));
      return 0;
    }
    case 'choose-run': {
      // automatic: the triggering run and nothing else. manual: the operator's run, or the
      // ONLY successful push-to-main run for the target; more than one is ambiguous.
      if (a['event-run']) { if (!ID_RE.test(a['event-run'])) return 2; console.log(a['event-run']); return 0; }
      if (a.explicit) { if (!ID_RE.test(a.explicit)) { console.error('ci_run_id is not a run id'); return 2; } console.log(a.explicit); return 0; }
      const listing = readJson(a.listing);
      const runs = isObject(listing) && Array.isArray(listing.workflow_runs) ? listing.workflow_runs : null;
      if (!runs || listing.total_count !== runs.length) { console.error('choose-run: the run listing is unreadable or incomplete'); return 2; }
      const eligible = runs.filter((r) => r.head_sha === a.target && r.event === 'push' && r.head_branch === 'main' && r.conclusion === 'success');
      if (eligible.length === 1) { console.log(String(eligible[0].id)); return 0; }
      console.error(eligible.length === 0
        ? `choose-run: no successful push-to-main CI run exists for ${a.target}`
        : `choose-run: ${eligible.length} successful push-to-main CI runs exist for ${a.target} (${eligible.map((r) => r.id).join(', ')}); dispatch again naming ci_run_id`);
      return 1;
    }
    case 'select': {
      // WHICH candidate to download: the chosen run's own listing, by id and digest.
      const { policy, problems } = loadReleasePolicy(ROOT);
      if (!policy) { report(problems, 'select: the release policy is unusable'); return 2; }
      const sel = selectCertification({ policy, target: a.target, ...certificationFacts(a.facts) });
      if (!sel.selection) { report(sel.problems, 'NO ELIGIBLE CANDIDATE — nothing can be promoted for this target.'); return 1; }
      const s = sel.selection;
      setOutputs(a.outputs, { run_id: s.runId, run_attempt: s.runAttempt, artifact_id: s.artifact.id, artifact_digest: s.artifact.digest, artifact_name: s.artifact.name });
      console.log(`candidate: ${s.artifact.name} (artifact ${s.artifact.id}, ${s.artifact.digest}) from run ${s.runId} attempt ${s.runAttempt}`);
      return 0;
    }
    case 'evaluate': {
      const state = trustedState(a.revision, a.facts);
      const commit = commitOf(a.target, a.facts);
      const cand = readCandidate(a.candidate);
      const cert = certificationFacts(a.facts);
      const out = a.out;
      mkdirSync(out, { recursive: true });
      // Everything the decision reads is in memory BEFORE the scanner (third-party code)
      // runs, and the scanner inherits no step-output or environment file to write to.
      for (const key of ['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY', 'GITHUB_STATE', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[key];
      const problems = [...state.problems, ...commit.problems, ...cand.problems];
      const assessDir = join(out, 'assessment');
      if (!problems.length && commit.facts?.hasContract) {
        const sel = selectCertification({ policy: state.policy, target: a.target, ...cert });
        if (sel.selection) {
          const inspection = inspectCandidate(cand.files, { policy: state.policy, commit: a.target, tree: commit.facts.tree, inputBlobs: commit.facts.inputBlobs, runId: sel.selection.runId, runAttempt: sel.selection.runAttempt });
          if (!inspection.problems.length) {
            const r = assess({
              trustedRoot: ROOT, inspection,
              candidate: { commit: a.target, runId: sel.selection.runId, runAttempt: sel.selection.runAttempt, artifactId: sel.selection.artifact.id, artifactDigest: sel.selection.artifact.digest },
              assessor: { workflowPath: state.policy.evaluation.workflowPath, runId: a['run-id'], runAttempt: a['run-attempt'], revision: a.revision },
              outDir: assessDir, replayDir: a.replay, runner: spawnRunner, clock,
            });
            console.log(`fresh assessment: ${r.doc.headline}`);
            console.log(`  collected ${r.doc.startedAt} → ${r.doc.finishedAt}`);
          }
        }
      }
      const decision = problems.length
        ? { decision: 'refused', kind: null, reasons: problems, record: { schema: 'dinify.admin.admission/1', decision: 'refused', target: a.target, mode: a.mode, source: a.source, reasons: problems, decidedAt: clock() } }
        : decideAdmission({
          policy: state.policy, target: a.target, mode: a.mode, source: a.source, commit: commit.facts, certification: cert,
          candidateFiles: cand.files, assessmentFiles: existsSync(assessDir) ? walkTree(assessDir).files : new Map(),
          trusted: state.trusted, evaluation: { runId: a['run-id'], runAttempt: a['run-attempt'] }, now: clock(),
        });
      writeFileSync(join(out, ADMISSION_DOC), recordBytes(decision.record));
      setOutputs(a.outputs, {
        decision: decision.decision,
        kind: decision.kind ?? '',
        run_id: decision.record.certification?.runId ?? '',
        artifact_id: decision.record.certification?.artifact?.id ?? '',
        payload_tree: decision.record.payload?.treeDigest ?? '',
      });
      console.log(`admission: ${decision.decision}${decision.kind ? ` (${decision.kind})` : ''}`);
      if (decision.decision === 'refused') { report(decision.reasons, 'NOT ADMITTED — nothing may be promoted from this evaluation.'); return 1; }
      return 0;
    }
    case 'verify': {
      const state = trustedState(a.revision, a.facts);
      const commit = commitOf(a.target, a.facts);
      const cand = readCandidate(a.candidate);
      const problems = [...state.problems, ...commit.problems, ...cand.problems];
      // The admission artifact is THIS run's, by id and digest, as the API lists it.
      const listing = readJson(join(a.facts, 'run-artifacts.json'));
      const entry = Array.isArray(listing?.artifacts) ? listing.artifacts.filter((x) => String(x?.id) === String(a['admission-id'])) : [];
      const attempt = a['admission-attempt'];
      // upload-artifact reports its digest as bare hex; the API lists `sha256:<hex>`.
      const uploaded = /^[0-9a-f]{64}$/.test(String(a['admission-digest'])) ? `sha256:${a['admission-digest']}` : String(a['admission-digest']);
      if (listing?.total_count !== listing?.artifacts?.length) problems.push(reason('admission_unlisted', 'this run\'s artifact listing is incomplete'));
      if (entry.length !== 1 || entry[0].expired !== false || entry[0].digest !== uploaded || !ID_RE.test(String(attempt))
          || Number(attempt) > Number(a['run-attempt']) || entry[0].name !== admissionArtifactName(state.policy ?? { evaluation: { admissionPrefix: '?' } }, a['run-id'], attempt)) {
        problems.push(reason('admission_unlisted', `artifact ${a['admission-id']} is not this run's admission (${admissionArtifactName(state.policy ?? { evaluation: { admissionPrefix: '?' } }, a['run-id'], attempt)}) with the digest it was downloaded under`));
      }
      const admissionDir = a.admission;
      const admissionBytes = existsSync(join(admissionDir, ADMISSION_DOC)) ? readFileSync(join(admissionDir, ADMISSION_DOC)) : Buffer.alloc(0);
      const assessDir = join(admissionDir, 'assessment');
      if (problems.length) { report(problems, 'VERIFICATION REFUSED — no credential will be requested.'); return 1; }
      const now = clock();
      const res = verifyAdmission(admissionBytes, {
        policy: state.policy, target: a.target, mode: a.mode, source: a.source, commit: commit.facts, certification: certificationFacts(a.facts),
        candidateFiles: cand.files, assessmentFiles: existsSync(assessDir) ? walkTree(assessDir).files : new Map(),
        trusted: state.trusted, evaluation: { runId: a['run-id'], runAttempt: attempt },
      }, { now, marginMinutes: state.policy.freshness.dispatchMarginMinutes });
      if (!res.ok) { report(res.reasons, 'VERIFICATION REFUSED — no credential will be requested.'); return 1; }
      const v = res.verified;
      writeFileSync(a.out, recordBytes({ ...v, verifiedAt: now, admissionSha256: sha256Hex(admissionBytes) }));
      setOutputs(a.outputs, { kind: v.kind, payload_tree: v.payloadTree, archive_sha256: v.archiveSha256, index_sha256: v.indexSha256, deadline_epoch: v.deadlineEpoch });
      console.log(`verified: ${v.kind} ${v.mode} of ${v.target}${v.kind === 'certified' ? ` — payload sha256:${v.payloadTree}, promotable until ${new Date(Number(v.deadlineEpoch) * 1000).toISOString()}` : ' — LEGACY: not certified, not freshly assessed'}`);
      return 0;
    }
    case 'served': {
      return served(a).then((code) => code);
    }
    default:
      console.error('usage: node release/cli.mjs <prebuild|freeze|certify|commit-facts|choose-run|select|evaluate|verify|served> [options]');
      return 64;
  }
}

/**
 * Fetch release.txt and every admitted payload file back from the origin and compare
 * bytes. One vantage point at one moment — it is evidence of what that request received,
 * nothing more. Prints JSON; exits 0 only when every file matches and release.txt is the
 * admitted commit, served no-store.
 */
async function served(a) {
  // The privileged verification's own output (verified.json: `entries`) or an admission
  // record (`payload.entries`) — the two agree by construction; the workflow reads the first.
  const admission = readJson(a.admission);
  const entries = admission?.entries ?? admission?.payload?.entries;
  if (!isObject(admission) || !Array.isArray(entries) || !entries.length || !SHA_RE.test(String(admission.target))) { console.error('served: no admitted payload entries'); return 2; }
  const cb = a['cache-bust'] ?? String(Date.now());
  const get = async (path) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(`${a.origin}/${path}?cb=${encodeURIComponent(cb)}`, { redirect: 'manual', cache: 'no-store', signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), cacheControl: res.headers.get('cache-control') ?? '' };
    } catch (error) {
      return { status: 0, bytes: Buffer.alloc(0), error: String(error?.cause?.code ?? error?.message ?? error) };
    } finally { clearTimeout(timer); }
  };
  const out = { origin: a.origin, commit: admission.target, checked: 0, matched: 0, mismatched: [], unreachable: [] };
  const rel = await get('release.txt');
  out.release = { status: rel.status, body: rel.bytes.toString('utf8').trim(), noStore: /(^|,)\s*no-store\s*(,|$)/i.test(rel.cacheControl) };
  for (const e of entries) {
    const r = await get(e.path.split('/').map(encodeURIComponent).join('/'));
    out.checked += 1;
    if (r.status !== 200) out.unreachable.push(`${e.path}: ${r.status || r.error}`);
    else if (sha256Hex(r.bytes) !== e.sha256) out.mismatched.push(e.path);
    else out.matched += 1;
  }
  out.allMatch = out.matched === entries.length;
  console.log(JSON.stringify(out));
  return out.allMatch && out.release.status === 200 && out.release.body === admission.target && out.release.noStore ? 0 : 1;
}

const code = main(process.argv.slice(2));
if (code instanceof Promise) code.then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
else process.exitCode = code;
