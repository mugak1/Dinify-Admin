/**
 * THE FRESH ASSESSMENT — a new advisory query, now, over the dependency graph a certified
 * candidate was BUILT FROM, under the CURRENT trusted audit policy.
 *
 * Freshness and retention are different things and this file keeps them apart. A
 * candidate certified last week has not changed; what may have changed is what is KNOWN
 * about the packages it was built from. So promotion asks the question again, over the
 * RETAINED lock graph (the exact package.json and package-lock.json certification bound),
 * and never over current main, a rebuilt graph, or a timestamp moved forward.
 *
 * WHAT IS OBSERVED, stated exactly:
 *   - the advisory answer is a NEW query by the pinned scanner (installed from the TRUSTED
 *     checkout's own scanner lock, scripts disabled) over a directory holding ONLY the two
 *     retained files — `npm audit` reads the lock graph, so this is a scan-only replay:
 *     no candidate package code, lifecycle script, hook or build runs;
 *   - the scanner's OWN graph is assessed as it is installed now, from the trusted lock;
 *   - WHAT WAS INSTALLED at certification is not re-observed (those bytes are gone). It is
 *     the certification snapshot, checked by retained.mjs to be exactly the retained lock
 *     graph. No node_modules is forged and nothing calls one observed.
 *
 * The policy that decides is the TRUSTED one (the deploy workflow's own revision), never
 * the audit policy the candidate carries: that one only reproduces what certification
 * decided. Exceptions and triage records therefore come from the trusted policy alone.
 *
 * The window is measured from the actual start of advisory collection, and an applied
 * exception's lapse is part of the same deadline. `assessmentDeadline` is shared by the
 * admission, the privileged verification and — as an epoch second — the host, so the three
 * cannot disagree about when this assessment stops authorising a promotion.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultInstallScanner, loadPolicy, POLICY_SCHEMA } from '../../dependency-audit/lib/audit.mjs';
import { evaluate, headline } from '../../dependency-audit/lib/core.mjs';
import { inventory, readReport, sha256, toolingScope } from '../../dependency-audit/lib/npm.mjs';
import { collect, retainedInventory, writeReplay, RETAINED_OBSERVATION } from '../../dependency-audit/lib/retained.mjs';
import { HEX_RE, DIGEST_RE, ID_RE, SHA_RE, isInstant, isObject, parseJson, reason, recordBytes, same } from './common.mjs';
import { lockOnlyInventory, PASSING } from './certification.mjs';
import { digestOf, sha256Hex } from './tree.mjs';

export const ASSESSMENT_SCHEMA = 'dinify.admin.assessment/1';
export const ASSESSMENT_DOC = 'assessment.json';
export const GRAPHS = Object.freeze(['application', 'scanner']);
const RAW_RE = /^(application|scanner)\.scanner-(stdout|stderr)\.txt$/;

/** Which records the decision actually applied, with their lapse dates. */
function appliedRecords(result, records) {
  const applied = result.records.filter((r) => r.status === 'applied' && r.covers > 0).map((r) => r.id);
  return applied.map((id) => {
    const rec = records.find((r) => r.id === id);
    return { id, kind: rec?.kind ?? null, expires: rec?.expires ?? null };
  });
}

/**
 * Perform the assessment and write assessment/ (the document and the raw scanner output).
 *
 * @param {object} input
 * @param {string} input.trustedRoot   the TRUSTED checkout (the workflow's own revision)
 * @param {object} input.inspection    inspectCandidate() facts for the candidate (must be clean)
 * @param {object} input.candidate     {commit, runId, runAttempt, artifactId, artifactDigest}
 * @param {object} input.assessor      {workflowPath, runId, runAttempt, revision}
 * @param {string} input.outDir        where assessment.json and the raw output go (empty)
 * @param {string} input.replayDir     an EMPTY directory for the scan-only replay
 * @param {Function} input.runner      the process runner (dependency-audit/lib/audit.mjs)
 * @param {Function} input.clock       () => ISO instant
 * @param {Function} [input.installScanner]
 */
