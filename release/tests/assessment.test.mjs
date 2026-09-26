/**
 * THE FRESH ASSESSMENT — a new advisory query over the graph a candidate was BUILT FROM,
 * under the TRUSTED policy, bound to that candidate and to the evaluating run.
 *
 * Every case runs the REAL `assess` over a REAL certified candidate. The scanner's ANSWERS
 * are canned at the runner seam (SYNTHETIC — the live scanner is exercised by the real
 * build proof), and the scanner install is the pin-verifying fake the dependency-audit
 * suite uses. The replay directory, the inventory, the evaluation and the verification are
 * real.
 */

import { strict as assert } from 'node:assert';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CLEAN, CLEAN_SCANNER, cannedRunner, fakeInstall, npmReport, via } from '../../dependency-audit/tests/project.mjs';
import { ASSESSMENT_DOC, assess, assessmentDeadline, verifyAssessment } from '../lib/assessment.mjs';
import { inspectCandidate } from '../lib/certification.mjs';
import { loadReleasePolicy, recordBytes } from '../lib/common.mjs';
import { walkTree } from '../lib/tree.mjs';
import { EVAL_RUN_ID, NOW, RUN_ATTEMPT, RUN_ID, apiFacts, candidateFiles, certifiedProject, steppingClock, tempDir } from './fixtures.mjs';

const codes = (problems) => problems.map((p) => p.code);

const HIGH_ON_SHIPPED = { status: 1, stdout: npmReport({ shipped: { via: [via('shipped', 'high', '<3.0.0')], nodes: ['node_modules/shipped'] } }) };

/** A narrow, approved exception for the synthetic high advisory on `shipped` (core.mjs's shape). */
const EXCEPTION = {
  id: 'EXC-0042', kind: 'exception', advisory: 'GHSA-aaaa-bbbb-cccc', aliases: [], package: 'shipped', version: '2.0.0',
  paths: ['application:node_modules/shipped'], scope: 'runtime',
  applicability: 'The affected API is never reached by the bundle; verified in the linked review.',
  reason: 'No fixed release inside the declared range; tracked in the linked review.',
  owner: 'Dinify platform owner', approval: { by: 'Dinify platform owner', reference: 'https://github.com/mugak1/Dinify-Admin/pull/1', date: '2026-09-20' },
  expires: '2026-10-20',
};

function expectFor(p) {
  const f = apiFacts(p);
  const { policy } = loadReleasePolicy(p.root);
  const inputBlobs = Object.fromEntries(f.tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  return { policy, commit: p.commit, tree: f.commit.tree.sha, inputBlobs, runId: RUN_ID, runAttempt: RUN_ATTEMPT };
}

/**
 * A TRUSTED root that is not the candidate's: the dependency-audit directory (policy and
 * scanner pin) copied out, its policy's records replaced. This is what "the deploy
 * workflow's own revision" looks like when it disagrees with what certification carried.
 */
function trustedRootFrom(p, { records } = {}) {
  const t = tempDir('trusted-');
  cpSync(join(p.root, 'dependency-audit'), join(t.dir, 'dependency-audit'), { recursive: true, filter: (src) => !src.includes('/evidence') });
  cpSync(join(p.root, 'release'), join(t.dir, 'release'), { recursive: true, filter: (src) => !src.includes('/.work') });
  if (records) {
    const path = join(t.dir, 'dependency-audit', 'policy.json');
    const policy = JSON.parse(readFileSync(path, 'utf8'));
    policy.records = records;
    writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);
  }
  return t;
}

function runAssess(p, { answers = {}, trustedRoot = p.root, clock = steppingClock(NOW), install = fakeInstall } = {}) {
  const inspection = inspectCandidate(candidateFiles(p.candidateDir), expectFor(p));
  assert.deepEqual(inspection.problems, [], 'the candidate must inspect clean before it is assessed');
  const out = tempDir('assessment-');
  const replay = tempDir('replay-');
  const runner = cannedRunner({ application: answers.application ?? CLEAN, scanner: answers.scanner ?? CLEAN_SCANNER });
  const { doc, result } = assess({
    trustedRoot, inspection,
    candidate: { commit: p.commit, runId: RUN_ID, runAttempt: RUN_ATTEMPT, artifactId: '5550001', artifactDigest: `sha256:${'a'.repeat(64)}` },
    assessor: { workflowPath: '.github/workflows/deploy.yml', runId: EVAL_RUN_ID, runAttempt: '1', revision: p.commit },
    outDir: out.dir, replayDir: replay.dir, runner, clock, installScanner: install,
  });
  return { inspection, doc, result, runner, outDir: out.dir, replayDir: replay.dir, cleanup: () => { out.cleanup(); replay.cleanup(); } };
}

