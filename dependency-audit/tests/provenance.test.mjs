/**
 * CI-signal A-2: the adapter supplies `provenance` and `reportableSince`, which switches on
 * the dated obligation A-1 added to the evaluator. Shared byte-for-byte with Dinify-Admin.
 *
 * Every git operation here is REAL (a fixture repository with a base commit and a head);
 * only the scanner's answer and GitHub's answer are canned, at the two seams built for it.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  ADVISORIES_FILE, advisoryIds, applyDates, buildAdvisoryEvidence, fetchAdvisories, readAdvisoryEvidence, reportableDate, utcDateOf,
} from '../lib/advisories.mjs';
import { audit, reevaluate, renderSummary, requestedBase, resolveBase, snapshot } from '../lib/audit.mjs';
import { annotateProvenance, inventory, lockEntries, readReport, scannerEnvironment, toolingScope } from '../lib/npm.mjs';
import {
  advisoryBody, cannedAdvisories, cannedRunner, CLEAN_SCANNER, commitBase, fakeInstall, git, makeProject, NOW, npmReport, via,
} from './project.mjs';

const GHSA = 'GHSA-aaaa-bbbb-cccc';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The scanner's answer: one advisory on `name`, at `severity`, on the node it names. */
const answer = (name, severity, node, ghsa = GHSA, total = node.startsWith('node_modules/npm') ? 2 : 4) => ({
  status: 1,
  stdout: npmReport({ [name]: { via: [via(name, severity, '>=0.0.0', ghsa)], nodes: [node] } }, total),
});
const TOOL_HIGH = answer('tool', 'high', 'node_modules/tool');
const TOOL_CRITICAL = answer('tool', 'critical', 'node_modules/tool');
const SHIPPED_HIGH = answer('shipped', 'high', 'node_modules/shipped');

/**
 * A fixture repository at HEAD whose base is shaped by `base`, snapshotted and audited.
 * Returns the project, the base commit and the result; the caller cleans up.
 */
function audited({ app = TOOL_HIGH, scanner = CLEAN_SCANNER, base = {}, useBase = true, advisories = cannedAdvisories(), now = NOW } = {}) {
  const p = makeProject({});
  const baseCommit = commitBase(p.root, base);
  snapshot(p.root, { evidenceDir: p.evidence, now });
  const result = audit(p.root, {
    evidenceDir: p.evidence, now, runner: cannedRunner({ application: app, scanner }), installScanner: fakeInstall,
    base: useBase ? baseCommit : null, advisories,
  });
  return { p, baseCommit, result, advisories };
}
const within = (options, fn) => { const r = audited(options); try { return fn(r); } finally { r.p.cleanup(); } };
const toolFinding = (result) => result.findings.find((f) => f.package === 'tool');

describe('provenance: inherited only when the base holds the same path, version and integrity (npm.mjs)', () => {
  const read1 = (base) => {
    const p = makeProject({});
    try {
      const inv = inventory(p.root, { graph: 'application' });
      return readReport({ graph: 'application', run: TOOL_HIGH, inv, base }).findings[0];
    } finally { p.cleanup(); }
  };
  const lockOf = () => { const p = makeProject({}); try { return read(join(p.root, 'package-lock.json')); } finally { p.cleanup(); } };
  const entries = (mutate) => { const lock = lockOf(); mutate(lock.packages); return lockEntries(JSON.stringify(lock)); };

  it('CONTRACT: the same path, version and integrity in the base → inherited', () => {
    assert.equal(read1(entries(() => {})).provenance, 'inherited');
  });
  it('REGRESSION: a path the base does not hold → introduced', () => {
    assert.equal(read1(entries((pk) => { delete pk['node_modules/tool']; })).provenance, 'introduced');
  });
  it('REGRESSION: a MOVED path — same name, version and integrity somewhere else in the base → introduced', () => {
    assert.equal(read1(entries((pk) => { pk['node_modules/other/node_modules/tool'] = pk['node_modules/tool']; delete pk['node_modules/tool']; })).provenance, 'introduced');
  });
  it('REGRESSION: a changed INTEGRITY at the same path and version → introduced', () => {
    assert.equal(read1(entries((pk) => { pk['node_modules/tool'].integrity = 'sha512-CHANGED'; })).provenance, 'introduced');
  });
  it('REGRESSION: a changed VERSION at the same path → introduced', () => {
    assert.equal(read1(entries((pk) => { pk['node_modules/tool'].version = '0.9.0'; })).provenance, 'introduced');
  });
  it('CONTRACT: NO base → the field is ABSENT, never guessed', () => {
    const f = read1(undefined);
    assert.equal('provenance' in f, false);
    assert.equal(read1(null).provenance, undefined);
  });
  it('CONTRACT: an unreadable base lockfile is no base (lockEntries → null)', () => {
    assert.equal(lockEntries('not json'), null);
    assert.equal(lockEntries(JSON.stringify({ lockfileVersion: 1, dependencies: {} })), null);
    assert.equal(lockEntries(JSON.stringify({ lockfileVersion: 3, packages: [] })), null);
  });
  it('CONTRACT: annotateProvenance (the retained path) gives the same findings, key order included, as readReport with a base', () => {
    const p = makeProject({});
    try {
      const inv = inventory(p.root, { graph: 'application' });
      const base = entries(() => {});
      const direct = readReport({ graph: 'application', run: TOOL_HIGH, inv, base }).findings;
      const after = annotateProvenance(readReport({ graph: 'application', run: TOOL_HIGH, inv }).findings, { graph: 'application', inv, base });
      assert.equal(JSON.stringify(after), JSON.stringify(direct));
      assert.equal(annotateProvenance(direct, { graph: 'application', inv, base: undefined }), direct, 'no base: returned unchanged');
    } finally { p.cleanup(); }
  });
});

