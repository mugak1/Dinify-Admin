/**
 * CI-SIGNAL A-2 AT PROMOTION (the certification half is certification-obligations.test.mjs):
 * the fresh assessment gives both graphs provenance against the candidate's OWN retained locks and
 * asks GitHub when each advisory became reportable, and the privileged re-decision
 * re-reads that record offline. One clock: an obligation's deadline is part of the
 * assessment's deadline, so a deployment cannot outrun it.
 *
 * SYNTHETIC: the scanner's answers (cannedRunner) and GitHub's (cannedAdvisories), each at
 * its own seam. Everything else — git, the audit, certify, inspectCandidate, assess,
 * verifyAssessment, decideAdmission, verifyAdmission — is the real code.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ADVISORIES_FILE } from '../../dependency-audit/lib/advisories.mjs';
import { advisoryBody, cannedAdvisories, cannedRunner, CLEAN_SCANNER, fakeInstall, npmReport, via } from '../../dependency-audit/tests/project.mjs';
import { commitFacts, decideAdmission, verifyAdmission } from '../lib/admission.mjs';
import { ASSESSMENT_DOC, assess, assessmentDeadline, verifyAssessment } from '../lib/assessment.mjs';
import { inspectCandidate } from '../lib/certification.mjs';
import { loadReleasePolicy } from '../lib/common.mjs';
import { walkTree } from '../lib/tree.mjs';
import {
  EVAL_RUN_ID, NOW, RUN_ATTEMPT, RUN_ID, apiFacts, candidateFiles, certifiedProject, evaluatedProject, steppingClock, tempDir,
} from './fixtures.mjs';

const G = 'GHSA-aaaa-bbbb-cccc';
const TOOL = 'application:node_modules/tool';
/** The scanner's answer: one advisory on the TOOLING package `tool`. */
const toolAt = (severity) => ({ status: 1, stdout: npmReport({ tool: { via: [via('tool', severity, '>=0.0.0', G)], nodes: ['node_modules/tool'] } }) });
/** GitHub's record of G, reviewed on `day` (NOW is 2026-09-26T09:00Z). */
const reviewedOn = (day) => cannedAdvisories((id) => ({ status: 200, body: advisoryBody(id, { reviewed: `${day}T08:00:00Z`, published: `${day}T07:00:00Z` }) }), { authenticated: false });

/** The candidate inspected the way `prepare` inspects it, against the fixture's own git as the API. */
function evaluatedInspection(p) {
  const f = apiFacts(p);
  const facts = commitFacts({ target: p.commit, commit: f.commit, tree: f.tree }).facts;
  const { policy } = loadReleasePolicy(p.root);
  return inspectCandidate(candidateFiles(p.candidateDir), {
    policy, commit: p.commit, tree: facts.tree, inputBlobs: facts.inputBlobs, sourceDigest: facts.sourceDigest, runId: RUN_ID, runAttempt: RUN_ATTEMPT,
  });
}

function runAssess(p, { application, scanner = CLEAN_SCANNER, advisories }) {
  const inspection = evaluatedInspection(p);
  assert.deepEqual(inspection.problems, [], 'the candidate must inspect clean before it is assessed');
  const out = tempDir('assessment-');
  const replay = tempDir('replay-');
  const { doc } = assess({
    trustedRoot: p.root, inspection,
    candidate: { commit: p.commit, runId: RUN_ID, runAttempt: RUN_ATTEMPT, artifactId: '5550001', artifactDigest: `sha256:${'a'.repeat(64)}` },
    assessor: { workflowPath: '.github/workflows/deploy.yml', runId: EVAL_RUN_ID, runAttempt: '1', revision: p.commit },
    outDir: out.dir, replayDir: replay.dir, runner: cannedRunner({ application, scanner }), clock: steppingClock(NOW), installScanner: fakeInstall, advisories,
  });
  return { inspection, doc, outDir: out.dir, cleanup: () => { out.cleanup(); replay.cleanup(); } };
}

function verify(p, a, { now = '2026-09-26T09:30:00.000Z', files } = {}) {
  const auditPolicyBytes = readFileSync(join(p.root, 'dependency-audit', 'policy.json'));
  const { policy: releasePolicy } = loadReleasePolicy(p.root);
  return verifyAssessment(files ?? walkTree(a.outDir).files, {
    inspection: a.inspection, auditPolicy: JSON.parse(auditPolicyBytes), auditPolicyBytes,
    scannerManifest: readFileSync(join(p.root, 'dependency-audit', 'scanner', 'package.json')),
    scannerLock: readFileSync(join(p.root, 'dependency-audit', 'scanner', 'package-lock.json')),
    releasePolicy, now,
  });
}

