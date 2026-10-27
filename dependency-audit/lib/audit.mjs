/**
 * THE ORCHESTRATION: snapshot the validated inventory, scan THAT inventory with the pinned
 * scanner, prove nothing moved while it was scanned, and decide.
 *
 * Three commands, three different claims:
 *
 *   snapshot  — offline. Records exactly what `npm ci` installed (lock graph, installed
 *               tree, environment, revision) right after installation, before any
 *               repository code has run. Fails if the installed tree is not the lock graph.
 *   audit     — network. Refuses to scan anything but the snapshotted inventory, installs
 *               the pinned scanner from its own lockfile, scans the application graph AND
 *               the scanner's own graph, re-checks the inventory before and after each
 *               scan, and writes the complete raw scanner output beside the decision.
 *   evaluate  — offline. Re-reads retained evidence, verifies the raw output is the bytes
 *               that were recorded and that the evidence belongs to THIS checkout, and
 *               decides again. Evidence for another revision, lockfile or environment is
 *               refused, not reused.
 *
 * THE BASE AND THE CLOCK (CI-signal A-2). `audit` may be given a BASE: the commit the change
 * under audit was made on (a pull request's base, a push's `before`). Both lock graphs are
 * read from it with `git show`, every finding is given its provenance against them
 * (npm.mjs), and for the advisories of those findings the date each became reportable is
 * asked of GitHub (advisories.mjs) — after the scanner has run, in this code. The base
 * commit, both base lock digests and the advisory record's digest go into the collection,
 * so `evaluate` re-derives the base from git and re-reads the dates from the retained
 * record, and never fetches. There is no flag that supplies a date or a provenance; a
 * base that is absent, all zeros, not in this clone or not an ancestor of HEAD is no base,
 * and the audit then decides exactly as it did before A-2.
 *
 * The scanner runner is a parameter so the regression matrix can drive every failure
 * mode deterministically. The CLI passes the real one; there is no flag, environment
 * variable or policy field that substitutes another scanner.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { ADVISORIES_FILE, advisoryIds, applyDates, buildAdvisoryEvidence, fetchAdvisories, readAdvisoryEvidence } from './advisories.mjs';
import { evaluate, headline } from './core.mjs';
import { environmentFacts, inventory, lockEntries, readReport, scannerArgs, scannerEnvironment, sha256, toolingScope } from './npm.mjs';

export const SNAPSHOT_SCHEMA = 'dinify.dependency-audit.snapshot/v1';
export const COLLECTION_SCHEMA = 'dinify.dependency-audit.collection/v1';
export const RESULT_SCHEMA = 'dinify.dependency-audit.result/v1';
export const POLICY_SCHEMA = 'dinify.dependency-audit.policy/v1';
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

const POLICY_KEYS = ['schema', 'repository', 'ecosystem', 'target', 'scanner', 'records'];
const SCANNER_KEYS = ['package', 'version', 'root', 'registry', 'timeoutSeconds'];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * One retained evidence document, or the reason it is not one. JSON that parses is not yet
 * evidence: `null`, `0`, `""`, `false` and a list all parse, and a caller that read "falsy"
 * as "nothing to check" skipped every binding and graph check — so an evidence directory
 * holding `null` re-decided to within policy, exit 0 (Codex review on
 * mugak1/Dinify-Backend#339). Only a JSON object carrying the expected schema is returned;
 * everything else comes back as a problem, so an absent document always has a named reason.
 */
function readEvidence(path, schema) {
  let doc;
  try { doc = readJson(path); } catch (error) { return { doc: null, problem: `${basename(path)}: ${error.message}` }; }
  if (!isMapping(doc)) return { doc: null, problem: `${basename(path)} is not a JSON object` };
  if (doc.schema !== schema) return { doc: null, problem: `${basename(path)}: schema is not recognised` };
  return { doc, problem: null };
}

/** A snapshot records its own problems as a list; anything else is a malformed snapshot. */
const snapshotProblemsReadable = (snap) => Array.isArray(snap.problems) && snap.problems.every(isMapping);