describe('the base, read from git (audit.mjs)', () => {
  it('CONTRACT: the base commit and BOTH lock digests are recorded, and every finding carries its provenance', () => within({}, ({ p, baseCommit, result }) => {
    const c = read(join(p.evidence, 'collection.json'));
    assert.equal(c.base.commit, baseCommit);
    assert.equal(c.base.state, 'applied');
    const shown = (path) => sha256(git(p.root, 'show', `${baseCommit}:${path}`) + '\n');
    assert.deepEqual(c.base.graphs.application, { path: 'package-lock.json', state: 'present', lockfileSha256: shown('package-lock.json') });
    assert.deepEqual(c.base.graphs.scanner, { path: 'dependency-audit/scanner/package-lock.json', state: 'present', lockfileSha256: shown('dependency-audit/scanner/package-lock.json') });
    assert.equal(toolFinding(result).provenance, 'inherited');
  }));

  it('REGRESSION: a base with no lockfile for a graph → every finding of that graph is introduced', () => within({
    scanner: answer('npm', 'high', 'node_modules/npm'), base: { scanner: () => undefined },
  }, ({ p, result }) => {
    assert.equal(read(join(p.evidence, 'collection.json')).base.graphs.scanner.state, 'absent');
    assert.equal(result.findings.find((f) => f.package === 'npm').provenance, 'introduced');
    assert.equal(result.outcome, 'blocking');
  }));

  for (const [label, value] of [['an empty BASE', ''], ['an all-zero `before` (a push that created the branch)', '0'.repeat(40)], ['no BASE at all', undefined]]) {
    it(`REGRESSION: ${label} is NO base — nothing is recorded, asked or deferred, and the high blocks as before`, () => {
      assert.deepEqual(requestedBase(value), { commit: null, valid: true });
      within({ useBase: false }, ({ p, result, advisories }) => {
        const c = read(join(p.evidence, 'collection.json'));
        assert.equal('base' in c, false);
        assert.equal('advisories' in c, false);
        assert.equal('provenance' in toolFinding(result), false);
        assert.deepEqual(advisories.asked, [], 'no request is made');
        assert.equal(result.outcome, 'blocking');
        assert.equal('deferred' in result.counts, false, 'the counts are the pre-A-2 shape');
      });
    });
  }

  it('REGRESSION: a base that is not in this clone is no base, and says why', () => within({ useBase: false }, ({ p }) => {
    const r = resolveBase(p.root, 'f'.repeat(40), { scanner: { root: 'dependency-audit/scanner' } });
    assert.equal(r.record.state, 'unavailable');
    assert.match(r.record.reason, /not in this clone/);
    assert.deepEqual(r.bases, {});
  }));

  it('REGRESSION: a base that is not an ancestor of HEAD (a force push) is no base', () => within({ useBase: false }, ({ p, baseCommit }) => {
    git(p.root, 'checkout', '-q', '-b', 'elsewhere', baseCommit);
    writeFileSync(join(p.root, 'unrelated.txt'), 'x\n');
    git(p.root, 'add', 'unrelated.txt');
    git(p.root, 'commit', '-q', '-m', 'rewritten');
    const orphan = git(p.root, 'rev-parse', 'HEAD');
    git(p.root, 'checkout', '-q', 'main');
    const r = resolveBase(p.root, orphan, { scanner: { root: 'dependency-audit/scanner' } });
    assert.equal(r.record.state, 'unavailable');
    assert.match(r.record.reason, /not an ancestor/);
    // CONTROL: the base the history really has is applied.
    assert.equal(resolveBase(p.root, baseCommit, { scanner: { root: 'dependency-audit/scanner' } }).record.state, 'applied');
  }));

  it('CONTRACT: --base accepts only a full lower-case commit id; anything else is a usage error (exit 64) before anything runs', () => {
    assert.equal(requestedBase('ABCDEF0123456789ABCDEF0123456789ABCDEF01').valid, false);
    assert.equal(requestedBase('abc123').valid, false);
    assert.deepEqual(requestedBase('a'.repeat(40)), { commit: 'a'.repeat(40), valid: true });
    const cli = resolve(new URL('..', import.meta.url).pathname, 'cli.mjs');
    const r = spawnSync(process.execPath, [cli, 'audit', '--base', 'HEAD~1'], { encoding: 'utf8' });
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /--base must be a full 40-character/);
    assert.equal(spawnSync(process.execPath, [cli, 'evaluate', '--base', 'a'.repeat(40)], { encoding: 'utf8' }).status, 64, 'only `audit` takes a base');
  });
});