export function assess({ trustedRoot, inspection, candidate, assessor, outDir, replayDir, runner, clock, installScanner = defaultInstallScanner }) {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(replayDir, { recursive: true });
  const incomplete = [];
  const findings = [];
  const graphs = {};
  const startedAt = clock();
  const { policy, problems: policyProblems } = loadPolicy(trustedRoot);
  incomplete.push(...policyProblems);
  let scanner = null;
  let replay = null;
  if (!inspection?.retained || inspection.problems?.length) incomplete.push(reason('candidate_not_inspected', 'no clean candidate inspection to assess'));
  if (policy && !incomplete.length) {
    const scannerRoot = join(trustedRoot, policy.scanner.root);
    const install = installScanner({ root: trustedRoot, scannerRoot, policy, runner });
    incomplete.push(...install.problems);
    if (!incomplete.length) {
      const npmCli = join(scannerRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const { manifestBytes, lockBytes, snapshot } = inspection.retained;
      incomplete.push(...writeReplay(replayDir, { manifestBytes, lockBytes }));
      replay = { names: ['package-lock.json', 'package.json'], manifestSha256: sha256(manifestBytes), lockfileSha256: sha256(lockBytes) };
      if (!incomplete.length) {
        const appInv = retainedInventory({ graph: 'application', manifestBytes, lockBytes, snapshot });
        const app = collect({ graph: 'application', dir: replayDir, inv: appInv, kind: 'retained', npmCli, policy, runner, clock, evidenceDir: outDir });
        incomplete.push(...app.problems);
        findings.push(...app.findings);
        graphs.application = app.record;
        const scannerInv = inventory(scannerRoot, { graph: 'scanner', scopeOf: toolingScope });
        const scn = collect({ graph: 'scanner', dir: scannerRoot, inv: scannerInv, kind: 'installed', scopeOf: toolingScope, npmCli, policy, runner, clock, evidenceDir: outDir });
        incomplete.push(...scn.problems);
        findings.push(...scn.findings);
        graphs.scanner = scn.record;
        scanner = { package: policy.scanner.package, version: policy.scanner.version, manifestSha256: scannerInv.digests.manifestSha256 ?? null, lockfileSha256: scannerInv.digests.lockfileSha256 ?? null };
      }
    }
  }
  const finishedAt = clock();
  const decidedAt = clock();
  const records = policy?.records ?? [];
  const result = evaluate({ incomplete, findings, records, now: decidedAt });
  const doc = {
    schema: ASSESSMENT_SCHEMA,
    purpose: 'promotion',
    startedAt,
    finishedAt,
    decidedAt,
    assessor: { workflowPath: assessor.workflowPath, runId: String(assessor.runId), runAttempt: String(assessor.runAttempt), revision: assessor.revision },
    candidate: {
      commit: candidate.commit,
      runId: String(candidate.runId),
      runAttempt: String(candidate.runAttempt),
      artifactId: String(candidate.artifactId),
      artifactDigest: candidate.artifactDigest,
      certificationDigest: inspection?.recordDigest ?? null,
      payloadTreeDigest: inspection?.payload?.treeDigest ?? null,
      archiveSha256: inspection?.payload?.archiveSha256 ?? null,
    },
    policy: { sha256: policy ? auditPolicyIdentity(readFileSync(join(trustedRoot, 'dependency-audit', 'policy.json'))) : null },
    scanner,
    replay,
    graphs,
    outcome: result.outcome,
    exitCode: result.exitCode,
    counts: result.counts,
    headline: headline(result),
    reasons: result.reasons,
    recordsApplied: appliedRecords(result, records),
  };
  writeFileSync(join(outDir, ASSESSMENT_DOC), recordBytes(doc));
  return { doc, result };
}

/** The audit policy's identity: the sha256 of the committed file's bytes. */
export const auditPolicyIdentity = (bytes) => sha256(bytes);

/** 00:00 UTC on a record's `expires` date: from that instant it has lapsed (core.mjs's rule). */
export const recordLapsesAt = (expires) => Date.parse(`${expires}T00:00:00Z`);

/**
 * The instant this assessment stops authorising a promotion: the window end measured from
 * the start of collection, or the first applied record's lapse, whichever is earlier.
 * Milliseconds since the epoch; NaN when it cannot be established.
 */
export function assessmentDeadline(doc, releasePolicy) {
  const windowEnd = Date.parse(doc.startedAt) + releasePolicy.freshness.assessmentWindowHours * 3_600_000;
  const lapses = (doc.recordsApplied ?? []).map((r) => recordLapsesAt(r.expires));
  return Math.min(windowEnd, ...lapses);
}

/** Shape only. Truth is `verifyAssessment`'s question. */
export function validateAssessment(doc) {
  const out = [];
  const p = (detail) => out.push(reason('assessment_invalid', detail));
  if (!isObject(doc)) return [reason('assessment_invalid', 'not an object')];
  if (doc.schema !== ASSESSMENT_SCHEMA) p(`schema ${String(doc.schema)}`);
  if (doc.purpose !== 'promotion') p('purpose');
  for (const key of ['startedAt', 'finishedAt', 'decidedAt']) if (!isInstant(doc[key])) p(`${key} is not an instant`);
  const a = doc.assessor;
  if (!isObject(a) || typeof a.workflowPath !== 'string' || !ID_RE.test(String(a.runId)) || !ID_RE.test(String(a.runAttempt)) || !SHA_RE.test(String(a.revision))) p('assessor');
  const c = doc.candidate;
  if (!isObject(c) || !SHA_RE.test(String(c.commit)) || !ID_RE.test(String(c.runId)) || !ID_RE.test(String(c.runAttempt)) || !ID_RE.test(String(c.artifactId))
      || !DIGEST_RE.test(String(c.artifactDigest)) || !DIGEST_RE.test(String(c.certificationDigest)) || !DIGEST_RE.test(String(c.payloadTreeDigest)) || !HEX_RE.test(String(c.archiveSha256))) p('candidate');
  if (!isObject(doc.policy) || !HEX_RE.test(String(doc.policy.sha256))) p('policy');
  if (!isObject(doc.scanner) || doc.scanner.package !== 'npm' || !HEX_RE.test(String(doc.scanner.lockfileSha256))) p('scanner');
  if (!isObject(doc.replay) || !same(doc.replay.names, ['package-lock.json', 'package.json'])) p('replay');
  if (!isObject(doc.graphs)) p('graphs');
  else {
    for (const g of GRAPHS) {
      const r = doc.graphs[g];
      if (!isObject(r) || !isInstant(r.startedAt) || !isInstant(r.finishedAt) || !isObject(r.run) || !RAW_RE.test(String(r.run.stdoutFile))
          || !RAW_RE.test(String(r.run.stderrFile)) || !HEX_RE.test(String(r.run.stdoutSha256)) || !HEX_RE.test(String(r.run.stderrSha256))) p(`graph ${g}`);
    }
    for (const g of Object.keys(doc.graphs)) if (!GRAPHS.includes(g)) p(`unexpected graph ${g}`);
  }
  if (typeof doc.outcome !== 'string' || !Number.isInteger(doc.exitCode) || !isObject(doc.counts)) p('result');
  if (!Array.isArray(doc.recordsApplied) || !doc.recordsApplied.every((r) => isObject(r) && typeof r.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.expires)))) p('recordsApplied');
  return out;
}