/**
 * The committed policy, validated. Returns {policy, problems}.
 *
 * `policy` is null whenever ANY problem was recorded, not only when the file will not
 * parse. Every caller guards on a truthy policy and then dereferences `target`, `scanner`
 * and `records`, so handing back an object that failed validation turns a named
 * `policy_invalid` into an uncaught TypeError — an audit that crashes instead of
 * reporting itself incomplete. An invalid policy is no policy: the problems carry the
 * explanation, and the outcome is `incomplete` (exit 2) on every path.
 */
export function loadPolicy(root) {
  const path = join(root, 'dependency-audit', 'policy.json');
  const problems = [];
  let policy;
  try { policy = readJson(path); } catch (error) {
    return { policy: null, problems: [{ code: 'policy_unreadable', detail: `dependency-audit/policy.json: ${error.message}` }] };
  }
  const p = (detail) => problems.push({ code: 'policy_invalid', detail });
  if (!policy || typeof policy !== 'object') return { policy: null, problems: [{ code: 'policy_invalid', detail: 'the policy is not an object' }] };
  for (const key of Object.keys(policy)) if (!POLICY_KEYS.includes(key)) p(`unknown policy field "${key}"`);
  if (policy.schema !== POLICY_SCHEMA) p(`schema is not ${POLICY_SCHEMA}`);
  if (policy.ecosystem !== 'npm') p('ecosystem is not npm');
  if (typeof policy.repository !== 'string' || !/^mugak1\/[A-Za-z0-9._-]+$/.test(policy.repository)) p('repository is not a mugak1 repository');
  if (!policy.target || !Number.isInteger(policy.target.nodeMajor)) p('target.nodeMajor must be an integer');
  const s = policy.scanner;
  if (!s || typeof s !== 'object') p('scanner is missing');
  else {
    for (const key of Object.keys(s)) if (!SCANNER_KEYS.includes(key)) p(`unknown scanner field "${key}"`);
    if (s.package !== 'npm') p('scanner.package must be npm');
    if (!/^\d+\.\d+\.\d+$/.test(String(s.version))) p('scanner.version must be one exact version');
    if (s.root !== 'dependency-audit/scanner') p('scanner.root must be dependency-audit/scanner');
    if (s.registry !== PUBLIC_REGISTRY) p(`scanner.registry must be ${PUBLIC_REGISTRY}`);
    if (!Number.isInteger(s.timeoutSeconds) || s.timeoutSeconds < 30 || s.timeoutSeconds > 900) p('scanner.timeoutSeconds must be 30..900');
  }
  if (!Array.isArray(policy.records)) p('records must be a list (it may be empty)');
  return { policy: problems.length ? null : policy, problems };
}

/** The real process runner. Output is captured whole; nothing is piped through a formatter. */
export function spawnRunner({ command, args, cwd, env, timeoutMs }) {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
  return {
    command, args, cwd,
    status: r.status,
    signal: r.signal,
    timedOut: r.error?.code === 'ETIMEDOUT',
    error: r.error && r.error.code !== 'ETIMEDOUT' ? `${r.error.code ?? ''} ${r.error.message}`.trim() : null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    durationMs: Date.now() - started,
  };
}

