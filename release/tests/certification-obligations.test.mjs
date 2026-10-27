/**
 * CI-SIGNAL A-2 AT CERTIFICATION: a `validate` run audited against its base may pass with a
 * DATED OBLIGATION. The candidate then retains the audit's advisory record, and
 * inspectCandidate — run by `prepare` and again by the privileged `verify` — reproduces the
 * decision with provenance against the candidate's own retained locks and the dates from
 * that record, never asking GitHub. A certification without a base is unchanged.
 *
 * SYNTHETIC: the scanner's answer and GitHub's, each at its own seam. Real: git, the audit,
 * certify and inspectCandidate.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ADVISORIES_FILE } from '../../dependency-audit/lib/advisories.mjs';
import { advisoryBody, cannedAdvisories, npmReport, via } from '../../dependency-audit/tests/project.mjs';
import { commitFacts } from '../lib/admission.mjs';
import { inspectCandidate } from '../lib/certification.mjs';
import { loadReleasePolicy } from '../lib/common.mjs';
import { RUN_ATTEMPT, RUN_ID, apiFacts, candidateFiles, certifiedProject } from './fixtures.mjs';

const G = 'GHSA-aaaa-bbbb-cccc';
const toolAt = (severity) => ({ status: 1, stdout: npmReport({ tool: { via: [via('tool', severity, '>=0.0.0', G)], nodes: ['node_modules/tool'] } }) });
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

describe('certification: an obligation at certification is retained and re-read, never re-asked', () => {
  const certifiedWithObligation = () => certifiedProject({ withBase: true, answers: { application: toolAt('high') }, advisories: reviewedOn('2026-09-23') });

  it('CONTRACT: certified against its base, the candidate carries the advisory record and inspects clean — reproduced as obligations_pending', () => {
    const p = certifiedWithObligation();
    try {
      assert.equal(p.stages.audit.outcome, 'obligations_pending');
      assert.equal(p.stages.certify.ok, true, JSON.stringify(p.stages.certify.problems));
      const files = candidateFiles(p.candidateDir);
      assert.ok(files.has(`evidence/audit/${ADVISORIES_FILE}`));
      const inspection = evaluatedInspection(p);
      assert.deepEqual(inspection.problems, []);
      assert.equal(inspection.audit.outcome, 'obligations_pending');
      assert.equal(inspection.audit.counts.deferred, 1);
    } finally { p.cleanup(); }
  });

  it('REGRESSION: the retained advisory record altered → the candidate is refused', () => {
    const p = certifiedWithObligation();
    try {
      const path = join(p.candidateDir, 'evidence', 'audit', ADVISORIES_FILE);
      writeFileSync(path, readFileSync(path, 'utf8').replace('"authenticated": false', '"authenticated": true'));
      assert.ok(evaluatedInspection(p).problems.some((x) => x.code === 'candidate_altered'));
    } finally { p.cleanup(); }
  });

  it('CONTROL: a certification without a base retains no advisory record and inspects exactly as before A-2', () => {
    const p = certifiedProject({ answers: { application: toolAt('moderate') } });
    try {
      assert.equal(candidateFiles(p.candidateDir).has(`evidence/audit/${ADVISORIES_FILE}`), false);
      const inspection = evaluatedInspection(p);
      assert.deepEqual(inspection.problems, []);
      assert.equal('deferred' in inspection.audit.counts, false);
    } finally { p.cleanup(); }
  });
});
