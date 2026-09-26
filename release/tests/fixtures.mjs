/**
 * A disposable, CERTIFIED Admin-shaped project for the release matrix: a real git
 * repository holding a real package.json / v3 lockfile / node_modules tree (the
 * dependency-audit fixture's), angular.json, the committed release policy, a build
 * output, and audit evidence produced by the REAL audit orchestration — then run through
 * the REAL prebuild → freeze → certify producer.
 *
 * WHAT IS SYNTHETIC, stated: the scanner's ANSWERS (canned `npm audit --json` bodies,
 * injected at the runner seam — the live scanner is exercised separately); the "build"
 * (files written to dist/ instead of `ng build`); and the GitHub facts (run ids,
 * attempts, artifact listings), which are modelled as the JSON the API returns. The git
 * objects, the files, the digests and every decision are real.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { audit, snapshot } from '../../dependency-audit/lib/audit.mjs';
import { CLEAN, CLEAN_SCANNER, cannedRunner, fakeInstall, makeProject } from '../../dependency-audit/tests/project.mjs';
import { commitFacts } from '../lib/admission.mjs';
import { assess } from '../lib/assessment.mjs';
import { certify, freeze, inspectCandidate, prebuild } from '../lib/certification.mjs';
import { loadReleasePolicy } from '../lib/common.mjs';
import { walkTree } from '../lib/tree.mjs';

export const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const RUN_ID = '4200000001';
export const RUN_ATTEMPT = '1';
export const EVAL_RUN_ID = '4200000099';
export const NOW = '2026-09-26T09:00:00.000Z';

const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
};

export const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' } }).trim();

/** The runner's context for a certifying `validate` run (a push to main unless overridden). */
export function ciEnv(root, overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'mugak1/Dinify-Admin',
    GITHUB_WORKFLOW_REF: 'mugak1/Dinify-Admin/.github/workflows/ci.yml@refs/heads/main',
    GITHUB_JOB: 'validate',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: git(root, 'rev-parse', 'HEAD'),
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
    ...overrides,
  };
}

export const BUILT = {
  'index.html': '<!doctype html><html><head><script src="main-AAAA1111.js" type="module"></script></head><body></body></html>\n',
  'main-AAAA1111.js': 'console.log("certified main");\n',
  'chunk-BBBB2222.js': 'export const x = 1;\n',
  'styles-CCCC3333.css': 'body{margin:0}\n',
  'media/font-DDDD4444.woff2': 'woff2-bytes',
};

/**
 * A project in the state CI leaves it in just before `release:prebuild`: committed, npm
 * "installed", the audit snapshot taken. The release policy is the committed one with
 * the Node major set to the one running the tests (CI runs Node 20; the policy pins 20).
 */
export function freshProject({ nodeMajor = Number(process.versions.node.split('.')[0]), records = [], withVerifier = false } = {}) {
  const p = makeProject({ records });
  // The verifier's own code, committed into the fixture, so the REAL CLI can run from it
  // as the trusted checkout (its ROOT is the repository that contains it).
  if (withVerifier) {
    cpSync(join(REPO_ROOT, 'release', 'cli.mjs'), join(p.root, 'release', 'cli.mjs'));
    cpSync(join(REPO_ROOT, 'release', 'lib'), join(p.root, 'release', 'lib'), { recursive: true });
    cpSync(join(REPO_ROOT, 'dependency-audit', 'lib'), join(p.root, 'dependency-audit', 'lib'), { recursive: true });
  }
  const policy = JSON.parse(readFileSync(join(REPO_ROOT, 'release', 'policy.json'), 'utf8'));
  policy.build.nodeMajor = nodeMajor;
  write(join(p.root, 'release', 'policy.json'), policy);
  write(join(p.root, 'angular.json'), { projects: { dinify_admin: { architect: { build: { configurations: { production: {} } } } } } });
  write(join(p.root, '.gitignore'), '/node_modules/\n/dist/\n/dependency-audit/evidence/\n/dependency-audit/scanner/node_modules/\n/release/.work/\n');
  git(p.root, 'init', '-q', '-b', 'main');
  git(p.root, 'add', '-A');
  git(p.root, 'commit', '-q', '-m', 'fixture');
  snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
  return p;
}

export function writeBuild(root, files = BUILT) {
  for (const [path, text] of Object.entries(files)) write(join(root, 'dist', path), text);
}

/**
 * The whole producer: prebuild → build → freeze → audit (canned answers) → certify.
 * Each stage can be interfered with through `between`, which is how the matrix moves an
 * inventory, rewrites an output or swaps evidence at exactly one boundary.
 */
export function certifiedProject({ answers = {}, env = {}, between = {}, records = [], withVerifier = false } = {}) {
  const p = freshProject({ records, withVerifier });
  const stages = {};
  stages.prebuild = prebuild(p.root, { now: NOW });
  between.afterPrebuild?.(p);
  writeBuild(p.root, between.build ?? BUILT);
  between.afterBuild?.(p);
  stages.freeze = freeze(p.root, { now: NOW });
  between.afterFreeze?.(p);
  stages.audit = audit(p.root, {
    evidenceDir: p.evidence, now: NOW,
    runner: cannedRunner({ application: answers.application ?? CLEAN, scanner: answers.scanner ?? CLEAN_SCANNER }),
    installScanner: fakeInstall,
  });
  between.afterAudit?.(p);
  stages.certify = certify(p.root, { now: NOW, env: ciEnv(p.root, env) });
  const candidateDir = join(p.root, 'release', '.work', 'candidate');
  return { ...p, stages, candidateDir, commit: git(p.root, 'rev-parse', 'HEAD') };
}