describe('the clock: dates from GitHub, retained, never supplied (advisories.mjs)', () => {
  it('CONTRACT: an INHERITED high tooling finding inside its window → obligations_pending, exit 0, deferred until reportableSince + 7', () => within({}, ({ p, result, advisories }) => {
    const f = toolFinding(result);
    assert.equal(result.outcome, 'obligations_pending');
    assert.equal(result.exitCode, 0);
    assert.equal(f.provenance, 'inherited');
    assert.equal(f.reportableSince, '2026-09-21', 'the REVIEWED date, not the published one');
    assert.equal(f.class, 'deferred');
    assert.equal(f.deadline, '2026-09-28');
    assert.equal(result.counts.deferred, 1);
    assert.deepEqual(advisories.asked, [[GHSA]], 'one request per GHSA id in the report, once');
    const c = read(join(p.evidence, 'collection.json'));
    assert.deepEqual(c.advisories, { file: ADVISORIES_FILE, sha256: sha256(readFileSync(join(p.evidence, ADVISORIES_FILE))), requested: 1, authenticated: true });
  }));

  it('REGRESSION: the same high INTRODUCED by the change → blocking', () => within({ base: { application: (lock) => { delete lock.packages['node_modules/tool']; return lock; } } }, ({ result }) => {
    assert.equal(toolFinding(result).provenance, 'introduced');
    assert.equal(result.outcome, 'blocking');
    assert.match(renderSummary(result), /→ blocking \(introduced: not in the base\)/, 'the summary says why it was not deferred');
  }));

  it('REGRESSION: the same inherited high from its deadline on → blocking', () => {
    within({ advisories: cannedAdvisories((id) => ({ status: 200, body: advisoryBody(id, { reviewed: '2026-09-17T08:00:00Z' }) })) }, ({ result }) => {
      assert.equal(toolFinding(result).reportableSince, '2026-09-17');
      assert.equal(result.outcome, 'blocking', 'deadline 2026-09-24, and it is 2026-09-24 12:00 UTC');
      assert.match(renderSummary(result), /→ blocking \(inherited, reportable since 2026-09-17; its window has closed\)/);
    });
    // CONTROL: one day later reviewed, still inside the window.
    within({ advisories: cannedAdvisories((id) => ({ status: 200, body: advisoryBody(id, { reviewed: '2026-09-18T08:00:00Z' }) })) }, ({ result }) => {
      assert.equal(result.outcome, 'obligations_pending');
      assert.match(renderSummary(result), /→ deferred: inherited, blocks from 2026-09-25\n/);
    });
  });

  it('REGRESSION: an inherited CRITICAL blocks at once; an inherited RUNTIME high blocks at once', () => {
    within({ app: TOOL_CRITICAL }, ({ result }) => {
      assert.equal(toolFinding(result).provenance, 'inherited');
      assert.equal(toolFinding(result).reportableSince, '2026-09-21');
      assert.equal(result.outcome, 'blocking');
      assert.match(renderSummary(result), /→ blocking\n/, 'a critical is not given a not-deferred reason: there was never a window');
    });
    within({ app: SHIPPED_HIGH }, ({ result }) => {
      assert.equal(result.findings[0].scope, 'runtime');
      assert.equal(result.findings[0].provenance, 'inherited');
      assert.equal(result.outcome, 'blocking');
    });
  });

  const noDate = [
    ['a request that failed', () => ({ status: 0, error: 'request_failed: ECONNRESET' })],
    ['a timeout', () => ({ status: 0, error: 'timeout' })],
    ['a 403 (rate-limited)', () => ({ status: 403, body: '{"message":"API rate limit exceeded"}' })],
    ['a 404', () => ({ status: 404, body: '{"message":"Not Found"}' })],
    ['a 200 that is not JSON', () => ({ status: 200, body: '<html>' })],
    ['a 200 about another advisory', () => ({ status: 200, body: advisoryBody('GHSA-zzzz-zzzz-zzzz') })],
    ['a 200 whose reviewed date is malformed', (id) => ({ status: 200, body: advisoryBody(id, { reviewed: 'yesterday' }) })],
  ];
  for (const [label, answerFor] of noDate) {
    it(`REGRESSION: ${label} leaves NO date, so the inherited high BLOCKS — and the scan is not incomplete`, () => within({ advisories: cannedAdvisories(answerFor) }, ({ p, result }) => {
      const f = toolFinding(result);
      assert.equal(f.provenance, 'inherited');
      assert.equal('reportableSince' in f, false);
      assert.equal(result.outcome, 'blocking');
      assert.match(renderSummary(result), /→ blocking \(inherited; no reportable date\)/);
      const retained = read(join(p.evidence, ADVISORIES_FILE));
      assert.equal(retained.advisories[0].id, GHSA, 'the failed answer is retained as evidence too');
    }));
  }

  it('REGRESSION: a fetcher that throws is an outage → no date → blocks', () => within({ advisories: () => { throw new Error('boom'); } }, ({ p, result }) => {
    assert.equal(result.outcome, 'blocking');
    assert.equal(read(join(p.evidence, ADVISORIES_FILE)).advisories[0].error, 'fetch_failed');
  }));

  it('CONTRACT: the date rule — reviewed first, else published, as a UTC calendar date; impossible dates are none', () => {
    assert.equal(reportableDate(advisoryBody(GHSA), GHSA), '2026-09-21');
    assert.equal(reportableDate(advisoryBody(GHSA, { reviewed: null }), GHSA), '2026-09-20');
    assert.equal(reportableDate(advisoryBody(GHSA, { reviewed: null, published: null }), GHSA), null);
    assert.equal(reportableDate(advisoryBody(GHSA, { reviewed: '2026-02-30T00:00:00Z' }), GHSA), null, 'Date.parse would say 2 March');
    assert.equal(utcDateOf('2026-10-01T23:30:00-02:00'), '2026-10-02', 'an offset is converted, not dropped');
    assert.equal(utcDateOf('2026-10-01'), null, 'a date is not an instant');
    assert.equal(reportableDate(advisoryBody(GHSA), GHSA.toUpperCase()), null, 'the record must be about the advisory asked');
  });

  it('CONTRACT: only findings with provenance are asked about or dated — sorted, distinct, GHSA only', () => {
    const findings = [
      { advisory: 'GHSA-bbbb-bbbb-bbbb', provenance: 'inherited' },
      { advisory: 'GHSA-aaaa-aaaa-aaaa', provenance: 'introduced' },
      { advisory: 'GHSA-aaaa-aaaa-aaaa', provenance: 'inherited' },
      { advisory: 'GHSA-cccc-cccc-cccc' },
      { advisory: 'npm:1100', provenance: 'inherited' },
    ];
    assert.deepEqual(advisoryIds(findings), ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb']);
    const dated = applyDates(findings, new Map([['GHSA-cccc-cccc-cccc', '2026-09-01'], ['GHSA-bbbb-bbbb-bbbb', '2026-09-02']]));
    assert.equal(dated[0].reportableSince, '2026-09-02');
    assert.equal('reportableSince' in dated[3], false, 'no provenance, no date — whatever the record says');
  });

  it('CONTRACT: the job token reaches the clock\'s child and never the scanner', () => {
    const { env, removed } = scannerEnvironment({ PATH: '/bin', GH_TOKEN: 't', GITHUB_TOKEN: 'u' });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.deepEqual(removed, ['GH_TOKEN', 'GITHUB_TOKEN']);
    // The real child, offline: an id that is not a GHSA id is answered without a request.
    const r = fetchAdvisories(['not-a-ghsa-id'], { token: 'job-token' });
    assert.equal(r.authenticated, true);
    assert.deepEqual(r.answers.map((a) => [a.id, a.status, a.error, a.body]), [['not-a-ghsa-id', 0, 'not_a_ghsa_id', null]]);
    assert.equal(fetchAdvisories(['not-a-ghsa-id'], { token: '' }).authenticated, false);
  });
});

describe('re-deciding retained evidence: offline, and byte-identical', () => {
  const result = (p) => readFileSync(join(p.evidence, 'result.json'), 'utf8');
  const asDocument = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

  for (const [label, options] of [['an obligation pending', {}], ['a blocking introduced finding', { base: { application: (l) => { delete l.packages['node_modules/tool']; return l; } } }], ['no base at all', { useBase: false }]]) {
    it(`DETERMINISM (${label}): evaluate at the same instant re-derives the base from git, re-reads the dates and writes the SAME bytes`, () => within(options, ({ p, result: decided }) => {
      const again = reevaluate(p.root, { evidenceDir: p.evidence, now: decided.decidedAt });
      assert.equal(asDocument(again), result(p));
    }));
  }

  it('CONTRACT: the re-decision never fetches — the record is the only source of a date', () => within({}, ({ p, advisories }) => {
    const before = advisories.asked.length;
    const again = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(again.outcome, 'obligations_pending');
    assert.equal(advisories.asked.length, before);
  }));

  it('REGRESSION: a TAMPERED advisories.json (digest mismatch) is incomplete — not "no date"', () => within({}, ({ p }) => {
    const path = join(p.evidence, ADVISORIES_FILE);
    writeFileSync(path, readFileSync(path, 'utf8').replace('2026-09-21', '2026-09-23'));
    const again = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(again.outcome, 'incomplete');
    assert.ok(again.reasons.some((r) => r.code === 'evidence_tampered'), JSON.stringify(again.reasons));
  }));

  it('REGRESSION: a tamper OUTSIDE every body (here, the authentication flag) is caught by the file digest alone', () => within({}, ({ p }) => {
    const path = join(p.evidence, ADVISORIES_FILE);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"authenticated": true', '"authenticated": false'));
    const again = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(again.outcome, 'incomplete');
    assert.ok(again.reasons.some((r) => r.code === 'evidence_tampered'), JSON.stringify(again.reasons));
  }));

  it('REGRESSION: a missing advisories.json the collection names is incomplete', () => within({}, ({ p }) => {
    rmSync(join(p.evidence, ADVISORIES_FILE));
    const again = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(again.outcome, 'incomplete');
    assert.ok(again.reasons.some((r) => r.code === 'evidence_unreadable'));
  }));

  it('REGRESSION: a body rewritten together with the file digest is still refused — each body carries its own digest', () => {
    const answers = [{ id: GHSA, status: 200, retrievedAt: NOW, error: null, body: advisoryBody(GHSA) }];
    const built = buildAdvisoryEvidence({ answers, authenticated: true });
    const doc = JSON.parse(built.bytes.toString('utf8'));
    doc.advisories[0].body = advisoryBody(GHSA, { reviewed: '2026-09-23T00:00:00Z' });
    const forged = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
    const r = readAdvisoryEvidence(forged, sha256(forged));
    assert.equal(r.problems[0].code, 'advisories_tampered');
    // CONTROL: the record as written reads, with its date.
    assert.equal(readAdvisoryEvidence(built.bytes, built.sha256).dates.get(GHSA), '2026-09-21');
  });

  it('REGRESSION: a base that can no longer be re-derived from git is incomplete, never silently dropped', () => within({}, ({ p }) => {
    const path = join(p.evidence, 'collection.json');
    const c = read(path);
    c.base.graphs.application.lockfileSha256 = '0'.repeat(64);
    writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`);
    const again = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(again.outcome, 'incomplete');
    assert.ok(again.reasons.some((r) => r.code === 'evidence_base_mismatch'));
  }));

  it('CONTRACT: the scanner graph is read against the base too (tooling scope, inherited when unchanged)', () => within({ scanner: answer('npm', 'high', 'node_modules/npm') }, ({ result }) => {
    const f = result.findings.find((x) => x.path === 'scanner:node_modules/npm');
    assert.equal(f.scope, toolingScope());
    assert.equal(f.provenance, 'inherited');
    assert.equal(f.class, 'deferred');
  }));
});
