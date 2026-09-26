/**
 * CERTIFICATION — what `validate` checked, retained as ONE unit a deployment can consume.
 *
 * THE GUARANTEE THIS FILE SERVES: the payload a deployment promotes is the payload the
 * certifying `validate` run built and checked — not a rebuild that happens to carry the
 * same commit marker — and it travels with the dependency evidence that run produced,
 * bound to it by digest.
 *
 * PRODUCER (runs inside `validate`, in the job that built and checked the payload):
 *
 *   prebuild  before `npm run build:prod`. The output path must hold no file, link or
 *             other entry yet (a stale dist/ from anywhere else cannot be certified; an
 *             EMPTY directory, which carries no byte, is tolerated — see priorOutput), and
 *             the installed inventory must still be the audit snapshot taken after `npm ci`.
 *   freeze    after the mock-isolation gate. Records the tree digest of the output that
 *             gate scanned, and again proves the inventory has not moved.
 *   certify   after the dependency audit. Proves the output is still exactly the frozen
 *             tree, the inventory still the snapshot, the audit evidence THIS checkout's and
 *             passing (and reproducible offline from its own raw output), then writes the
 *             candidate: payload.tar.gz, evidence/ and certification.json.
 *
 * The chain prebuild → freeze → certify is recorded in release/.work/continuity.json and
 * each link re-checks the commit and the inventory, so evidence from another checkout, an
 * output built elsewhere, or a tree that moved between the gates cannot satisfy it.
 *
 * WHAT IS OBSERVED AND WHAT IS NOT: the inventory is a digest of installed package PATHS
 * AND VERSIONS as npm wrote them (dependency-audit/lib/npm.mjs), not of every executable
 * byte; the payload tree digest IS a digest of every served byte.
 *
 * CONSUMER (inspectCandidate): pure, over the candidate's files as a Map. It re-derives
 * everything the record claims — the archive, the tree, the evidence files, the audit
 * decision from the raw scanner output — and compares it with facts from OUTSIDE the
 * candidate (the commit as git or the API holds it, the run as the API reports it). A
 * candidate cannot vouch for itself.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { capture, gitRevision, loadPolicy, reevaluate, SNAPSHOT_SCHEMA, COLLECTION_SCHEMA, RESULT_SCHEMA, POLICY_SCHEMA } from '../../dependency-audit/lib/audit.mjs';
import { evaluate } from '../../dependency-audit/lib/core.mjs';
import { readReport, toolingScope } from '../../dependency-audit/lib/npm.mjs';
import { retainedInventory } from '../../dependency-audit/lib/retained.mjs';
import {
  DIGEST_RE, HEX_RE, ID_RE, SHA_RE, canonicalJson, digestOfValue, gitBlobSha1, isInstant, isObject, loadReleasePolicy,
  parseJson, reason, recordBytes, same,
} from './common.mjs';
import { readArchive, writeArchive } from './tar.mjs';
import { describeFiles, digestOf, sha256Hex, walkTree } from './tree.mjs';

export const CERTIFICATION_SCHEMA = 'dinify.admin.certification/1';
export const CONTINUITY_SCHEMA = 'dinify.admin.build-continuity/1';
export const WORK_DIR = 'release/.work';
export const CANDIDATE_DIR = `${WORK_DIR}/candidate`;
export const CONTINUITY_FILE = `${WORK_DIR}/continuity.json`;
export const AUDIT_EVIDENCE_DIR = 'dependency-audit/evidence';
export const RECORD = 'certification.json';
export const ARCHIVE = 'payload.tar.gz';
export const RELEASE_TXT = 'release.txt';
export const PASSING = Object.freeze(['within_policy', 'exceptions_only']);

/** The certified dependency INPUTS, by their repository path. Each is retained under evidence/inputs/. */
export const INPUTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'angular.json',
  'dependency-audit/scanner/package.json',
  'dependency-audit/scanner/package-lock.json',
]);
const RAW = Object.freeze(['application.scanner-stdout.txt', 'application.scanner-stderr.txt', 'scanner.scanner-stdout.txt', 'scanner.scanner-stderr.txt']);
const AUDIT_DOCS = Object.freeze(['snapshot.json', 'collection.json', 'result.json']);
const inputPath = (p) => `evidence/inputs/${p}`;
const auditPath = (p) => `evidence/audit/${p}`;

// ── producer ────────────────────────────────────────────────────────────────────

const readJsonFile = (path) => {
  const parsed = parseJson(readFileSync(path));
  return parsed.ok ? parsed.value : null;
};

