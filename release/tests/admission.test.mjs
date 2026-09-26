/**
 * ADMISSION — which run, which artifact, which assessment, decided twice.
 *
 * The decision is the REAL `decideAdmission` over a REAL certified and assessed candidate.
 * The GitHub facts (run, artifact listing, commit and tree) are MODELLED as the JSON the
 * API returns — built from the fixture's own git objects, so the digests are real and only
 * the ids and the listing are invented.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ADMISSION_SCHEMA, bindingsOf, commitFacts, decideAdmission, selectCertification, verifyAdmission } from '../lib/admission.mjs';
import { recordBytes } from '../lib/common.mjs';
import { readArchive, writeArchive } from '../lib/tar.mjs';
import { describeFiles } from '../lib/tree.mjs';
import { EVAL_RUN_ID, NOW, RUN_ID, apiFacts, certifiedProject, evaluatedProject, trustedOf } from './fixtures.mjs';

const codes = (problems) => problems.map((p) => p.code);
const MARGIN = 30;

const withEvaluated = (opts, fn) => { const p = evaluatedProject(opts); try { return fn(p); } finally { p.cleanup(); } };

describe('selecting the certification: exactly one run, one attempt, one artifact', () => {
  const withFacts = (fn) => { const p = certifiedProject(); try { return fn(p); } finally { p.cleanup(); } };
  const select = (p, policy, over = {}) => {
    const f = apiFacts(p, over);
    return selectCertification({ policy, target: p.commit, ciWorkflow: f.ciWorkflow, run: f.run, artifacts: over.artifacts ?? f.artifacts });
  };
  const policyOf = (p) => JSON.parse(trustedOf(p.root).releasePolicyBytes);

  it('CONTROL: a successful push-to-main run of ci.yml with its own candidate is selected by id and digest', () => withFacts((p) => {
    const s = select(p, policyOf(p));
    assert.deepEqual(s.problems, []);
    assert.equal(s.selection.runId, RUN_ID);
    assert.equal(s.selection.artifact.id, '5550001');
    assert.equal(s.selection.artifact.name, `admin-candidate-${RUN_ID}-1`);
    assert.equal(s.selection.artifact.digest, `sha256:${'a'.repeat(64)}`);
  }));

  const cases = [
    ['a run of another workflow that happens to share the display name "CI"', { run: { workflow_id: 99 } }, 'certification_wrong_workflow'],
    ['a run whose file is not ci.yml', { run: { path: '.github/workflows/ci-copy.yml' } }, 'certification_wrong_workflow'],
    ['a PULL REQUEST run (a merge preview, never the landed commit)', { run: { event: 'pull_request' } }, 'certification_wrong_event'],
    ['a push to another branch', { run: { head_branch: 'feature' } }, 'certification_wrong_event'],
    ['a run for another commit', { run: { head_sha: 'f'.repeat(40) } }, 'certification_wrong_commit'],
    ['a failed run', { run: { conclusion: 'failure' } }, 'certification_not_successful'],
    ['a run still in progress', { run: { status: 'in_progress', conclusion: null } }, 'certification_not_successful'],
    ['an expired candidate', { artifact: { expired: true } }, 'certification_expired'],
    ['a candidate with no digest in the listing', { artifact: { digest: null } }, 'certification_listing_incomplete'],
    ['a candidate the listing attributes to another run', { artifact: { workflow_run: { id: 1, head_sha: 'f'.repeat(40) } } }, 'certification_wrong_run'],
  ];
  for (const [label, over, code] of cases) {
    it(`REGRESSION MATRIX: ${label} → ${code}`, () => withFacts((p) => {
      const s = select(p, policyOf(p), over);
      assert.equal(s.selection, null);
      assert.ok(codes(s.problems).includes(code), JSON.stringify(s.problems));
    }));
  }

  it('REGRESSION: a RE-RUN (attempt 2) whose own candidate is absent is not satisfied by attempt 1\'s artifact', () => withFacts((p) => {
    const s = select(p, policyOf(p), { run: { run_attempt: 2 }, artifact: { name: `admin-candidate-${RUN_ID}-1` } });
    assert.deepEqual(codes(s.problems), ['certification_no_candidate']);
    assert.match(s.problems[0].detail, /admin-candidate-4200000001-1/);
    assert.match(s.problems[0].detail, /not eligible/);
  }));

  it('REGRESSION: two artifacts with the candidate\'s name → ambiguous, never "the first"', () => withFacts((p) => {
    const f = apiFacts(p);
    const twin = { ...f.artifacts.artifacts[0], id: 5550002 };
    const s = select(p, policyOf(p), { artifacts: { total_count: 2, artifacts: [f.artifacts.artifacts[0], twin] } });
    assert.deepEqual(codes(s.problems), ['certification_ambiguous']);
  }));

  it('REGRESSION: a truncated listing (total_count larger than what was returned) cannot prove which candidate exists', () => withFacts((p) => {
    const f = apiFacts(p);
    const s = select(p, policyOf(p), { artifacts: { total_count: 150, artifacts: f.artifacts.artifacts } });
    assert.deepEqual(codes(s.problems), ['certification_listing_incomplete']);
  }));
});

describe('the target commit as git holds it', () => {
  it('CONTROL: a commit carrying release/policy.json has the contract, and its certified inputs are named by blob', () => {
    const p = certifiedProject();
    try {
      const f = apiFacts(p);
      const c = commitFacts({ target: p.commit, commit: f.commit, tree: f.tree });
      assert.equal(c.facts.hasContract, true);
      assert.match(c.facts.inputBlobs['package-lock.json'], /^[0-9a-f]{40}$/);
    } finally { p.cleanup(); }
  });

  it('REGRESSION: a truncated tree listing is unreadable, not "has no contract"', () => {
    const p = certifiedProject();
    try {
      const f = apiFacts(p);
      assert.deepEqual(codes(commitFacts({ target: p.commit, commit: f.commit, tree: { ...f.tree, truncated: true } }).problems), ['commit_unreadable']);
      assert.deepEqual(codes(commitFacts({ target: p.commit, commit: { ...f.commit, sha: 'f'.repeat(40) }, tree: f.tree }).problems), ['commit_unreadable']);
    } finally { p.cleanup(); }
  });
});

describe('the decision', () => {
  it('CONTROL: a certified, freshly assessed candidate is admitted, and the record binds every identity', () => withEvaluated({}, (p) => {
    const d = decideAdmission(p.input());
    assert.deepEqual(d.reasons, []);
    assert.equal(d.decision, 'admitted');
    const r = d.record;
    assert.equal(r.schema, ADMISSION_SCHEMA);
    assert.equal(r.certification.runId, RUN_ID);
    assert.equal(r.certification.artifact.id, '5550001');
    assert.equal(r.certification.recordDigest, p.inspection.recordDigest);
    assert.equal(r.payload.treeDigest, p.inspection.payload.treeDigest);
    assert.equal(r.payload.archiveSha256, p.inspection.payload.archiveSha256);
    assert.equal(r.payload.entries.length, r.payload.entryCount);
    assert.equal(r.assessment.startedAt, p.assessment.startedAt);
    assert.equal(r.assessment.deadline, new Date(Date.parse(p.assessment.startedAt) + 24 * 3_600_000).toISOString());
    assert.equal(r.evaluation.runId, EVAL_RUN_ID);
    assert.deepEqual(r.trusted.trees, trustedOf(p.root).trees);
    // Three identities, kept apart: the payload tree, the payload archive, the artifact zip.
    assert.notEqual(r.payload.treeDigest.slice(7), r.payload.archiveSha256);
    assert.notEqual(r.payload.archiveSha256, r.certification.artifact.digest.slice(7));
  }));

  it('CONTRACT: the record carries no dependency report, inventory or raw scanner output — it is bounded', () => withEvaluated({}, (p) => {
    const text = recordBytes(decideAdmission(p.input()).record).toString();
    assert.doesNotMatch(text, /auditReportVersion|node_modules\/shipped|sha512-/);
    assert.ok(text.length < 32_000, `${text.length} bytes`);
  }));

  it('REGRESSION: a target that predates the contract cannot be DEPLOYED — a rebuild is not a certified candidate', () => withEvaluated({}, (p) => {
    const d = decideAdmission(p.input({ mode: 'deploy', source: 'manual', commit: { ...p.commitFacts, hasContract: false } }));
    assert.equal(d.decision, 'refused');
    assert.deepEqual(codes(d.reasons), ['pre_contract_target']);
  }));

  it('CONTRACT: rolling BACK to a pre-contract release is preserved, and is labelled NOT certified and NOT assessed', () => withEvaluated({}, (p) => {
    const d = decideAdmission(p.input({ mode: 'rollback', source: 'manual', commit: { ...p.commitFacts, hasContract: false }, candidateFiles: new Map(), assessmentFiles: new Map() }));
    assert.equal(d.decision, 'legacy');
    assert.equal(d.kind, 'legacy-rollback');
    assert.equal(d.record.certified, false);
    assert.equal(d.record.assessed, false);
  }));

  it('REGRESSION: an automatic run may only deploy', () => withEvaluated({}, (p) => {
    assert.ok(codes(decideAdmission(p.input({ mode: 'rollback', source: 'automatic' })).reasons).includes('mode_invalid'));
  }));

  it('REGRESSION: the verifier or policy moved on main after this evaluation began → a new evaluation is required', () => withEvaluated({}, (p) => {
    const t = trustedOf(p.root, { mainTrees: { release: 'b'.repeat(40), 'dependency-audit': trustedOf(p.root).trees['dependency-audit'] } });
    const d = decideAdmission(p.input({ trusted: t }));
    assert.deepEqual(codes(d.reasons), ['policy_advanced']);
  }));

  it('REGRESSION: an assessment performed by ANOTHER evaluation (run, attempt or revision) is not this one\'s', () => withEvaluated({}, (p) => {
    assert.ok(codes(decideAdmission(p.input({ evaluation: { runId: '4200000100', runAttempt: '1' } })).reasons).includes('assessment_not_current'));
    assert.ok(codes(decideAdmission(p.input({ evaluation: { runId: EVAL_RUN_ID, runAttempt: '2' } })).reasons).includes('assessment_not_current'));
    const moved = { ...trustedOf(p.root), revision: 'c'.repeat(40) };
    assert.ok(codes(decideAdmission(p.input({ trusted: moved })).reasons).includes('assessment_not_current'));
  }));

  it('REGRESSION: an assessment of another artifact (same commit, different upload) is refused', () => withEvaluated({}, (p) => {
    const f = apiFacts(p, { artifact: { id: 5550009 } });
    const d = decideAdmission(p.input({ certification: { ciWorkflow: f.ciWorkflow, run: f.run, artifacts: f.artifacts } }));
    assert.ok(codes(d.reasons).includes('assessment_wrong_candidate'));
  }));

  it('REGRESSION: no fresh assessment → refused ("not performed is not passed")', () => withEvaluated({}, (p) => {
    assert.deepEqual(codes(decideAdmission(p.input({ assessmentFiles: new Map() })).reasons), ['assessment_missing']);
  }));

  it('REGRESSION: a fresh assessment that now BLOCKS refuses a candidate certification passed', () => withEvaluated({
    assessAnswers: { application: { status: 1, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: { shipped: { name: 'shipped', severity: 'critical', via: [{ source: 1, name: 'shipped', dependency: 'shipped', title: 't', url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx', severity: 'critical', cwe: [], cvss: {}, range: '<3.0.0' }], nodes: ['node_modules/shipped'] } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 }, dependencies: { prod: 1, dev: 3, optional: 1, peer: 0, peerOptional: 0, total: 4 } } }) } },
  }, (p) => {
    const d = decideAdmission(p.input());
    assert.equal(d.decision, 'refused');
    assert.ok(codes(d.reasons).includes('assessment_not_passing'));
  }));

  it('REGRESSION: a same-SHA candidate whose payload was SUBSTITUTED after certification is refused before any assessment is consulted', () => withEvaluated({}, (p) => {
    const files = new Map(p.input().candidateFiles);
    const payload = readArchive(files.get('payload.tar.gz')).files;
    payload.set('main-AAAA1111.js', Buffer.from('console.log("not what was certified");\n'));
    files.set('payload.tar.gz', writeArchive(payload));
    const d = decideAdmission(p.input({ candidateFiles: files }));
    assert.equal(d.decision, 'refused');
    assert.ok(codes(d.reasons).includes('candidate_altered') || codes(d.reasons).includes('payload_altered'));
    assert.notEqual(describeFiles(payload).treeDigest, p.inspection.payload.treeDigest);
  }));
});

describe('the privileged job decides again, over its own facts', () => {
  const later = (p, minutes) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it('CONTROL: its decision agrees with the uploaded admission, and only bounded values leave for the host', () => withEvaluated({}, (p) => {
    const uploaded = decideAdmission(p.input()).record;
    const { now, ...input } = p.input();
    const v = verifyAdmission(recordBytes(uploaded), input, { now: later(p, 20), marginMinutes: MARGIN });
    assert.deepEqual(v.reasons, []);
    assert.equal(v.verified.kind, 'certified');
    assert.equal(`sha256:${v.verified.payloadTree}`, p.inspection.payload.treeDigest);
    assert.equal(v.verified.archiveSha256, p.inspection.payload.archiveSha256);
    assert.equal(Number(v.verified.deadlineEpoch), Math.floor(Date.parse(uploaded.assessment.deadline) / 1000));
    assert.match(v.verified.indexSha256, /^[0-9a-f]{64}$/);
  }));

  it('REGRESSION: an uploaded admission rewritten to name another payload → the two decisions disagree', () => withEvaluated({}, (p) => {
    const uploaded = decideAdmission(p.input()).record;
    uploaded.payload.treeDigest = `sha256:${'d'.repeat(64)}`;
    const { now, ...input } = p.input();
    assert.deepEqual(codes(verifyAdmission(recordBytes(uploaded), input, { now: later(p, 20), marginMinutes: MARGIN }).reasons), ['admission_disagrees']);
  }));

  it('REGRESSION: the privileged job received DIFFERENT candidate bytes than prepare evaluated → refused before any credential', () => withEvaluated({}, (p) => {
    const uploaded = decideAdmission(p.input()).record;
    const files = new Map(p.input().candidateFiles);
    files.set('certification.json', Buffer.concat([files.get('certification.json'), Buffer.from(' ')]));
    const { now, ...input } = p.input({ candidateFiles: files });
    const v = verifyAdmission(recordBytes(uploaded), input, { now: later(p, 20), marginMinutes: MARGIN });
    assert.equal(v.ok, false);
    assert.ok(v.reasons.length > 0);
  }));

  it('REGRESSION: prepare REFUSED → the privileged job does not re-litigate it', () => withEvaluated({}, (p) => {
    const refused = decideAdmission(p.input({ assessmentFiles: new Map() })).record;
    const { now, ...input } = p.input();
    assert.deepEqual(codes(verifyAdmission(recordBytes(refused), input, { now: later(p, 20), marginMinutes: MARGIN }).reasons), ['admission_refused']);
  }));

  it('REGRESSION: a queue long enough that the deadline is inside the margin → refused, a new evaluation is required', () => withEvaluated({}, (p) => {
    const uploaded = decideAdmission(p.input()).record;
    const { now, ...input } = p.input();
    const deadline = Date.parse(uploaded.assessment.deadline);
    const at = (ms) => verifyAdmission(recordBytes(uploaded), input, { now: new Date(ms).toISOString(), marginMinutes: MARGIN });
    assert.equal(at(deadline - MARGIN * 60_000).ok, true, 'exactly the margin is enough');
    assert.deepEqual(codes(at(deadline - MARGIN * 60_000 + 1000).reasons), ['deadline_too_close']);
    assert.ok(codes(at(deadline + 1000).reasons).includes('assessment_expired'));
  }));

  it('REGRESSION: an admission for another target or mode is not this dispatch\'s', () => withEvaluated({}, (p) => {
    const uploaded = decideAdmission(p.input()).record;
    const { now, ...input } = p.input({ source: 'manual' });
    assert.deepEqual(codes(verifyAdmission(recordBytes(uploaded), input, { now: later(p, 20), marginMinutes: MARGIN }).reasons), ['admission_disagrees']);
  }));

  it('CONTRACT: a legacy rollback verifies as LEGACY with no payload identity and no deadline — never as certified', () => withEvaluated({}, (p) => {
    const over = { mode: 'rollback', source: 'manual', commit: { ...p.commitFacts, hasContract: false }, candidateFiles: new Map(), assessmentFiles: new Map() };
    const uploaded = decideAdmission(p.input(over)).record;
    const { now, ...input } = p.input(over);
    const v = verifyAdmission(recordBytes(uploaded), input, { now: later(p, 20), marginMinutes: MARGIN });
    assert.deepEqual(v.verified, { kind: 'legacy', target: p.commit, mode: 'rollback', payloadTree: '', archiveSha256: '', indexSha256: '', deadlineEpoch: '0' });
  }));

  it('CONTRACT: the bindings compared are everything but when it was decided and the reasons', () => withEvaluated({}, (p) => {
    const r = decideAdmission(p.input()).record;
    assert.deepEqual(Object.keys(bindingsOf(r)).sort(), ['assessment', 'certification', 'decision', 'evaluation', 'kind', 'mode', 'payload', 'schema', 'source', 'target', 'trusted']);
  }));
});
