/**
 * CERTIFICATION — the candidate is what `validate` built and checked, or there is none.
 *
 * Producer half: the REAL prebuild → freeze → audit → certify sequence over a disposable
 * project, interfered with at exactly one boundary per case. Consumer half: the REAL
 * inspection of the resulting candidate against facts from outside it (git objects, and
 * the run and artifact listing as the API would state them — MODELLED).
 */

import { strict as assert } from 'node:assert';
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { npmReport, via } from '../../dependency-audit/tests/project.mjs';
import { freeze, inspectCandidate, prebuild } from '../lib/certification.mjs';
import { loadReleasePolicy } from '../lib/common.mjs';
import { writeArchive, readArchive } from '../lib/tar.mjs';
import { describeFiles, sha256Hex } from '../lib/tree.mjs';
import { BUILT, NOW, RUN_ATTEMPT, RUN_ID, apiFacts, candidateFiles, certifiedProject, copyCandidate, freshProject, git, writeBuild } from './fixtures.mjs';

const codes = (problems) => problems.map((p) => p.code);

function expectFor(p, over = {}) {
  const f = apiFacts(p);
  const { policy } = loadReleasePolicy(p.root);
  const inputBlobs = Object.fromEntries(f.tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  return { policy, commit: p.commit, tree: f.commit.tree.sha, inputBlobs, runId: RUN_ID, runAttempt: RUN_ATTEMPT, ...over };
}

const withProject = (opts, fn) => { const p = certifiedProject(opts); try { return fn(p); } finally { p.cleanup(); } };

describe('the producer: only a job whose gates all passed yields a candidate', () => {
  it('CONTROL: a clean build, a clean audit and a push-to-main context produce a candidate that inspects clean', () => withProject({}, (p) => {
    assert.deepEqual(p.stages.certify.problems, []);
    const r = p.stages.certify.record;
    assert.equal(r.commit, p.commit);
    assert.equal(r.workflow.runId, RUN_ID);
    assert.equal(r.workflow.event, 'push');
    const ins = inspectCandidate(candidateFiles(p.candidateDir), expectFor(p));
    assert.deepEqual(ins.problems, []);
    assert.equal(ins.audit.outcome, 'within_policy');
  }));

  it('CONTRACT: the payload is exactly the built output plus release.txt (the commit, one line) — nothing from the evidence', () => withProject({}, (p) => {
    const payload = readArchive(readFileSync(join(p.candidateDir, 'payload.tar.gz'))).files;
    assert.deepEqual([...payload.keys()].sort(), [...Object.keys(BUILT), 'release.txt'].sort());
    assert.equal(payload.get('release.txt').toString(), `${p.commit}\n`);
    for (const [path, text] of Object.entries(BUILT)) assert.equal(payload.get(path).toString(), text);
  }));

  it('CONTRACT: the evidence travels BESIDE the payload, never inside it — no dependency report reaches the webroot', () => withProject({}, (p) => {
    const payload = readArchive(readFileSync(join(p.candidateDir, 'payload.tar.gz'))).files;
    for (const path of payload.keys()) assert.doesNotMatch(path, /scanner|snapshot|collection|result|package(-lock)?\.json|policy|certification/);
    const files = candidateFiles(p.candidateDir);
    assert.ok(files.has('evidence/audit/application.scanner-stdout.txt'));
    assert.ok(files.has('certification.json'));
  }));

  it('REGRESSION MATRIX: a build output that exists before the build (stale, from elsewhere) is refused at prebuild', () => {
    const q = freshProject();
    try {
      mkdirSync(join(q.root, 'dist'), { recursive: true });
      writeFileSync(join(q.root, 'dist', 'index.html'), 'built somewhere else');
      const r = prebuild(q.root, { now: NOW });
      assert.equal(r.ok, false);
      assert.ok(codes(r.problems).includes('stale_output'));
    } finally { q.cleanup(); }
  });

  it('REGRESSION (found by CI): the empty dist/test-out/ Karma leaves behind does not block certification, and is recorded', () => {
    const q = freshProject();
    try {
      mkdirSync(join(q.root, 'dist', 'test-out'), { recursive: true });
      const r = prebuild(q.root, { now: NOW });
      assert.deepEqual(r.problems, []);
      assert.deepEqual(JSON.parse(readFileSync(join(q.root, 'release', '.work', 'continuity.json'), 'utf8')).emptyDirectoriesBeforeBuild, ['test-out']);
    } finally { q.cleanup(); }
  });

  it('REGRESSION MATRIX: a single file anywhere under an otherwise empty output tree, or a link, is still refused', () => {
    for (const plant of [
      (root) => { mkdirSync(join(root, 'dist', 'test-out', 'a1b2'), { recursive: true }); writeFileSync(join(root, 'dist', 'test-out', 'a1b2', 'main.js'), 'left behind'); },
      (root) => { mkdirSync(join(root, 'dist'), { recursive: true }); symlinkSync('/etc', join(root, 'dist', 'etc')); },
    ]) {
      const q = freshProject();
      try {
        plant(q.root);
        const r = prebuild(q.root, { now: NOW });
        assert.equal(r.ok, false);
        assert.ok(codes(r.problems).includes('stale_output'));
      } finally { q.cleanup(); }
    }
  });

  it('REGRESSION MATRIX: freeze or certify without the prebuild that opened the chain is refused', () => {
    const q = freshProject();
    try {
      writeBuild(q.root);
      assert.ok(codes(freeze(q.root, { now: NOW }).problems).includes('continuity_missing'));
    } finally { q.cleanup(); }
  });

  it('REGRESSION MATRIX: the installed inventory moves during the build → freeze refuses and no candidate exists', () => withProject({
    between: { afterBuild: (p) => writeFileSync(join(p.root, 'node_modules', 'intruder', 'package.json'), (mkdirSync(join(p.root, 'node_modules', 'intruder'), { recursive: true }), '{"name":"intruder","version":"6.6.6"}')) },
  }, (p) => {
    assert.equal(p.stages.freeze.ok, false);
    assert.ok(codes(p.stages.freeze.problems).includes('inventory_moved'), JSON.stringify(p.stages.freeze.problems));
    assert.equal(p.stages.certify.ok, false);
  }));

  it('REGRESSION MATRIX: the installed inventory moves after the audit → certify refuses', () => withProject({
    between: { afterAudit: (p) => writeFileSync(join(p.root, 'node_modules', 'shipped', 'package.json'), '{"name":"shipped","version":"2.0.1"}') },
  }, (p) => {
    assert.equal(p.stages.certify.ok, false);
    assert.ok(codes(p.stages.certify.problems).includes('inventory_moved'));
  }));

  it('REGRESSION MATRIX: the output changes after the mock-isolation gate scanned it → certify refuses (stale or substituted output)', () => withProject({
    between: { afterFreeze: (p) => appendFileSync(join(p.root, 'dist', 'main-AAAA1111.js'), '\n/* changed after the scan */') },
  }, (p) => {
    assert.equal(p.stages.certify.ok, false);
    assert.ok(codes(p.stages.certify.problems).includes('output_moved'));
  }));

  it('REGRESSION MATRIX: a blocking audit yields NO candidate — every gate must have passed', () => withProject({
    answers: { application: { status: 1, stdout: npmReport({ shipped: { severity: 'high', via: [via('shipped', 'high', '<3.0.0')], nodes: ['node_modules/shipped'] } }) } },
  }, (p) => {
    assert.equal(p.stages.audit.outcome, 'blocking');
    assert.equal(p.stages.certify.ok, false);
    assert.ok(codes(p.stages.certify.problems).includes('audit_not_passing'));
  }));

  it('REGRESSION MATRIX: an incomplete audit (a scanner that answered nothing) yields no candidate', () => withProject({
    answers: { application: { status: 1, stdout: '' } },
  }, (p) => {
    assert.equal(p.stages.audit.outcome, 'incomplete');
    assert.ok(codes(p.stages.certify.problems).includes('audit_not_passing'));
  }));

  it('REGRESSION MATRIX: a "clean" result whose raw scanner output is gone cannot certify', () => withProject({
    between: { afterAudit: (p) => rmSync(join(p.evidence, 'application.scanner-stdout.txt')) },
  }, (p) => {
    assert.ok(codes(p.stages.certify.problems).includes('audit_evidence_missing'));
  }));

  it('REGRESSION MATRIX: a result edited to within-policy over raw output that says blocking is not reproducible and cannot certify', () => withProject({
    answers: { application: { status: 1, stdout: npmReport({ shipped: { severity: 'high', via: [via('shipped', 'high', '<3.0.0')], nodes: ['node_modules/shipped'] } }) } },
    between: {
      afterAudit: (p) => {
        const path = join(p.evidence, 'result.json');
        const doc = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify({ ...doc, outcome: 'within_policy', exitCode: 0 }));
      },
    },
  }, (p) => {
    assert.equal(p.stages.certify.ok, false);
    assert.ok(codes(p.stages.certify.problems).includes('audit_unreproducible'), JSON.stringify(p.stages.certify.problems));
  }));

  it('REGRESSION MATRIX: evidence from another checkout (the commit moved after prebuild) cannot certify this one', () => withProject({
    between: { afterAudit: (p) => { writeFileSync(join(p.root, 'README.md'), 'moved'); git(p.root, 'add', '-A'); git(p.root, 'commit', '-q', '-m', 'moved'); } },
  }, (p) => {
    assert.equal(p.stages.certify.ok, false);
    assert.ok(codes(p.stages.certify.problems).some((c) => ['continuity_broken', 'inventory_moved'].includes(c)), JSON.stringify(p.stages.certify.problems));
  }));

  it('REGRESSION MATRIX: no GitHub Actions run context → no candidate (a local build is never a certification)', () => withProject({ env: { GITHUB_RUN_ID: '' } }, (p) => {
    assert.ok(codes(p.stages.certify.problems).includes('no_workflow_context'));
  }));
});