function readAuditDoc(root, name, schema) {
  const path = join(root, AUDIT_EVIDENCE_DIR, name);
  if (!existsSync(path)) return { doc: null, problem: reason('audit_evidence_missing', `${AUDIT_EVIDENCE_DIR}/${name} does not exist`) };
  const doc = readJsonFile(path);
  if (!isObject(doc) || doc.schema !== schema) return { doc: null, problem: reason('audit_evidence_unreadable', `${AUDIT_EVIDENCE_DIR}/${name} is not a ${schema} document`) };
  return { doc, problem: null };
}

/**
 * The inventory right now, against the snapshot taken after `npm ci`. Anything that is
 * not exactly the same binding (revision, environment, lock, manifest, installed tree)
 * means the tree that was built or audited is not the one that was snapshotted.
 */
function inventoryStill(root, snapshot) {
  const { policy, problems } = loadPolicy(root);
  if (!policy) return problems;
  const cap = capture(root, { policy, revision: gitRevision(root) });
  const out = [...cap.problems];
  if (!same(cap.binding, snapshot.binding)) {
    out.push(reason('inventory_moved', 'the installed inventory, revision or environment is not the one the audit snapshot recorded after installation'));
  }
  return out;
}

function snapshotOf(root) {
  const { doc, problem } = readAuditDoc(root, 'snapshot.json', SNAPSHOT_SCHEMA);
  if (problem) return { snapshot: null, problems: [problem] };
  if (!Array.isArray(doc.problems) || doc.problems.length) return { snapshot: null, problems: [reason('snapshot_refused', 'the audit snapshot recorded problems of its own')] };
  return { snapshot: doc, problems: [] };
}

function readContinuity(root) {
  const path = join(root, CONTINUITY_FILE);
  if (!existsSync(path)) return null;
  const doc = readJsonFile(path);
  return isObject(doc) && doc.schema === CONTINUITY_SCHEMA ? doc : null;
}

const writeContinuity = (root, doc) => {
  mkdirSync(join(root, WORK_DIR), { recursive: true });
  writeFileSync(join(root, CONTINUITY_FILE), recordBytes(doc));
};

/**
 * What the output directory already holds before the build: every entry that is not a
 * directory (a file, a link, anything special), and every empty directory, by relative
 * path. An unreadable entry counts as held — it cannot be shown to be empty.
 *
 * EMPTY DIRECTORIES ARE TOLERATED, and that is the whole of the tolerance. The rule
 * exists so that no BYTE from anywhere else reaches the payload, and an empty directory
 * carries none. It matters in practice: the Karma builder (`test:ci`, which `validate`
 * runs before the build) writes to `dist/test-out/<uuid>/`, removes its own directory
 * and leaves `dist/test-out/` behind, empty. The production build then deletes the
 * output path, and the frozen tree is files only. A single file anywhere under the output
 * path is still refused.
 */
export function priorOutput(dir) {
  const entries = [];
  const emptyDirectories = [];
  if (!existsSync(dir)) return { entries, emptyDirectories };
  const visit = (full, rel) => {
    let st;
    try { st = lstatSync(full); } catch (error) { entries.push(`${rel || '.'} (unreadable: ${error.code ?? error.message})`); return; }
    if (!st.isDirectory()) { entries.push(rel || '.'); return; }
    let names;
    try { names = readdirSync(full).sort(); } catch (error) { entries.push(`${rel || '.'} (cannot be listed: ${error.code ?? error.message})`); return; }
    if (names.length === 0 && rel) emptyDirectories.push(rel);
    for (const name of names) visit(join(full, name), rel ? `${rel}/${name}` : name);
  };
  visit(dir, '');
  return { entries, emptyDirectories };
}

/** Step 1 of 3, before the build. */
export function prebuild(root, { now }) {
  const problems = [];
  const { policy, problems: pp } = loadReleasePolicy(root);
  problems.push(...pp);
  if (!policy) return { ok: false, problems };
  const prior = priorOutput(join(root, policy.build.outputPath));
  if (prior.entries.length) {
    problems.push(reason('stale_output', `${policy.build.outputPath}/ already holds ${prior.entries.slice(0, 5).join(', ')}${prior.entries.length > 5 ? ` and ${prior.entries.length - 5} more` : ''} before the build — output from anywhere else cannot be certified`));
  }
  if (existsSync(join(root, CONTINUITY_FILE)) || existsSync(join(root, CANDIDATE_DIR))) {
    problems.push(reason('stale_work', `${WORK_DIR}/ already holds a continuity record or a candidate`));
  }
  const { snapshot, problems: sp } = snapshotOf(root);
  problems.push(...sp);
  if (snapshot) problems.push(...inventoryStill(root, snapshot));
  if (problems.length) return { ok: false, problems };
  const rev = gitRevision(root);
  writeContinuity(root, { schema: CONTINUITY_SCHEMA, commit: rev.commit, tree: rev.tree, bindingDigest: digestOfValue(snapshot.binding), prebuildAt: now, emptyDirectoriesBeforeBuild: prior.emptyDirectories, frozen: null });
  return { ok: true, problems: [], emptyDirectories: prior.emptyDirectories };
}