/** Always the real git: the revision is a fact about the checkout, never a test double's opinion. */
export function gitRevision(root, runner = spawnRunner) {
  const commit = runner({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: root, env: process.env, timeoutMs: 30000 });
  const tree = runner({ command: 'git', args: ['rev-parse', 'HEAD^{tree}'], cwd: root, env: process.env, timeoutMs: 30000 });
  if (commit.status !== 0 || tree.status !== 0) return null;
  return { commit: commit.stdout.trim(), tree: tree.stdout.trim() };
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * A requested base, normalised: the commit, or null for NO base. Empty and all zeros (a
 * push that created a branch) are no base. Anything else that is not a full lower-case
 * commit id is not a base either — the caller refuses it as a usage error rather than
 * guessing what was meant.
 */
export function requestedBase(value) {
  if (value === undefined || value === null || value === '' || /^0{40}$/.test(String(value))) return { commit: null, valid: true };
  return SHA_RE.test(String(value)) ? { commit: String(value), valid: true } : { commit: null, valid: false };
}

/** Where each graph's lockfile lives in a commit. */
const baseLockPaths = (policy) => ({ application: 'package-lock.json', scanner: `${policy.scanner.root}/package-lock.json` });

/**
 * The base, read from git: the record the collection keeps, and per graph the lock entries
 * provenance is decided against. Always the real git, like gitRevision.
 *
 *   state 'applied'      the commit is in this clone and an ancestor of HEAD; per graph
 *                        `present` (its lockfile, digest recorded), `absent` (the commit
 *                        has no lockfile there: everything in the graph is introduced) or
 *                        `unreadable` (no provenance for that graph);
 *   state 'unavailable'  not in this clone, or not an ancestor (a force push): NO base.
 */
export function resolveBase(root, commit, policy, runner = spawnRunner) {
  const git = (args) => runner({ command: 'git', args, cwd: root, env: process.env, timeoutMs: 60000 });
  const unavailable = (reason) => ({ record: { commit, state: 'unavailable', reason }, bases: {} });
  if (git(['cat-file', '-e', `${commit}^{commit}`]).status !== 0) return unavailable('the base commit is not in this clone');
  if (git(['merge-base', '--is-ancestor', commit, 'HEAD']).status !== 0) return unavailable('the base commit is not an ancestor of HEAD');
  const record = { commit, state: 'applied', graphs: {} };
  const bases = {};
  for (const [graph, path] of Object.entries(baseLockPaths(policy))) {
    if (git(['cat-file', '-e', `${commit}:${path}`]).status !== 0) {
      record.graphs[graph] = { path, state: 'absent', lockfileSha256: null };
      bases[graph] = new Map();
      continue;
    }
    const shown = git(['show', `${commit}:${path}`]);
    const entries = shown.status === 0 ? lockEntries(shown.stdout) : null;
    record.graphs[graph] = { path, state: entries ? 'present' : 'unreadable', lockfileSha256: shown.status === 0 ? sha256(shown.stdout) : null };
    if (entries) bases[graph] = entries;
  }
  return { record, bases };
}

/** Two base records name the same base, read the same way. */
function baseDifferences(recorded, again) {
  const out = [];
  const fields = (r) => JSON.stringify([r?.commit, r?.state, ...['application', 'scanner'].map((g) => [r?.graphs?.[g]?.path, r?.graphs?.[g]?.state, r?.graphs?.[g]?.lockfileSha256])]);
  if (fields(recorded) !== fields(again)) out.push(`recorded ${fields(recorded)}, re-derived ${fields(again)}`);
  return out;
}

/** Everything a scan is bound to. Two captures are the same inventory iff these are equal. */
export function capture(root, { policy, env = environmentFacts(), revision }) {
  const inv = inventory(root, { graph: 'application', env });
  const problems = [...inv.problems];
  const major = Number(String(env.node).replace(/^v/, '').split('.')[0]);
  if (policy && major !== policy.target.nodeMajor) {
    problems.push({ code: 'target_mismatch', detail: `Node ${env.node} is not the validation target (Node ${policy.target.nodeMajor}); this environment is not the one CI validates` });
  }
  return {
    inv,
    problems,
    binding: {
      repository: policy?.repository ?? null,
      revision: revision ?? null,
      environment: env,
      application: { ...inv.digests, locked: inv.counts.locked, installed: inv.counts.installed },
    },
  };
}

function bindingDifferences(a, b) {
  const out = [];
  if (!a || !b) return ['no binding recorded'];
  if (a.repository !== b.repository) out.push(`repository ${a.repository} ≠ ${b.repository}`);
  if (canonical(a.revision) !== canonical(b.revision)) out.push(`revision ${a.revision?.commit ?? 'none'} ≠ ${b.revision?.commit ?? 'none'}`);
  if (canonical(a.environment) !== canonical(b.environment)) out.push(`environment ${canonical(a.environment)} ≠ ${canonical(b.environment)}`);
  for (const k of ['lockfileSha256', 'manifestSha256', 'installedTreeSha256', 'locked', 'installed']) {
    if (a.application?.[k] !== b.application?.[k]) out.push(`application ${k} ${a.application?.[k]} ≠ ${b.application?.[k]}`);
  }
  return out;
}

export function snapshot(root, { evidenceDir, now, env } = {}) {
  mkdirSync(evidenceDir, { recursive: true });
  const { policy, problems: policyProblems } = loadPolicy(root);
  const cap = capture(root, { policy, env, revision: gitRevision(root) });
  const problems = [...policyProblems, ...cap.problems];
  const doc = { schema: SNAPSHOT_SCHEMA, capturedAt: now, binding: cap.binding, problems, packages: cap.inv.packages };
  writeJson(join(evidenceDir, 'snapshot.json'), doc);
  return { ok: problems.length === 0, problems, doc };
}

function recordRun(evidenceDir, graph, run) {
  const stdoutFile = `${graph}.scanner-stdout.txt`;
  const stderrFile = `${graph}.scanner-stderr.txt`;
  writeFileSync(join(evidenceDir, stdoutFile), run.stdout ?? '');
  writeFileSync(join(evidenceDir, stderrFile), run.stderr ?? '');
  return {
    argv: [run.command, ...(run.args ?? [])],
    cwd: run.cwd,
    status: run.status,
    signal: run.signal,
    timedOut: run.timedOut,
    error: run.error,
    durationMs: run.durationMs,
    stdoutFile, stdoutSha256: sha256(run.stdout ?? ''), stdoutBytes: Buffer.byteLength(run.stdout ?? ''),
    stderrFile, stderrSha256: sha256(run.stderr ?? ''),
  };
}

/**
 * Scan and decide. Returns the result document; the caller maps result.exitCode.
 * @param {object} deps  runner, installScanner (tests replace the network-facing parts)
 */
export function audit(root, { evidenceDir, now, runner = spawnRunner, env, installScanner = defaultInstallScanner, base = null, advisories = fetchAdvisories } = {}) {
  mkdirSync(evidenceDir, { recursive: true });
  const incomplete = [];
  const { policy, problems: policyProblems } = loadPolicy(root);
  incomplete.push(...policyProblems);
  const revision = gitRevision(root);
  const collection = { schema: COLLECTION_SCHEMA, startedAt: now, graphs: {}, scanner: null, binding: null, removedEnvironment: [] };
  let graphFindings = [];

  let snap = null;
  const snapPath = join(evidenceDir, 'snapshot.json');
  if (!existsSync(snapPath)) incomplete.push({ code: 'no_snapshot', detail: 'no inventory snapshot was taken after installation — run `snapshot` first' });
  else {
    const read = readEvidence(snapPath, SNAPSHOT_SCHEMA);
    if (read.problem) incomplete.push({ code: 'snapshot_unreadable', detail: read.problem });
    else if (!snapshotProblemsReadable(read.doc)) incomplete.push({ code: 'snapshot_unreadable', detail: 'snapshot.json: problems is not a list of problems' });
    else {
      snap = read.doc;
      for (const pr of snap.problems) incomplete.push({ code: `snapshot_${pr.code}`, detail: pr.detail });
    }
  }

  if (policy && incomplete.length === 0) {
    const before = capture(root, { policy, env, revision });
    incomplete.push(...before.problems);
    collection.binding = before.binding;
    for (const d of bindingDifferences(snap?.binding, before.binding)) incomplete.push({ code: 'binding_mismatch', detail: `the inventory is not the one snapshotted after installation: ${d}` });

    const scannerRoot = resolve(root, policy.scanner.root);
    if (incomplete.length === 0) {
      const install = installScanner({ root, scannerRoot, policy, runner });
      collection.scanner = { package: policy.scanner.package, pinned: policy.scanner.version, install: install.summary };
      incomplete.push(...install.problems);
    }

    let bases = {};
    if (incomplete.length === 0 && base) {
      const resolved = resolveBase(root, base, policy);
      collection.base = resolved.record;
      bases = resolved.bases;
    }

    if (incomplete.length === 0) {
      const { env: scanEnv, removed } = scannerEnvironment(process.env);
      collection.removedEnvironment = removed;
      const npmCli = join(scannerRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const graphs = [
        { graph: 'application', dir: root, scopeOf: undefined },
        { graph: 'scanner', dir: scannerRoot, scopeOf: toolingScope },
      ];
      for (const g of graphs) {
        const pre = inventory(g.dir, { graph: g.graph, env, scopeOf: g.scopeOf });
        incomplete.push(...pre.problems);
        const run = runner({ command: process.execPath, args: [npmCli, ...scannerArgs(policy.scanner.registry)], cwd: g.dir, env: scanEnv, timeoutMs: policy.scanner.timeoutSeconds * 1000 });
        const post = inventory(g.dir, { graph: g.graph, env, scopeOf: g.scopeOf });
        if (canonical(pre.digests) !== canonical(post.digests)) {
          incomplete.push({ code: 'inventory_changed_during_audit', detail: `${g.graph}: the installed inventory changed while it was being scanned — the result describes nothing that still exists` });
        }
        const report = readReport({ graph: g.graph, run, inv: pre, base: bases[g.graph] });
        incomplete.push(...report.problems);
        graphFindings.push(...report.findings);
        collection.graphs[g.graph] = { run: recordRun(evidenceDir, g.graph, run), digests: pre.digests, counts: pre.counts };
      }
      const after = capture(root, { policy, env, revision: gitRevision(root) });
      for (const d of bindingDifferences(snap?.binding, after.binding)) incomplete.push({ code: 'binding_mismatch', detail: `after the scan: ${d}` });

      // THE CLOCK, after the scanner, for the findings whose provenance was established.
      // The dates are read back from the very bytes retained, by the reader `evaluate` uses.
      const ids = advisoryIds(graphFindings);
      if (ids.length > 0) {
        let asked;
        try { asked = advisories(ids); } catch { asked = { answers: ids.map((id) => ({ id, status: 0, retrievedAt: null, error: 'fetch_failed', body: null })), authenticated: false }; }
        const record = buildAdvisoryEvidence(asked);
        writeFileSync(join(evidenceDir, ADVISORIES_FILE), record.bytes);
        collection.advisories = { file: ADVISORIES_FILE, sha256: record.sha256, requested: ids.length, authenticated: record.doc.authenticated };
        const read = readAdvisoryEvidence(record.bytes, record.sha256);
        incomplete.push(...read.problems);
        graphFindings = applyDates(graphFindings, read.dates);
      }
    }
  }

  const decidedAt = now;
  const result = evaluate({ incomplete, findings: graphFindings, records: policy?.records ?? [], now: decidedAt });
  collection.finishedAt = decidedAt;
  writeJson(join(evidenceDir, 'collection.json'), collection);
  const doc = { schema: RESULT_SCHEMA, decidedAt, headline: headline(result), ...result };
  writeJson(join(evidenceDir, 'result.json'), doc);
  return doc;
}

/** Install the pinned scanner from its own lockfile, scripts disabled, and prove the pin. */
export function defaultInstallScanner({ scannerRoot, policy, runner }) {
  const problems = [];
  const run = runner({
    command: 'npm',
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', `--registry=${policy.scanner.registry}`],
    cwd: scannerRoot,
    env: scannerEnvironment(process.env).env,
    timeoutMs: policy.scanner.timeoutSeconds * 1000,
  });
  const summary = { status: run.status, signal: run.signal, timedOut: run.timedOut, error: run.error, durationMs: run.durationMs };
  if (run.status !== 0) {
    problems.push({ code: 'scanner_install_failed', detail: `the pinned scanner could not be installed (status ${run.status}${run.timedOut ? ', timed out' : ''}): ${(run.stderr || run.error || '').slice(-400)}` });
    return { problems, summary };
  }
  return { problems: [...verifyScannerPin(scannerRoot, policy)], summary };
}

/** The scanner that will run is exactly the one the policy and the scanner lockfile name. */
export function verifyScannerPin(scannerRoot, policy) {
  const problems = [];
  const want = policy.scanner.version;
  try {
    const manifest = readJson(join(scannerRoot, 'package.json'));
    if (manifest.dependencies?.npm !== want) problems.push({ code: 'scanner_pin', detail: `dependency-audit/scanner/package.json pins npm ${manifest.dependencies?.npm}, the policy ${want}` });
    const lock = readJson(join(scannerRoot, 'package-lock.json'));
    if (lock.packages?.['node_modules/npm']?.version !== want) problems.push({ code: 'scanner_pin', detail: `the scanner lockfile locks npm ${lock.packages?.['node_modules/npm']?.version}, the policy ${want}` });
    const installed = readJson(join(scannerRoot, 'node_modules', 'npm', 'package.json'));
    if (installed.version !== want) problems.push({ code: 'scanner_pin', detail: `the installed scanner is npm ${installed.version}, the policy ${want}` });
  } catch (error) {
    problems.push({ code: 'scanner_pin', detail: `the scanner pin cannot be verified: ${error.message}` });
  }
  return problems;
}

/** Offline: decide again from retained evidence, refusing evidence that is not this checkout's. */
export function reevaluate(root, { evidenceDir, now, env } = {}) {
  const incomplete = [];
  const findings = [];
  let dated = null;
  const { policy, problems } = loadPolicy(root);
  incomplete.push(...problems);
  const readDoc = (name, schema) => {
    const read = readEvidence(join(evidenceDir, name), schema);
    if (read.problem) incomplete.push({ code: 'evidence_unreadable', detail: read.problem });
    return read.doc;
  };
  const collection = readDoc('collection.json', COLLECTION_SCHEMA);
  const snap = readDoc('snapshot.json', SNAPSHOT_SCHEMA);
  // Every way this branch is skipped has already recorded its reason: a null document
  // (readDoc), or a null policy (loadPolicy returns one only beside its problems).
  if (collection && snap && policy) {
    const current = capture(root, { policy, env, revision: gitRevision(root) });
    incomplete.push(...current.problems);
    for (const d of bindingDifferences(collection.binding, current.binding)) incomplete.push({ code: 'evidence_foreign', detail: `the evidence is not for this checkout: ${d}` });
    for (const d of bindingDifferences(snap.binding, collection.binding)) incomplete.push({ code: 'evidence_foreign', detail: `the evidence's scan is not bound to its snapshot: ${d}` });
    // THE BASE, re-derived from git — never taken from the record. A scan that had none, or
    // whose base was unavailable, is re-decided without provenance, as it was decided.
    let bases = {};
    if (collection.base !== undefined) {
      if (!isMapping(collection.base) || !SHA_RE.test(String(collection.base.commit)) || !['applied', 'unavailable'].includes(collection.base.state)) {
        incomplete.push({ code: 'evidence_unreadable', detail: 'collection.json: the base is not one this audit records' });
      } else if (collection.base.state === 'applied') {
        const again = resolveBase(root, collection.base.commit, policy);
        const differences = again.record.state === 'applied' ? baseDifferences(collection.base, again.record) : [again.record.reason];
        if (differences.length) incomplete.push({ code: 'evidence_base_mismatch', detail: `the base the scan was compared against cannot be re-derived from git: ${differences.join('; ')}` });
        else bases = again.bases;
      }
    }
    const expected = ['application', 'scanner'];
    for (const graph of expected) {
      const g = collection.graphs?.[graph];
      if (!g) { incomplete.push({ code: 'evidence_missing_graph', detail: `${graph}: no scan was recorded` }); continue; }
      let stdout = '';
      try { stdout = readFileSync(join(evidenceDir, g.run.stdoutFile), 'utf8'); } catch { incomplete.push({ code: 'evidence_unreadable', detail: `${graph}: raw output missing` }); continue; }
      if (sha256(stdout) !== g.run.stdoutSha256) { incomplete.push({ code: 'evidence_tampered', detail: `${graph}: the raw output is not the bytes that were recorded` }); continue; }
      const dir = graph === 'application' ? root : resolve(root, policy.scanner.root);
      const inv = inventory(dir, { graph, env, scopeOf: graph === 'scanner' ? toolingScope : undefined });
      if (canonical(inv.digests) !== canonical(g.digests)) incomplete.push({ code: 'evidence_foreign', detail: `${graph}: the recorded scan was of a different inventory` });
      const report = readReport({ graph, run: { ...g.run, stdout }, inv, base: bases[graph] });
      incomplete.push(...report.problems);
      findings.push(...report.findings);
    }
    // THE CLOCK, re-read from the retained record, never asked again.
    if (collection.advisories !== undefined) {
      const a = collection.advisories;
      if (!isMapping(a) || a.file !== ADVISORIES_FILE) {
        incomplete.push({ code: 'evidence_unreadable', detail: 'collection.json: the advisory record is not one this audit writes' });
      } else {
        let bytes;
        try { bytes = readFileSync(join(evidenceDir, ADVISORIES_FILE)); } catch { bytes = undefined; }
        const read = readAdvisoryEvidence(bytes, a.sha256);
        for (const p of read.problems) incomplete.push({ code: p.code === 'advisories_tampered' ? 'evidence_tampered' : 'evidence_unreadable', detail: p.detail });
        dated = read.problems.length === 0 ? read.dates : null;
      }
    }
  }
  const result = evaluate({ incomplete, findings: dated ? applyDates(findings, dated) : findings, records: policy?.records ?? [], now });
  return { schema: RESULT_SCHEMA, decidedAt: now, headline: headline(result), ...result };
}

/**
 * What the collection says about the base and the clock, in one or two lines — so a run
 * that deferred nothing because it had no base says so, rather than looking like a run
 * that had nothing to defer.
 */
function provenanceLines(collection) {
  if (!isMapping(collection)) return [];
  const b = collection.base;
  const lines = [];
  if (b === undefined) lines.push('Provenance: no base was given, so no finding carries one and nothing can be deferred.');
  else if (b?.state === 'applied') {
    const graphs = Object.entries(b.graphs ?? {}).map(([g, r]) => `${g} ${r?.state}`).join(', ');
    lines.push(`Provenance: against base ${b.commit} (${graphs}).`);
  } else lines.push(`Provenance: base ${b?.commit} is unavailable (${b?.reason}); treated as no base, so nothing can be deferred.`);
  const a = collection.advisories;
  if (isMapping(a)) lines.push(`Clock: ${a.requested} advisory record(s) asked of GitHub (${a.authenticated ? 'with the job token' : 'unauthenticated'}), retained as ${a.file}; a finding whose advisory has no date is never deferred.`);
  return lines;
}

/**
 * Why a blocking HIGH tooling finding that carries provenance was not deferred — the one
 * question a pull request's author has about it. Words only; the decision is core.mjs's.
 */
function notDeferredBecause(f) {
  if (f.class !== 'blocking' || f.scope !== 'tooling' || f.severity !== 'high' || typeof f.provenance !== 'string') return '';
  if (f.provenance === 'introduced') return ' (introduced: not in the base)';
  if (typeof f.reportableSince !== 'string') return ' (inherited; no reportable date)';
  return ` (inherited, reportable since ${f.reportableSince}; its window has closed)`;
}

/** A human summary: the headline, then what decided it. */
export function renderSummary(result, { markdown = false, collection = null } = {}) {
  const lines = [];
  lines.push(markdown ? `### Dependency audit\n\n**${result.headline}**\n` : result.headline);
  for (const line of provenanceLines(collection)) lines.push(markdown ? `${line}\n` : line);
  const group = new Map();
  for (const f of result.findings) {
    const key = `${f.advisory}|${f.package}|${f.severity}|${f.scope}|${f.class}|${f.disposition}|${notDeferredBecause(f)}`;
    if (!group.has(key)) group.set(key, { ...f, paths: [] });
    group.get(key).paths.push(`${f.path}@${f.version}`);
  }
  if (group.size) {
    if (markdown) lines.push('| advisory | package | severity | scope | decision | where |', '|---|---|---|---|---|---|');
    for (const g of group.values()) {
      const open = g.class === 'triage' ? 'triage required' : g.class === 'deferred' ? `deferred: inherited, blocks from ${g.deadline}` : g.class;
      const decision = g.disposition === 'open' ? `${open}${notDeferredBecause(g)}` : `${g.disposition} (${g.coveredBy})`;
      lines.push(markdown
        ? `| ${g.advisory} | ${g.package} | ${g.severity} | ${g.scope} | ${decision} | ${g.paths.join('<br>')} |`
        : `  ${g.advisory}  ${g.package}  ${g.severity}  ${g.scope}  → ${decision}\n      ${g.paths.join('\n      ')}`);
    }
  }
  const reasons = result.reasons.filter((r) => r.code !== 'blocking_finding');
  if (reasons.length) {
    lines.push(markdown ? '\n**Why:**\n' : 'Why:');
    for (const r of reasons) lines.push(`${markdown ? '- ' : '  - '}[${r.outcome}] ${r.code}: ${r.detail}`);
  }
  return lines.join('\n');
}

export function publishSummary(result, { collection = null } = {}) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) appendFileSync(target, `${renderSummary(result, { markdown: true, collection })}\n`);
}