/** The candidate as the consumer receives it: every file, by relative path. */
export const candidateFiles = (dir) => walkTree(dir).files;

/** The GitHub API's answers for the certifying run and its listing (MODELLED). */
export function apiFacts(project, { run = {}, artifact = {}, workflowId = 77 } = {}) {
  const commit = project.commit;
  const tree = git(project.root, 'rev-parse', 'HEAD^{tree}');
  const list = (recursive) => git(project.root, 'ls-tree', ...(recursive ? ['-r', '-t'] : []), 'HEAD').split('\n').filter(Boolean).map((l) => {
    const [meta, path] = l.split('\t');
    const [, type, sha] = meta.split(' ');
    return { path, type, sha };
  });
  const runJson = { id: Number(RUN_ID), workflow_id: workflowId, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: commit, status: 'completed', conclusion: 'success', run_attempt: Number(RUN_ATTEMPT), ...run };
  const art = {
    id: 5550001, name: `admin-candidate-${runJson.id}-${runJson.run_attempt}`, size_in_bytes: 1234, expired: false,
    digest: `sha256:${'a'.repeat(64)}`, created_at: '2026-09-26T08:00:00Z', expires_at: '2026-12-25T08:00:00Z',
    workflow_run: { id: runJson.id, head_sha: commit }, ...artifact,
  };
  return {
    ciWorkflow: { id: workflowId },
    run: runJson,
    artifacts: { total_count: 1, artifacts: [art] },
    commit: { sha: commit, tree: { sha: tree } },
    tree: { sha: tree, truncated: false, tree: list(true) },
    topTree: { sha: tree, tree: list(false) },
  };
}

/** The TRUSTED side as the verifier loads it, from a (fixture) checkout. */
export function trustedOf(root, { mainTrees } = {}) {
  const read = (p) => readFileSync(join(root, p));
  const trees = { release: git(root, 'rev-parse', 'HEAD:release'), 'dependency-audit': git(root, 'rev-parse', 'HEAD:dependency-audit') };
  return {
    revision: git(root, 'rev-parse', 'HEAD'),
    trees,
    mainTrees: mainTrees ?? { ...trees },
    releasePolicyBytes: read('release/policy.json'),
    auditPolicy: JSON.parse(read('dependency-audit/policy.json')),
    auditPolicyBytes: read('dependency-audit/policy.json'),
    scannerManifest: read('dependency-audit/scanner/package.json'),
    scannerLock: read('dependency-audit/scanner/package-lock.json'),
  };
}

/** A clock that returns successive instants a second apart, from `start`. */
export function steppingClock(start = NOW) {
  let t = Date.parse(start);
  const clock = () => { const v = new Date(t).toISOString(); t += 1000; return v; };
  return clock;
}

export function tempDir(prefix = 'release-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Copy a candidate directory, optionally rewriting files, for tamper cases. */
export function copyCandidate(from, edit = () => {}) {
  const t = tempDir('candidate-');
  cpSync(from, t.dir, { recursive: true });
  edit(t.dir);
  return t;
}

/**
 * A certified project that has ALSO been through the fresh assessment, plus everything the
 * admission decision reads — the state `prepare` leaves behind. The assessment's scanner
 * answers are canned (SYNTHETIC); `at` is the evaluation's clock.
 */
export function evaluatedProject({ answers = {}, assessAnswers = {}, records = [], at = NOW, facts = {}, withVerifier = false } = {}) {
  const p = certifiedProject({ answers, records, withVerifier });
  const f = apiFacts(p, facts);
  const { policy } = loadReleasePolicy(p.root);
  const commit = commitFacts({ target: p.commit, commit: f.commit, tree: f.tree }).facts;
  const inspection = inspectCandidate(candidateFiles(p.candidateDir), { policy, commit: p.commit, tree: commit.tree, inputBlobs: commit.inputBlobs, runId: RUN_ID, runAttempt: RUN_ATTEMPT });
  const out = tempDir('assessment-');
  const replay = tempDir('replay-');
  const art = f.artifacts.artifacts[0];
  const { doc } = assess({
    trustedRoot: p.root, inspection,
    candidate: { commit: p.commit, runId: RUN_ID, runAttempt: RUN_ATTEMPT, artifactId: String(art.id), artifactDigest: art.digest },
    assessor: { workflowPath: policy.evaluation.workflowPath, runId: EVAL_RUN_ID, runAttempt: '1', revision: p.commit },
    outDir: out.dir, replayDir: replay.dir,
    runner: cannedRunner({ application: assessAnswers.application ?? CLEAN, scanner: assessAnswers.scanner ?? CLEAN_SCANNER }),
    clock: steppingClock(at), installScanner: fakeInstall,
  });
  const input = (over = {}) => ({
    policy, target: p.commit, mode: 'deploy', source: 'automatic', commit,
    certification: { ciWorkflow: f.ciWorkflow, run: f.run, artifacts: f.artifacts },
    candidateFiles: candidateFiles(p.candidateDir), assessmentFiles: walkTree(out.dir).files,
    trusted: trustedOf(p.root), evaluation: { runId: EVAL_RUN_ID, runAttempt: '1' },
    now: new Date(Date.parse(at) + 60_000).toISOString(),
    ...over,
  });
  return {
    ...p, facts: f, policy, commit: p.commit, commitFacts: commit, inspection, assessment: doc, assessmentDir: out.dir, input,
    cleanup: () => { out.cleanup(); replay.cleanup(); p.cleanup(); },
  };
}