function continuityChecks(root, stage) {
  const problems = [];
  const { policy, problems: pp } = loadReleasePolicy(root);
  problems.push(...pp);
  const cont = readContinuity(root);
  if (!cont) problems.push(reason('continuity_missing', `${CONTINUITY_FILE} was not written by prebuild in this job`));
  if (stage === 'certify' && cont && !isObject(cont.frozen)) problems.push(reason('continuity_missing', 'the output was never frozen after the mock-isolation gate'));
  const { snapshot, problems: sp } = snapshotOf(root);
  problems.push(...sp);
  const rev = gitRevision(root);
  if (cont && (!rev || rev.commit !== cont.commit || rev.tree !== cont.tree)) problems.push(reason('continuity_broken', 'the checkout is not the commit prebuild recorded'));
  if (cont && snapshot && digestOfValue(snapshot.binding) !== cont.bindingDigest) problems.push(reason('continuity_broken', 'the audit snapshot is not the one prebuild recorded'));
  if (snapshot) problems.push(...inventoryStill(root, snapshot));
  return { policy, cont, snapshot, rev, problems };
}

function builtTree(root, policy) {
  const out = join(root, policy.build.outputPath);
  const walked = walkTree(out);
  const problems = walked.problems.map((p) => reason('output_unusable', p));
  if (walked.files.has(RELEASE_TXT)) problems.push(reason('output_unusable', `${RELEASE_TXT} is reserved for the release identity; the build must not emit it`));
  if (!walked.files.get('index.html')?.length) problems.push(reason('output_unusable', 'index.html is missing or empty'));
  return { files: walked.files, problems };
}

/** Step 2 of 3, after the mock-isolation gate has scanned the output. */
export function freeze(root, { now }) {
  const { policy, cont, problems } = continuityChecks(root, 'freeze');
  if (policy) {
    const built = builtTree(root, policy);
    problems.push(...built.problems);
    if (cont && cont.frozen) problems.push(reason('continuity_broken', 'the output was already frozen once'));
    if (!problems.length) {
      const d = describeFiles(built.files);
      writeContinuity(root, { ...cont, frozen: { at: now, treeDigest: d.treeDigest, entryCount: d.entryCount } });
      return { ok: true, problems: [], treeDigest: d.treeDigest, entryCount: d.entryCount };
    }
  }
  return { ok: false, problems };
}

/** The workflow context the candidate is certified under, from the runner's own variables. */
export function workflowContext(env = process.env) {
  const problems = [];
  const workflowRef = String(env.GITHUB_WORKFLOW_REF ?? '');
  const m = workflowRef.match(/^[^/]+\/[^/]+\/(\.github\/workflows\/[A-Za-z0-9._-]+)@(.+)$/);
  const ctx = {
    repository: env.GITHUB_REPOSITORY ?? null,
    workflowPath: m ? m[1] : null,
    workflowRef: workflowRef || null,
    job: env.GITHUB_JOB ?? null,
    event: env.GITHUB_EVENT_NAME ?? null,
    ref: env.GITHUB_REF ?? null,
    sha: env.GITHUB_SHA ?? null,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
  };
  if (!ctx.repository || !ctx.workflowPath || !ctx.job || !ctx.event || !ctx.ref || !SHA_RE.test(String(ctx.sha))
      || !ID_RE.test(String(ctx.runId)) || !ID_RE.test(String(ctx.runAttempt))) {
    problems.push(reason('no_workflow_context', 'certification needs the GitHub Actions run context (repository, workflow, job, event, ref, sha, run id and attempt)'));
  }
  return { ctx, problems };
}