/** The privileged side's check, against the trusted checkout `trustedRoot`. */
function verify(p, a, { trustedRoot = p.root, now = '2026-09-26T09:30:00.000Z', files } = {}) {
  const auditPolicyBytes = readFileSync(join(trustedRoot, 'dependency-audit', 'policy.json'));
  const { policy: releasePolicy } = loadReleasePolicy(trustedRoot);
  return verifyAssessment(files ?? walkTree(a.outDir).files, {
    inspection: a.inspection,
    auditPolicy: JSON.parse(auditPolicyBytes),
    auditPolicyBytes,
    scannerManifest: readFileSync(join(trustedRoot, 'dependency-audit', 'scanner', 'package.json')),
    scannerLock: readFileSync(join(trustedRoot, 'dependency-audit', 'scanner', 'package-lock.json')),
    releasePolicy,
    now,
  });
}

const withAssessment = (projectOpts, assessOpts, fn) => {
  const p = certifiedProject(projectOpts);
  const a = runAssess(p, typeof assessOpts === 'function' ? assessOpts(p) : assessOpts);
  try { return fn(p, a); } finally { a.cleanup(); p.cleanup(); }
};

describe('the fresh assessment: a new question over the retained graph', () => {
  it('CONTROL: a clean scan of the retained graph admits, and the privileged re-check reproduces it', () => withAssessment({}, {}, (p, a) => {
    assert.equal(a.doc.outcome, 'within_policy');
    assert.equal(a.doc.exitCode, 0);
    assert.equal(a.doc.candidate.payloadTreeDigest, a.inspection.payload.treeDigest);
    assert.equal(a.doc.candidate.certificationDigest, a.inspection.recordDigest);
    assert.equal(a.doc.assessor.runId, EVAL_RUN_ID);
    const v = verify(p, a);
    assert.deepEqual(v.problems, []);
    assert.equal(v.deadlineMs, Date.parse(a.doc.startedAt) + 24 * 3_600_000);
  }));

  it('CONTRACT: the replay is SCAN-ONLY — exactly the two retained files, and the only process run is `npm audit`', () => withAssessment({}, {}, (p, a) => {
    assert.deepEqual(readdirSync(a.replayDir).sort(), ['package-lock.json', 'package.json']);
    assert.deepEqual(readFileSync(join(a.replayDir, 'package-lock.json')), a.inspection.retained.lockBytes);
    assert.equal(a.runner.calls.length, 2, 'one scan per graph, nothing else');
    for (const call of a.runner.calls) {
      assert.equal(call.args[1], 'audit');
      assert.ok(call.args.includes('--json'));
      assert.ok(!call.args.some((x) => /^(ci|install|run|exec|rebuild|--ignore-scripts=false)$/.test(x)));
      for (const key of Object.keys(call.env)) assert.doesNotMatch(key, /^npm_config_(?!update_notifier|fund)/i, 'no inherited npm configuration');
    }
    assert.equal(a.runner.calls[0].cwd, a.replayDir, 'the application graph is scanned in the replay, not the checkout');
    assert.equal(a.doc.graphs.application.observation, 'certification-snapshot');
    assert.equal(a.doc.graphs.scanner.observation, 'installed-now');
  }));

  it('REGRESSION: a newly published HIGH advisory refuses a candidate whose bytes and certification are unchanged', () => withAssessment({}, { answers: { application: HIGH_ON_SHIPPED } }, (p, a) => {
    assert.equal(a.doc.outcome, 'blocking');
    assert.ok(a.doc.reasons.some((r) => r.code === 'blocking_finding' && /GHSA-aaaa-bbbb-cccc/.test(r.detail)));
    // The candidate is the one certification passed; only what is KNOWN changed.
    assert.equal(p.stages.certify.record.audit.outcome, 'within_policy');
    assert.ok(codes(verify(p, a).problems).includes('assessment_not_passing'));
  }));

  for (const [label, answer, code] of [
    ['the scanner could not reach the registry (empty body, status 1)', { status: 1, stdout: '' }, 'assessment_not_passing'],
    ['the scanner answered with an error body', { status: 1, stdout: JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'audit endpoint returned an error' } }) }, 'assessment_not_passing'],
    ['the scanner\'s output was truncated', { status: 0, stdout: npmReport({}, 4).slice(0, 60) }, 'assessment_not_passing'],
    ['the scanner timed out', { status: null, signal: 'SIGTERM', timedOut: true, stdout: '' }, 'assessment_not_passing'],
  ]) {
    it(`REGRESSION MATRIX: ${label} → INCOMPLETE, never a pass`, () => withAssessment({}, { answers: { application: answer } }, (p, a) => {
      assert.equal(a.doc.outcome, 'incomplete');
      assert.equal(a.doc.exitCode, 2);
      assert.ok(codes(verify(p, a).problems).includes(code));
    }));
  }

  it('REGRESSION: the pinned scanner fails to install → INCOMPLETE, and nothing is queried', () => withAssessment({}, {
    install: () => ({ problems: [{ code: 'scanner_install_failed', detail: 'npm ci exited 1' }], summary: { status: 1 } }),
  }, (p, a) => {
    assert.equal(a.doc.outcome, 'incomplete');
    assert.equal(a.runner.calls.length, 0);
    assert.ok(codes(verify(p, a).problems).length > 0, 'an assessment with no graphs cannot authorise a promotion');
  }));

  it('REGRESSION: a candidate that did not inspect clean is not assessed', () => {
    const p = certifiedProject();
    const out = tempDir(); const replay = tempDir();
    try {
      const runner = cannedRunner({ application: CLEAN, scanner: CLEAN_SCANNER });
      const { doc } = assess({
        trustedRoot: p.root, inspection: { problems: [{ code: 'payload_altered', detail: 'x' }] },
        candidate: { commit: p.commit, runId: RUN_ID, runAttempt: RUN_ATTEMPT, artifactId: '1', artifactDigest: `sha256:${'a'.repeat(64)}` },
        assessor: { workflowPath: '.github/workflows/deploy.yml', runId: EVAL_RUN_ID, runAttempt: '1', revision: p.commit },
        outDir: out.dir, replayDir: replay.dir, runner, clock: steppingClock(), installScanner: fakeInstall,
      });
      assert.equal(doc.outcome, 'incomplete');
      assert.equal(runner.calls.length, 0);
    } finally { out.cleanup(); replay.cleanup(); p.cleanup(); }
  });
});