/**
 * Verify a retained assessment directory WITHOUT querying anything: the document, its raw
 * output, and the decision REPRODUCED from that raw output under the TRUSTED policy. Used by
 * the privileged job, so a claim of "within policy" over raw output that says otherwise —
 * or a document written by anything other than the evaluator — cannot carry a promotion.
 *
 * @param {Map<string, Buffer>} files  the assessment directory's files
 * @param {object} input
 * @param {object} input.inspection    inspectCandidate() facts for the same candidate
 * @param {object} input.auditPolicy   the TRUSTED dependency-audit policy (validated by loadPolicy)
 * @param {Buffer} input.auditPolicyBytes  its committed bytes
 * @param {Buffer} input.scannerManifest  the TRUSTED scanner package.json bytes
 * @param {Buffer} input.scannerLock      the TRUSTED scanner package-lock.json bytes
 * @param {object} input.releasePolicy the TRUSTED release policy
 * @param {string} input.now           ISO instant of THIS check
 */
export function verifyAssessment(files, { inspection, auditPolicy, auditPolicyBytes, scannerManifest, scannerLock, releasePolicy, now }) {
  const out = { problems: [], doc: null, digest: null, deadlineMs: NaN };
  const problem = (code, detail) => out.problems.push(reason(code, detail));
  if (!(files instanceof Map) || !files.has(ASSESSMENT_DOC)) { problem('assessment_missing', 'no fresh assessment — not performed is not passed'); return out; }
  out.digest = digestOf(files.get(ASSESSMENT_DOC));
  const parsed = parseJson(files.get(ASSESSMENT_DOC));
  if (!parsed.ok) { problem('assessment_invalid', parsed.detail); return out; }
  const doc = parsed.value;
  out.doc = doc;
  out.problems.push(...validateAssessment(doc));
  if (out.problems.length) return out;

  // Exactly the document and the raw output it names.
  const expected = new Set([ASSESSMENT_DOC]);
  const raw = {};
  for (const g of GRAPHS) {
    const run = doc.graphs[g].run;
    for (const [file, digest] of [[run.stdoutFile, run.stdoutSha256], [run.stderrFile, run.stderrSha256]]) {
      expected.add(file);
      const bytes = files.get(file);
      if (!bytes) problem('assessment_raw_missing', `${g}: ${file}`);
      else if (sha256Hex(bytes) !== digest) problem('assessment_raw_mismatch', `${g}: ${file} is not the bytes the assessment recorded`);
    }
    raw[g] = files.get(run.stdoutFile)?.toString('utf8');
  }
  for (const path of files.keys()) if (!expected.has(path)) problem('assessment_unexpected_file', path);
  if (out.problems.length) return out;

  // Bound to THIS candidate, THIS trusted policy and THIS trusted scanner.
  const c = doc.candidate;
  if (c.certificationDigest !== inspection.recordDigest || c.payloadTreeDigest !== inspection.payload.treeDigest || c.archiveSha256 !== inspection.payload.archiveSha256
      || c.commit !== inspection.record.commit || c.runId !== inspection.record.workflow.runId || c.runAttempt !== inspection.record.workflow.runAttempt) {
    problem('assessment_wrong_candidate', 'the assessment is not of this candidate');
  }
  if (doc.policy.sha256 !== auditPolicyIdentity(auditPolicyBytes)) problem('assessment_policy_changed', 'the assessment was decided under a different audit policy than the trusted one');
  if (doc.scanner.lockfileSha256 !== sha256Hex(scannerLock) || doc.scanner.version !== auditPolicy.scanner.version) problem('assessment_wrong_scanner', 'the assessment scanner is not the trusted pinned scanner');
  if (doc.replay.manifestSha256 !== sha256Hex(inspection.retained.manifestBytes) || doc.replay.lockfileSha256 !== sha256Hex(inspection.retained.lockBytes)) {
    problem('assessment_wrong_graph', 'the replay was not of the retained lock graph');
  }
  if (doc.graphs.application.observation !== RETAINED_OBSERVATION) problem('assessment_wrong_graph', 'the application graph was not the retained graph');
  if (out.problems.length) return out;

  // REPRODUCE the decision from the raw output under the trusted policy.
  const { manifestBytes, lockBytes, snapshot } = inspection.retained;
  const invs = {
    application: retainedInventory({ graph: 'application', manifestBytes, lockBytes, snapshot }),
    scanner: lockOnlyInventory('scanner', scannerManifest, scannerLock),
  };
  const incomplete = [...invs.application.problems, ...invs.scanner.problems];
  const findings = [];
  for (const g of GRAPHS) {
    const rr = readReport({ graph: g, run: { ...doc.graphs[g].run, stdout: raw[g] }, inv: invs[g] });
    incomplete.push(...rr.problems);
    findings.push(...rr.findings);
  }
  const reproduced = evaluate({ incomplete, findings, records: auditPolicy.records, now: doc.decidedAt });
  if (reproduced.outcome !== doc.outcome || !same(reproduced.counts, doc.counts)) {
    problem('assessment_unreproducible', `the raw output reads as ${reproduced.outcome}, the assessment says ${doc.outcome}`);
  }
  if (!same(appliedRecords(reproduced, auditPolicy.records), doc.recordsApplied)) problem('assessment_unreproducible', 'the applied records are not the ones the raw output supports');
  if (!PASSING.includes(reproduced.outcome) || !PASSING.includes(doc.outcome) || doc.exitCode !== 0) {
    problem('assessment_not_passing', `${doc.headline ?? doc.outcome}`);
  }

  // TIME: ordered, not from the future, inside the window, no applied record lapsed.
  const ms = (t) => Date.parse(t);
  const a = doc;
  const ordered = GRAPHS.every((g) => ms(a.startedAt) <= ms(a.graphs[g].startedAt) && ms(a.graphs[g].startedAt) <= ms(a.graphs[g].finishedAt)
    && ms(a.graphs[g].finishedAt) <= ms(a.finishedAt)) && ms(a.finishedAt) <= ms(a.decidedAt);
  if (!ordered) problem('assessment_time_invalid', 'the collection times are out of order');
  if (!isInstant(now) || ms(a.decidedAt) > ms(now)) problem('assessment_time_invalid', `decided ${a.decidedAt}, after ${now}`);
  out.deadlineMs = assessmentDeadline(doc, releasePolicy);
  if (!Number.isFinite(out.deadlineMs)) problem('assessment_time_invalid', 'no deadline can be established');
  else if (ms(now) >= out.deadlineMs) problem('assessment_expired', `the assessment (collected ${a.startedAt}) or an applied record stopped authorising promotion at ${new Date(out.deadlineMs).toISOString()}`);
  return out;
}

// Re-exported so callers validate the trusted policy with the evaluator's own loader.
export { loadPolicy, POLICY_SCHEMA };