/** Step 3 of 3, after the dependency audit. Writes the candidate. */
export function certify(root, { now, env = process.env }) {
  const { policy, cont, snapshot, rev, problems } = continuityChecks(root, 'certify');
  const { ctx, problems: cp } = workflowContext(env);
  problems.push(...cp);
  if (!policy || !cont || !snapshot || !rev || problems.length) return { ok: false, problems };

  if (ctx.sha !== rev.commit) problems.push(reason('context_mismatch', `the run is for ${ctx.sha}, the checkout is ${rev.commit}`));
  if (ctx.repository !== policy.repository) problems.push(reason('context_mismatch', `the run is in ${ctx.repository}, the policy names ${policy.repository}`));
  if (ctx.workflowPath !== policy.certification.workflowPath || ctx.job !== policy.certification.job) {
    problems.push(reason('context_mismatch', `certification runs in ${policy.certification.workflowPath}/${policy.certification.job}, this is ${ctx.workflowPath}/${ctx.job}`));
  }

  // The output is still exactly what the mock-isolation gate scanned.
  const built = builtTree(root, policy);
  problems.push(...built.problems);
  if (!built.problems.length) {
    const d = describeFiles(built.files);
    if (d.treeDigest !== cont.frozen.treeDigest) problems.push(reason('output_moved', `the output is ${d.treeDigest}, the mock-isolation gate scanned ${cont.frozen.treeDigest}`));
  }

  // The audit evidence is THIS checkout's, passing, and reproducible from its raw output.
  const collection = readAuditDoc(root, 'collection.json', COLLECTION_SCHEMA);
  const result = readAuditDoc(root, 'result.json', RESULT_SCHEMA);
  for (const r of [collection, result]) if (r.problem) problems.push(r.problem);
  const auditPolicyBytes = readFileSync(join(root, 'dependency-audit', 'policy.json'));
  if (collection.doc && !same(collection.doc.binding, snapshot.binding)) problems.push(reason('audit_not_bound', 'the scan is not bound to the snapshot this build used'));
  if (result.doc && (!PASSING.includes(result.doc.outcome) || result.doc.exitCode !== 0)) {
    problems.push(reason('audit_not_passing', `the dependency audit concluded ${result.doc.outcome} (exit ${result.doc.exitCode}); no candidate is produced`));
  }
  for (const raw of RAW) if (!existsSync(join(root, AUDIT_EVIDENCE_DIR, raw))) problems.push(reason('audit_evidence_missing', `${raw} was not retained`));
  let reeval = null;
  if (!problems.length) {
    reeval = reevaluate(root, { evidenceDir: join(root, AUDIT_EVIDENCE_DIR), now });
    if (reeval.outcome !== result.doc.outcome || !same(reeval.counts, result.doc.counts)) {
      problems.push(reason('audit_unreproducible', `re-evaluating the retained raw output gives ${reeval.outcome}, the result says ${result.doc.outcome}`));
    }
  }
  if (existsSync(join(root, CANDIDATE_DIR))) problems.push(reason('stale_work', `${CANDIDATE_DIR} already exists`));
  if (problems.length) return { ok: false, problems };

  // The payload: the checked output plus the served release identity.
  const payload = new Map(built.files);
  payload.set(RELEASE_TXT, Buffer.from(`${rev.commit}\n`, 'utf8'));
  const archive = writeArchive(payload);
  const described = describeFiles(payload);

  // The evidence, beside the payload and never inside it.
  const evidence = new Map();
  for (const p of INPUTS) evidence.set(inputPath(p), readFileSync(join(root, p)));
  evidence.set(auditPath('policy.json'), auditPolicyBytes);
  for (const name of [...AUDIT_DOCS, ...RAW]) evidence.set(auditPath(name), readFileSync(join(root, AUDIT_EVIDENCE_DIR, name)));
  const app = snapshot.binding.application;
  if (sha256Hex(evidence.get(inputPath('package.json'))) !== app.manifestSha256 || sha256Hex(evidence.get(inputPath('package-lock.json'))) !== app.lockfileSha256) {
    return { ok: false, problems: [reason('inputs_moved', 'package.json or package-lock.json is not what the snapshot recorded')] };
  }
  const scannerGraph = collection.doc.graphs?.scanner;
  const described_e = describeFiles(evidence);

  const record = {
    schema: CERTIFICATION_SCHEMA,
    repository: ctx.repository,
    commit: rev.commit,
    tree: rev.tree,
    workflow: {
      path: ctx.workflowPath, ref: ctx.workflowRef, job: ctx.job, event: ctx.event, gitRef: ctx.ref,
      runId: String(ctx.runId), runAttempt: String(ctx.runAttempt),
    },
    build: {
      configuration: policy.build.configuration,
      command: policy.build.command,
      outputPath: policy.build.outputPath,
      environment: snapshot.binding.environment,
    },
    inputs: INPUTS.map((p) => {
      const bytes = evidence.get(inputPath(p));
      return { path: p, retained: inputPath(p), sha256: sha256Hex(bytes), gitBlob: gitBlobSha1(bytes) };
    }),
    inventory: {
      observation: 'installed-tree-paths-and-versions',
      observedAt: snapshot.capturedAt,
      locked: app.locked,
      installed: app.installed,
      lockfileSha256: app.lockfileSha256,
      manifestSha256: app.manifestSha256,
      installedTreeSha256: app.installedTreeSha256,
      packagesDigest: digestOfValue(snapshot.packages),
    },
    scanner: {
      package: collection.doc.scanner?.package ?? null,
      version: collection.doc.scanner?.pinned ?? null,
      manifestSha256: scannerGraph?.digests?.manifestSha256 ?? null,
      lockfileSha256: scannerGraph?.digests?.lockfileSha256 ?? null,
      installedTreeSha256: scannerGraph?.digests?.installedTreeSha256 ?? null,
    },
    audit: {
      policySha256: sha256Hex(auditPolicyBytes),
      invokedAt: collection.doc.startedAt,
      outcome: result.doc.outcome,
      exitCode: result.doc.exitCode,
      counts: result.doc.counts,
      reevaluatedAt: reeval.decidedAt,
      reevaluatedOutcome: reeval.outcome,
    },
    continuity: { prebuildAt: cont.prebuildAt, frozenAt: cont.frozen.at, frozenTreeDigest: cont.frozen.treeDigest, certifiedAt: now },
    payload: {
      treeDigest: described.treeDigest,
      entryCount: described.entryCount,
      bytes: described.bytes,
      indexSha256: sha256Hex(payload.get('index.html')),
      release: { path: RELEASE_TXT, commit: rev.commit },
      entries: described.entries,
      archive: { path: ARCHIVE, sha256: sha256Hex(archive), bytes: archive.length },
    },
    evidence: { treeDigest: described_e.treeDigest, files: described_e.entries },
  };

  const dir = join(root, CANDIDATE_DIR);
  for (const [path, bytes] of evidence) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  writeFileSync(join(dir, ARCHIVE), archive);
  const bytes = recordBytes(record);
  writeFileSync(join(dir, RECORD), bytes);
  return { ok: true, problems: [], record, recordDigest: digestOf(bytes), dir };
}