describe('the consumer: a candidate cannot vouch for itself', () => {
  const inspectWith = (p, over = {}, edit) => {
    if (!edit) return inspectCandidate(candidateFiles(p.candidateDir), expectFor(p, over));
    const c = copyCandidate(p.candidateDir, edit);
    try { return inspectCandidate(candidateFiles(c.dir), expectFor(p, over)); } finally { c.cleanup(); }
  };

  it('REGRESSION MATRIX: a pull-request candidate is produced but never promotable', () => withProject({ env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' } }, (p) => {
    assert.equal(p.stages.certify.ok, true, 'PR validation exercises the whole mechanism');
    assert.ok(codes(inspectWith(p).problems).includes('wrong_event'));
  }));

  for (const [label, over, code] of [
    ['another run', { runId: '4200000002' }, 'wrong_run'],
    ['another attempt of the same run', { runAttempt: '2' }, 'wrong_attempt'],
    ['another commit', { commit: 'f'.repeat(40) }, 'wrong_commit'],
    ['another tree', { tree: 'e'.repeat(40) }, 'wrong_tree'],
  ]) {
    it(`REGRESSION MATRIX: a candidate certified for ${label} is refused`, () => withProject({}, (p) => {
      assert.ok(codes(inspectWith(p, over).problems).includes(code));
    }));
  }

  it('REGRESSION MATRIX: another repository or build configuration is refused', () => withProject({}, (p) => {
    const e = expectFor(p);
    assert.ok(codes(inspectCandidate(candidateFiles(p.candidateDir), { ...e, policy: { ...e.policy, repository: 'mugak1/Other' } }).problems).includes('wrong_repository'));
    assert.ok(codes(inspectCandidate(candidateFiles(p.candidateDir), { ...e, policy: { ...e.policy, build: { ...e.policy.build, configuration: 'development' } } }).problems).includes('wrong_configuration'));
  }));

  it('REGRESSION MATRIX: retained inputs that are not the commit\'s (a lockfile from elsewhere) are refused', () => withProject({}, (p) => {
    const e = expectFor(p);
    const r = inspectCandidate(candidateFiles(p.candidateDir), { ...e, inputBlobs: { ...e.inputBlobs, 'package-lock.json': '0'.repeat(40) } });
    assert.ok(codes(r.problems).includes('wrong_inputs'));
  }));

  it('REGRESSION MATRIX: SAME SHA, DIFFERENT BYTES — a substituted payload with an honest release.txt is refused', () => withProject({}, (p) => {
    const r = inspectWith(p, {}, (dir) => {
      const files = readArchive(readFileSync(join(dir, 'payload.tar.gz'))).files;
      files.set('main-AAAA1111.js', Buffer.from('console.log("substituted");\n'));
      writeFileSync(join(dir, 'payload.tar.gz'), writeArchive(files));
    });
    assert.ok(codes(r.problems).includes('payload_altered'));
  }));

  it('REGRESSION MATRIX: a substituted payload WITH a rewritten record still fails — the record no longer matches the evidence tree and the frozen scan', () => withProject({}, (p) => {
    const r = inspectWith(p, {}, (dir) => {
      const files = readArchive(readFileSync(join(dir, 'payload.tar.gz'))).files;
      files.set('main-AAAA1111.js', Buffer.from('console.log("substituted");\n'));
      const archive = writeArchive(files);
      writeFileSync(join(dir, 'payload.tar.gz'), archive);
      const rec = JSON.parse(readFileSync(join(dir, 'certification.json'), 'utf8'));
      const d = describeFiles(files);
      rec.payload = { ...rec.payload, treeDigest: d.treeDigest, entries: d.entries, archive: { ...rec.payload.archive, sha256: sha256Hex(archive), bytes: archive.length } };
      writeFileSync(join(dir, 'certification.json'), JSON.stringify(rec));
    });
    assert.ok(codes(r.problems).includes('payload_altered'), JSON.stringify(r.problems));
  }));

  it('REGRESSION MATRIX: an unlisted file, a missing file and an altered evidence file are each refused', () => withProject({}, (p) => {
    assert.ok(codes(inspectWith(p, {}, (d) => writeFileSync(join(d, 'extra.js'), 'x')).problems).includes('candidate_unexpected_file'));
    assert.ok(codes(inspectWith(p, {}, (d) => rmSync(join(d, 'evidence', 'audit', 'result.json'))).problems).includes('candidate_file_missing'));
    assert.ok(codes(inspectWith(p, {}, (d) => appendFileSync(join(d, 'evidence', 'audit', 'application.scanner-stdout.txt'), ' ')).problems).includes('candidate_altered'));
  }));

  it('REGRESSION MATRIX: a record claiming within-policy over retained raw output that says blocking is caught by reproduction', () => withProject({
    answers: { application: { status: 1, stdout: npmReport({ tool: { severity: 'moderate', via: [via('tool', 'moderate', '<2.0.0')], nodes: ['node_modules/tool'] } }) } },
  }, (p) => {
    // Certified (a lower-severity tooling finding is triage, not blocking) — now forge the raw
    // output to say something else and every digest to match it.
    assert.ok(p.stages.certify.ok, JSON.stringify(p.stages.certify.problems));
    const r = inspectWith(p, {}, (dir) => {
      const raw = join(dir, 'evidence', 'audit', 'application.scanner-stdout.txt');
      const forged = npmReport({ shipped: { severity: 'critical', via: [via('shipped', 'critical', '<3.0.0')], nodes: ['node_modules/shipped'] } });
      writeFileSync(raw, forged);
      const colPath = join(dir, 'evidence', 'audit', 'collection.json');
      const col = JSON.parse(readFileSync(colPath, 'utf8'));
      col.graphs.application.run.stdoutSha256 = sha256Hex(forged);
      writeFileSync(colPath, JSON.stringify(col));
      const rec = JSON.parse(readFileSync(join(dir, 'certification.json'), 'utf8'));
      const ev = new Map([...candidateFiles(dir)].filter(([k]) => k.startsWith('evidence/')));
      const d = describeFiles(ev);
      rec.evidence = { treeDigest: d.treeDigest, files: d.entries };
      writeFileSync(join(dir, 'certification.json'), JSON.stringify(rec));
    });
    assert.deepEqual(codes(r.problems), ['evidence_unreproducible', 'evidence_not_passing'], JSON.stringify(r.problems));
  }));
});