describe('the TRUSTED policy decides, never the one the candidate carries', () => {
  it('REGRESSION: an exception approved at certification but REMOVED from the trusted policy since → the fresh assessment blocks', () => {
    const p = certifiedProject({ records: [EXCEPTION], answers: { application: HIGH_ON_SHIPPED } });
    const trusted = trustedRootFrom(p, { records: [] });
    try {
      assert.equal(p.stages.certify.record.audit.outcome, 'exceptions_only', 'certification passed on the exception');
      const a = runAssess(p, { answers: { application: HIGH_ON_SHIPPED }, trustedRoot: trusted.dir });
      try {
        assert.equal(a.doc.outcome, 'blocking');
        assert.deepEqual(a.doc.recordsApplied, []);
      } finally { a.cleanup(); }
    } finally { trusted.cleanup(); p.cleanup(); }
  });

  it('CONTROL: the same exception still in the trusted policy → exceptions_only, and its lapse is part of the deadline', () => {
    const lapsing = { ...EXCEPTION, expires: '2026-09-27' };
    const p = certifiedProject({ records: [lapsing], answers: { application: HIGH_ON_SHIPPED } });
    try {
      const a = runAssess(p, { answers: { application: HIGH_ON_SHIPPED } });
      try {
        assert.equal(a.doc.outcome, 'exceptions_only');
        assert.deepEqual(a.doc.recordsApplied, [{ id: 'EXC-0042', kind: 'exception', expires: '2026-09-27' }]);
        const { policy } = loadReleasePolicy(p.root);
        // Window end 2026-09-27T09:00:00Z; the record lapses at 00:00 that day — the earlier wins.
        assert.equal(new Date(assessmentDeadline(a.doc, policy)).toISOString(), '2026-09-27T00:00:00.000Z');
        const v = verify(p, a, { now: '2026-09-26T23:00:00.000Z' });
        assert.deepEqual(v.problems, []);
        assert.ok(codes(verify(p, a, { now: '2026-09-27T00:00:00.000Z' }).problems).includes('assessment_expired'), 'a lapsed record stops the promotion even inside the window');
      } finally { a.cleanup(); }
    } finally { p.cleanup(); }
  });

  it('REGRESSION: an assessment decided under a policy that has since moved is refused by the privileged re-check', () => withAssessment({}, {}, (p, a) => {
    const moved = trustedRootFrom(p, { records: [] });
    try {
      // Same records (none), different bytes: a whitespace edit is still a different policy.
      const path = join(moved.dir, 'dependency-audit', 'policy.json');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
      assert.ok(codes(verify(p, a, { trustedRoot: moved.dir }).problems).includes('assessment_policy_changed'));
    } finally { moved.cleanup(); }
  }));
});