// ── consumer ──────────────────────────────────────────────────────────────────

/** Shape only; whether the record is TRUE is inspectCandidate's question. */
export function validateRecord(r) {
  const out = [];
  const p = (detail) => out.push(reason('certification_invalid', detail));
  if (!isObject(r)) return [reason('certification_invalid', 'not an object')];
  if (r.schema !== CERTIFICATION_SCHEMA) p(`schema ${String(r.schema)}`);
  if (typeof r.repository !== 'string') p('repository');
  if (!SHA_RE.test(String(r.commit)) || !SHA_RE.test(String(r.tree))) p('commit or tree');
  const w = r.workflow;
  if (!isObject(w) || typeof w.path !== 'string' || typeof w.job !== 'string' || typeof w.event !== 'string' || typeof w.gitRef !== 'string'
      || !ID_RE.test(String(w.runId)) || !ID_RE.test(String(w.runAttempt))) p('workflow');
  const b = r.build;
  if (!isObject(b) || typeof b.configuration !== 'string' || typeof b.command !== 'string' || !isObject(b.environment) || typeof b.environment.node !== 'string') p('build');
  if (!Array.isArray(r.inputs) || r.inputs.length !== INPUTS.length) p('inputs');
  else r.inputs.forEach((i, n) => {
    if (!isObject(i) || i.path !== INPUTS[n] || i.retained !== inputPath(INPUTS[n]) || !HEX_RE.test(String(i.sha256)) || !/^[0-9a-f]{40}$/.test(String(i.gitBlob))) p(`input ${INPUTS[n]}`);
  });
  const v = r.inventory;
  if (!isObject(v) || !Number.isInteger(v.locked) || !Number.isInteger(v.installed) || !HEX_RE.test(String(v.installedTreeSha256)) || !DIGEST_RE.test(String(v.packagesDigest)) || !isInstant(v.observedAt)) p('inventory');
  const s = r.scanner;
  if (!isObject(s) || s.package !== 'npm' || !/^\d+\.\d+\.\d+$/.test(String(s.version)) || !HEX_RE.test(String(s.lockfileSha256))) p('scanner');
  const a = r.audit;
  if (!isObject(a) || typeof a.outcome !== 'string' || !Number.isInteger(a.exitCode) || !isInstant(a.invokedAt) || !HEX_RE.test(String(a.policySha256))) p('audit');
  const c = r.continuity;
  if (!isObject(c) || !isInstant(c.prebuildAt) || !isInstant(c.frozenAt) || !isInstant(c.certifiedAt) || !DIGEST_RE.test(String(c.frozenTreeDigest))) p('continuity');
  const pl = r.payload;
  if (!isObject(pl) || !DIGEST_RE.test(String(pl.treeDigest)) || !Number.isInteger(pl.entryCount) || !HEX_RE.test(String(pl.indexSha256))
      || !isObject(pl.release) || pl.release.path !== RELEASE_TXT || !Array.isArray(pl.entries)
      || !isObject(pl.archive) || pl.archive.path !== ARCHIVE || !HEX_RE.test(String(pl.archive.sha256)) || !Number.isInteger(pl.archive.bytes)) p('payload');
  if (!isObject(r.evidence) || !DIGEST_RE.test(String(r.evidence.treeDigest)) || !Array.isArray(r.evidence.files)) p('evidence');
  return out;
}