const withAssessment = (assessOpts, fn) => {
  const p = certifiedProject({});
  const a = runAssess(p, assessOpts);
  try { return fn(p, a); } finally { a.cleanup(); p.cleanup(); }
};

describe('the fresh assessment: provenance against the candidate\'s own retained locks, dates from GitHub', () => {
  it('CONTRACT: an inherited HIGH tooling finding inside its window → obligations_pending; the privileged re-read reproduces it offline', () => withAssessment({ application: toolAt('high'), advisories: reviewedOn('2026-09-23') }, (p, a) => {
    assert.equal(a.doc.outcome, 'obligations_pending');
    assert.equal(a.doc.exitCode, 0);
    assert.deepEqual(a.doc.obligations, [{ advisory: G, path: TOOL, deadline: '2026-09-30' }]);
    assert.equal(a.doc.advisories.file, ADVISORIES_FILE);
    const v = verify(p, a);
    assert.deepEqual(v.problems, []);
  }));

  it('REGRESSION: the same high PAST its deadline → blocking, refused by the privileged re-decision', () => withAssessment({ application: toolAt('high'), advisories: reviewedOn('2026-09-19') }, (p, a) => {
    assert.equal(a.doc.outcome, 'blocking', 'deadline 2026-09-26 00:00 UTC; it is 09:00');
    assert.ok(verify(p, a).problems.some((x) => x.code === 'assessment_not_passing'));
  }));

  it('REGRESSION: an inherited CRITICAL → blocking at once', () => withAssessment({ application: toolAt('critical'), advisories: reviewedOn('2026-09-25') }, (p, a) => {
    assert.equal(a.doc.outcome, 'blocking');
    assert.equal('obligations' in a.doc, false);
  }));

  it('REGRESSION: no record from GitHub (an outage, a refusal) → no date → the inherited high blocks', () => withAssessment({ application: toolAt('high'), advisories: cannedAdvisories(() => ({ status: 0, error: 'timeout' })) }, (p, a) => {
    assert.equal(a.doc.outcome, 'blocking');
  }));

  it('CONTRACT: the obligation\'s deadline is part of the assessment\'s deadline — inside the window it cuts it short', () => withAssessment({ application: toolAt('high'), advisories: reviewedOn('2026-09-20') }, (p, a) => {
    const { policy } = loadReleasePolicy(p.root);
    assert.equal(new Date(assessmentDeadline(a.doc, policy)).toISOString(), '2026-09-27T00:00:00.000Z', 'not the window end, 2026-09-27T09:00Z');
    assert.deepEqual(verify(p, a, { now: '2026-09-26T23:59:59.000Z' }).problems, []);
    assert.ok(verify(p, a, { now: '2026-09-27T00:00:00.000Z' }).problems.some((x) => x.code === 'assessment_expired'));
  }));

  it('REGRESSION: a TAMPERED advisories.json is refused by the privileged re-decision', () => withAssessment({ application: toolAt('high'), advisories: reviewedOn('2026-09-23') }, (p, a) => {
    const files = new Map(walkTree(a.outDir).files);
    files.set(ADVISORIES_FILE, Buffer.from(files.get(ADVISORIES_FILE).toString('utf8').replace('2026-09-23T08', '2026-09-25T08')));
    assert.ok(verify(p, a, { files }).problems.some((x) => x.code === 'assessment_advisories_invalid'));
  }));

  it('REGRESSION: an assessment claiming a later deadline than the record supports is unreproducible', () => withAssessment({ application: toolAt('high'), advisories: reviewedOn('2026-09-23') }, (p, a) => {
    const files = new Map(walkTree(a.outDir).files);
    const doc = JSON.parse(files.get(ASSESSMENT_DOC).toString('utf8'));
    doc.obligations[0].deadline = '2026-10-30';
    files.set(ASSESSMENT_DOC, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`));
    assert.ok(verify(p, a, { files }).problems.some((x) => x.code === 'assessment_unreproducible'));
  }));

  it('CONTRACT: the SCANNER graph has provenance too — an unchanged bundled package\'s high inside its window → obligations_pending', () => {
    const scanner = { status: 1, stdout: npmReport({ bundled: { via: [via('bundled', 'high', '>=0.0.0', G)], nodes: ['node_modules/npm/node_modules/bundled'] }, npm: { severity: 'high', via: ['bundled'], nodes: ['node_modules/npm'] } }, 2) };
    withAssessment({ application: { status: 0, stdout: npmReport({}, 4) }, scanner, advisories: reviewedOn('2026-09-23') }, (p, a) => {
      assert.equal(a.doc.outcome, 'obligations_pending', JSON.stringify(a.doc.reasons));
      assert.deepEqual(a.doc.obligations.map((o) => o.path), ['scanner:node_modules/npm/node_modules/bundled']);
      assert.deepEqual(verify(p, a).problems, []);
    });
  });

  it('REGRESSION: a trusted scanner that moved since certification — a finding on a package the candidate\'s scanner lock does not hold — is introduced, and blocks', () => {
    const p = certifiedProject({});
    try {
      const lockPath = join(p.root, 'dependency-audit', 'scanner', 'package-lock.json');
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      lock.packages['node_modules/npm/node_modules/bundled'].version = '1.0.1';
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      writeFileSync(join(p.root, 'dependency-audit', 'scanner', 'node_modules', 'npm', 'node_modules', 'bundled', 'package.json'), JSON.stringify({ name: 'bundled', version: '1.0.1' }));
      const scanner = { status: 1, stdout: npmReport({ bundled: { via: [via('bundled', 'high', '>=0.0.0', G)], nodes: ['node_modules/npm/node_modules/bundled'] }, npm: { severity: 'high', via: ['bundled'], nodes: ['node_modules/npm'] } }, 2) };
      const a = runAssess(p, { application: { status: 0, stdout: npmReport({}, 4) }, scanner, advisories: reviewedOn('2026-09-23') });
      try {
        assert.equal(a.doc.outcome, 'blocking', JSON.stringify(a.doc.reasons));
      } finally { a.cleanup(); }
    } finally { p.cleanup(); }
  });
});

describe('admission: one clock at both decisions, and the obligation named', () => {
  it('CONTRACT: an inherited high inside its window is ADMITTED; the record names the obligation, and the deadline is its lapse', () => {
    const e = evaluatedProject({ assessAnswers: { application: toolAt('high') }, advisories: reviewedOn('2026-09-20') });
    try {
      assert.equal(e.assessment.outcome, 'obligations_pending');
      const d = decideAdmission(e.input());
      assert.equal(d.decision, 'admitted', JSON.stringify(d.reasons));
      assert.deepEqual(d.record.assessment.obligations, [{ advisory: G, path: TOOL, deadline: '2026-09-27' }]);
      assert.equal(d.record.assessment.deadline, '2026-09-27T00:00:00.000Z');
      // The privileged re-decision agrees, offline, with margin to spare …
      const admission = Buffer.from(JSON.stringify(d.record));
      assert.equal(verifyAdmission(admission, e.input(), { now: '2026-09-26T09:05:00.000Z', marginMinutes: 30 }).ok, true);
      // … and refuses once the obligation is less than the margin from falling due.
      const late = verifyAdmission(admission, e.input({ now: '2026-09-26T23:45:00.000Z' }), { now: '2026-09-26T23:45:00.000Z', marginMinutes: 30 });
      assert.equal(late.ok, false);
      assert.ok(late.reasons.some((r) => r.code === 'deadline_too_close'), JSON.stringify(late.reasons));
      // From the deadline on, it is not admitted at all.
      const expired = decideAdmission(e.input({ now: '2026-09-27T00:00:00.000Z' }));
      assert.equal(expired.decision, 'refused');
      assert.ok(expired.reasons.some((r) => r.code === 'assessment_expired'));
    } finally { e.cleanup(); }
  });

  it('REGRESSION: a critical is REFUSED', () => {
    const e = evaluatedProject({ assessAnswers: { application: toolAt('critical') }, advisories: reviewedOn('2026-09-25') });
    try {
      const d = decideAdmission(e.input());
      assert.equal(d.decision, 'refused');
      assert.ok(d.reasons.some((r) => r.code === 'assessment_not_passing'));
    } finally { e.cleanup(); }
  });

  it('CONTROL: an assessment with no obligation names none, and keeps the window it always had', () => {
    const e = evaluatedProject({});
    try {
      const d = decideAdmission(e.input());
      assert.equal(d.decision, 'admitted', JSON.stringify(d.reasons));
      assert.equal('obligations' in d.record.assessment, false);
      assert.equal(d.record.assessment.deadline, '2026-09-27T09:00:00.000Z');
    } finally { e.cleanup(); }
  });
});