describe('the privileged re-check reproduces the decision instead of trusting it', () => {
  const tamper = (a, edit) => {
    const files = walkTree(a.outDir).files;
    edit(files);
    return files;
  };
  const editDoc = (fn) => (files) => { const d = JSON.parse(files.get(ASSESSMENT_DOC)); fn(d); files.set(ASSESSMENT_DOC, recordBytes(d)); };

  it('REGRESSION: a document rewritten from blocking to within_policy over the same raw output → unreproducible', () => withAssessment({}, { answers: { application: HIGH_ON_SHIPPED } }, (p, a) => {
    const files = tamper(a, editDoc((d) => { d.outcome = 'within_policy'; d.exitCode = 0; d.counts.blocking = 0; d.reasons = []; }));
    const c = codes(verify(p, a, { files }).problems);
    assert.ok(c.includes('assessment_unreproducible'));
    assert.ok(c.includes('assessment_not_passing'));
  }));

  it('REGRESSION: raw output swapped for a clean answer (digest no longer matches) → refused', () => withAssessment({}, { answers: { application: HIGH_ON_SHIPPED } }, (p, a) => {
    const files = tamper(a, (f) => f.set('application.scanner-stdout.txt', Buffer.from(CLEAN.stdout)));
    assert.ok(codes(verify(p, a, { files }).problems).includes('assessment_raw_mismatch'));
  }));

  it('REGRESSION: an assessment of a different candidate → wrong candidate', () => withAssessment({}, {}, (p, a) => {
    const files = tamper(a, editDoc((d) => { d.candidate.payloadTreeDigest = `sha256:${'b'.repeat(64)}`; }));
    assert.ok(codes(verify(p, a, { files }).problems).includes('assessment_wrong_candidate'));
  }));

  it('REGRESSION: an extra file beside the assessment → refused, not ignored', () => withAssessment({}, {}, (p, a) => {
    const files = tamper(a, (f) => f.set('notes.txt', Buffer.from('x')));
    assert.ok(codes(verify(p, a, { files }).problems).includes('assessment_unexpected_file'));
  }));

  it('REGRESSION: no assessment at all → "not performed is not passed"', () => withAssessment({}, {}, (p, a) => {
    assert.deepEqual(codes(verify(p, a, { files: new Map() }).problems), ['assessment_missing']);
  }));

  it('REGRESSION: collected more than 24 hours before the check → expired (measured from the START of collection)', () => withAssessment({}, {}, (p, a) => {
    const start = Date.parse(a.doc.startedAt);
    assert.deepEqual(verify(p, a, { now: new Date(start + 24 * 3_600_000 - 1000).toISOString() }).problems, []);
    assert.ok(codes(verify(p, a, { now: new Date(start + 24 * 3_600_000).toISOString() }).problems).includes('assessment_expired'));
  }));

  it('REGRESSION: an assessment that claims to have been decided in the future → time invalid', () => withAssessment({}, {}, (p, a) => {
    assert.ok(codes(verify(p, a, { now: '2026-09-26T08:00:00.000Z' }).problems).includes('assessment_time_invalid'));
  }));

  it('REGRESSION: collection times rewritten to move the window forward → the order check refuses', () => withAssessment({}, {}, (p, a) => {
    const files = tamper(a, editDoc((d) => { d.startedAt = '2026-09-26T09:20:00.000Z'; }));
    assert.ok(codes(verify(p, a, { files }).problems).includes('assessment_time_invalid'));
  }));
});