/**
 * A lock-graph inventory with NO installed observation, for re-reading a TOOLING graph's
 * report (the scanner). It is never presented as evidence of what was installed.
 */
export function lockOnlyInventory(graph, manifestBytes, lockBytes) {
  let lock;
  try { lock = JSON.parse(lockBytes); JSON.parse(manifestBytes); } catch (error) {
    return { packages: [], problems: [reason('unreadable_manifest', `${graph}: ${error.message}`)], digests: {}, counts: {} };
  }
  if (!isObject(lock?.packages)) return { packages: [], problems: [reason('lockfile_version', `${graph}: no packages map`)], digests: {}, counts: {} };
  const packages = Object.entries(lock.packages).filter(([path]) => path !== '')
    .map(([path, entry]) => ({ path: `${graph}:${path}`, name: entry?.name ?? path.slice(path.lastIndexOf('node_modules/') + 13), version: entry?.version ?? null, scope: toolingScope(entry) }));
  return { packages, problems: [], digests: { lockfileSha256: sha256Hex(lockBytes), manifestSha256: sha256Hex(manifestBytes) }, counts: { locked: packages.length } };
}

/**
 * Inspect a downloaded candidate against facts from outside it.
 *
 * @param {Map<string, Buffer>} files  every file of the candidate, by relative path
 * @param {object} expect
 * @param {object} expect.policy       the TRUSTED release policy
 * @param {string} expect.commit       the target commit
 * @param {string} expect.tree         that commit's tree, as git or the API holds it
 * @param {object} expect.inputBlobs   {path: git blob id} of the INPUTS at that commit
 * @param {string} expect.runId        the certifying run the API reports
 * @param {string} expect.runAttempt   its attempt
 * @returns facts; `problems` empty means the candidate is what it claims to be
 */
export function inspectCandidate(files, expect) {
  const out = { problems: [], record: null, recordDigest: null, payload: null, retained: null, audit: null };
  const problem = (code, detail) => out.problems.push(reason(code, detail));
  if (!(files instanceof Map) || files.size === 0) { problem('candidate_missing', 'no candidate files'); return out; }
  const recordBytesIn = files.get(RECORD);
  if (!recordBytesIn) { problem('candidate_invalid', `${RECORD} is missing`); return out; }
  out.recordDigest = digestOf(recordBytesIn);
  const parsed = parseJson(recordBytesIn);
  if (!parsed.ok) { problem('candidate_invalid', `${RECORD}: ${parsed.detail}`); return out; }
  const r = parsed.value;
  out.record = r;
  out.problems.push(...validateRecord(r));
  if (out.problems.length) return out;

  // Exactly these files: the record, the archive, and every listed evidence file.
  const listed = new Map(r.evidence.files.map((f) => [`evidence/${f.path.replace(/^evidence\//, '')}`, f]));
  for (const [path, bytes] of files) {
    if (path === RECORD || path === ARCHIVE) continue;
    const entry = listed.get(path);
    if (!entry) { problem('candidate_unexpected_file', path); continue; }
    if (sha256Hex(bytes) !== entry.sha256 || bytes.length !== entry.bytes) problem('candidate_altered', path);
  }
  for (const path of listed.keys()) if (!files.has(path)) problem('candidate_file_missing', path);
  if (!files.has(ARCHIVE)) problem('candidate_file_missing', ARCHIVE);
  if (out.problems.length) return out;
  const evidence = new Map([...files].filter(([p]) => p.startsWith('evidence/')));
  if (describeFiles(evidence).treeDigest !== r.evidence.treeDigest) problem('candidate_altered', 'the evidence tree digest is not the recorded one');

  // The payload: the archive is the recorded bytes, canonical, and the recorded tree.
  const archive = files.get(ARCHIVE);
  if (sha256Hex(archive) !== r.payload.archive.sha256 || archive.length !== r.payload.archive.bytes) problem('payload_altered', 'payload.tar.gz is not the recorded archive');
  const read = readArchive(archive);
  for (const p of read.problems) problem('payload_invalid', p);
  if (out.problems.length) return out;
  const d = describeFiles(read.files);
  if (d.treeDigest !== r.payload.treeDigest || !same(d.entries, r.payload.entries) || d.entryCount !== r.payload.entryCount) {
    problem('payload_altered', `the archive holds ${d.treeDigest}, the record names ${r.payload.treeDigest}`);
  }
  const release = read.files.get(RELEASE_TXT);
  if (!release || release.toString('utf8') !== `${r.commit}\n` || r.payload.release.commit !== r.commit) problem('payload_invalid', `${RELEASE_TXT} does not attest ${r.commit}`);
  const index = read.files.get('index.html');
  if (!index?.length || sha256Hex(index) !== r.payload.indexSha256) problem('payload_invalid', 'index.html is missing, empty or not the recorded one');
  // The frozen tree (what the mock-isolation gate scanned) is the payload minus release.txt.
  const built = new Map([...read.files].filter(([p]) => p !== RELEASE_TXT));
  if (built.size && describeFiles(built).treeDigest !== r.continuity.frozenTreeDigest) problem('payload_altered', 'the payload is not the output the mock-isolation gate scanned');
  out.payload = { files: read.files, treeDigest: d.treeDigest, entryCount: d.entryCount, entries: d.entries, archiveSha256: sha256Hex(archive), archiveBytes: archive.length, indexSha256: r.payload.indexSha256 };

  // Facts from OUTSIDE the candidate.
  const { policy } = expect;
  const want = (code, ok, detail) => { if (!ok) problem(code, detail); };
  want('wrong_repository', r.repository === policy.repository, `${r.repository} != ${policy.repository}`);
  want('wrong_commit', r.commit === expect.commit, `${r.commit} != ${expect.commit}`);
  want('wrong_tree', r.tree === expect.tree, `${r.tree} != ${expect.tree}`);
  want('wrong_workflow', r.workflow.path === policy.certification.workflowPath && r.workflow.job === policy.certification.job, `${r.workflow.path}/${r.workflow.job}`);
  want('wrong_event', r.workflow.event === policy.certification.event && r.workflow.gitRef === policy.certification.ref,
    `certified on ${r.workflow.event} ${r.workflow.gitRef}; only ${policy.certification.event} to ${policy.certification.ref} certifies a production candidate`);
  want('wrong_run', r.workflow.runId === String(expect.runId), `certified by run ${r.workflow.runId}, the selected run is ${expect.runId}`);
  want('wrong_attempt', r.workflow.runAttempt === String(expect.runAttempt), `certified by attempt ${r.workflow.runAttempt}, the selected attempt is ${expect.runAttempt}`);
  want('wrong_configuration', r.build.configuration === policy.build.configuration && r.build.command === policy.build.command, `${r.build.configuration} via ${r.build.command}`);
  want('wrong_environment', String(r.build.environment.node).replace(/^v/, '').split('.')[0] === String(policy.build.nodeMajor), `built on Node ${r.build.environment.node}`);
  for (const i of r.inputs) {
    const bytes = files.get(i.retained);
    const blob = gitBlobSha1(bytes);
    want('wrong_inputs', blob === i.gitBlob && sha256Hex(bytes) === i.sha256 && blob === expect.inputBlobs?.[i.path],
      `${i.path}: retained ${blob}, the commit holds ${String(expect.inputBlobs?.[i.path])}`);
  }
  if (out.problems.length) return out;

  // The evidence documents agree with each other and with the record.
  const doc = (name, schema) => {
    const pj = parseJson(files.get(auditPath(name)));
    if (!pj.ok || !isObject(pj.value) || pj.value.schema !== schema) { problem('evidence_invalid', `${name} is not a ${schema} document`); return null; }
    return pj.value;
  };
  const snapshot = doc('snapshot.json', SNAPSHOT_SCHEMA);
  const collection = doc('collection.json', COLLECTION_SCHEMA);
  const result = doc('result.json', RESULT_SCHEMA);
  const auditPolicy = doc('policy.json', POLICY_SCHEMA);
  if (!snapshot || !collection || !result || !auditPolicy) return out;
  if (sha256Hex(files.get(auditPath('policy.json'))) !== r.audit.policySha256) problem('evidence_invalid', 'the retained audit policy is not the recorded one');
  if (!Array.isArray(snapshot.problems) || snapshot.problems.length) problem('evidence_invalid', 'the snapshot recorded problems');
  if (!same(snapshot.binding, collection.binding)) problem('evidence_inconsistent', 'the scan is not bound to the snapshot');
  if (snapshot.binding?.revision?.commit !== r.commit || snapshot.binding?.revision?.tree !== r.tree) problem('evidence_inconsistent', 'the snapshot was taken at another commit');
  if (!same(snapshot.binding?.environment, r.build.environment)) problem('evidence_inconsistent', 'the build environment is not the snapshot environment');
  const app = snapshot.binding?.application ?? {};
  const inputSha = (p) => r.inputs.find((i) => i.path === p).sha256;
  if (app.manifestSha256 !== inputSha('package.json') || app.lockfileSha256 !== inputSha('package-lock.json')) problem('evidence_inconsistent', 'the retained inputs are not the files the snapshot was taken over');
  if (app.installedTreeSha256 !== r.inventory.installedTreeSha256 || app.locked !== r.inventory.locked || app.installed !== r.inventory.installed
      || digestOfValue(snapshot.packages) !== r.inventory.packagesDigest) problem('evidence_inconsistent', 'the record inventory is not the snapshot inventory');
  const sg = collection.graphs?.scanner;
  if (!isObject(sg) || sg.digests?.lockfileSha256 !== inputSha('dependency-audit/scanner/package-lock.json')
      || sg.digests?.manifestSha256 !== inputSha('dependency-audit/scanner/package.json') || collection.scanner?.pinned !== r.scanner.version) {
    problem('evidence_inconsistent', 'the retained scanner inputs are not the ones the scan recorded');
  }
  if (result.outcome !== r.audit.outcome || result.exitCode !== r.audit.exitCode || !same(result.counts, r.audit.counts)) problem('evidence_inconsistent', 'the record audit is not the retained result');
  if (out.problems.length) return out;

  // REPRODUCE the certification decision from the raw output and the retained inventory.
  const manifestBytes = files.get(inputPath('package.json'));
  const lockBytes = files.get(inputPath('package-lock.json'));
  const appInv = retainedInventory({ graph: 'application', manifestBytes, lockBytes, snapshot });
  const scannerInv = lockOnlyInventory('scanner', files.get(inputPath('dependency-audit/scanner/package.json')), files.get(inputPath('dependency-audit/scanner/package-lock.json')));
  const incomplete = [...appInv.problems, ...scannerInv.problems];
  const findings = [];
  for (const [graph, inv] of [['application', appInv], ['scanner', scannerInv]]) {
    const run = collection.graphs?.[graph]?.run;
    const stdout = files.get(auditPath(`${graph}.scanner-stdout.txt`));
    if (!isObject(run) || !stdout || sha256Hex(stdout) !== run.stdoutSha256) {
      problem('evidence_raw_mismatch', `${graph}: the raw scanner output is not the bytes the collection recorded`);
      continue;
    }
    const rr = readReport({ graph, run: { ...run, stdout: stdout.toString('utf8') }, inv });
    incomplete.push(...rr.problems);
    findings.push(...rr.findings);
  }
  if (out.problems.length) return out;
  const reproduced = evaluate({ incomplete, findings, records: Array.isArray(auditPolicy.records) ? auditPolicy.records : [], now: result.decidedAt });
  out.audit = { outcome: reproduced.outcome, counts: reproduced.counts };
  if (reproduced.outcome !== result.outcome || !same(reproduced.counts, result.counts)) {
    problem('evidence_unreproducible', `the raw output reads as ${reproduced.outcome} ${canonicalJson(reproduced.counts)}, the result says ${result.outcome}`);
  }
  if (!PASSING.includes(result.outcome) || !PASSING.includes(reproduced.outcome) || !PASSING.includes(r.audit.reevaluatedOutcome)) {
    problem('evidence_not_passing', `the certification audit concluded ${result.outcome}`);
  }
  out.retained = { manifestBytes, lockBytes, snapshot };
  return out;
}
