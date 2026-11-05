/**
 * SHIPPED — the "no shipped change, no deploy" refinement of the forward-only guard
 * (release/lib/shipped.mjs and `release/cli.mjs shipped-change`).
 *
 * What is pinned here: which paths ship, that the always-shipped rules win, that only
 * regular files can be skipped, that anything unestablished DEPLOYS, the served-candidate
 * retention rule (at least 14 days left), and the 4 November 2026 replay. The guard step
 * that calls this is executed against stubs in workflow.test.mjs.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadReleasePolicy } from '../lib/common.mjs';
import { RETENTION_MIN_DAYS, changedPaths, decideShippedChange, isShippedPath, readTree, servedRetention } from '../lib/shipped.mjs';
import { REPO_ROOT } from './fixtures.mjs';
import { REPLAY_BASE, REPLAY_MERGES, REPLAY_PATHS, apiTree, replayTree, servedCI } from './shipped-fixtures.mjs';

const { policy } = loadReleasePolicy(REPO_ROOT);
const SERVED = 'b2'.repeat(20);
const TARGET = 'a1'.repeat(20);
const blob = (c) => c.repeat(40);

/** The served and target trees: `base` entries, with `changes` applied to the target. */
function pair(changes, { base = [['src/main.ts', '100644', blob('1')], ['README.md', '100644', blob('2')]], servedOpts, targetOpts } = {}) {
  const t = new Map(base.map((e) => [e[0], e]));
  for (const [path, mode, sha] of changes) { if (mode === null) t.delete(path); else t.set(path, [path, mode, sha]); }
  const s = apiTree(SERVED, blob('5'), base, servedOpts);
  const g = apiTree(TARGET, blob('6'), [...t.values()], targetOpts);
  return { servedCommit: s.commit, servedTree: s.tree, targetCommit: g.commit, targetTree: g.tree };
}

const decide = (changes, { ci = {}, trees = {}, now = Date.now() } = {}) => {
  const c = servedCI(SERVED, { now, ...ci });
  return decideShippedChange({ served: SERVED, target: TARGET, ...pair(changes, trees), policy, ...c, now });
};

describe('the shipped-path rule', () => {
  const notShipped = [
    'README.md', 'CLAUDE.md', 'AGENTS.md', 'ADMIN_PORTAL_MVP_v2_3.md', 'release/README.md', 'dependency-audit/README.md',
    '.claude/review-marketplace/README.md', 'docs/runbook.txt', 'docs/a/b.png',
    'dependency-audit/policy.json', 'dependency-audit/lib/core.mjs', 'dependency-audit/tests/audit.test.mjs', 'dependency-audit/conformance.json',
    '.github/workflows/claude.yml', '.github/workflows/claude-code-review.yml',
  ];
  const shipped = [
    // always shipped, including where the allowlist would otherwise match
    'src/main.ts', 'src/app/notes.md', 'src/README.md', 'public/README.md', 'public/favicon.png',
    'package.json', 'package-lock.json', 'docs/package.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json',
    'tailwind.config.js', '.github/workflows/ci.yml', '.github/workflows/deploy.yml',
    'dependency-audit/scanner/package.json', 'dependency-audit/scanner/package-lock.json', 'dependency-audit/scanner/README.md',
    // shipped by default
    'release/lib/shipped.mjs', 'release/cli.mjs', 'release/policy.json', 'release/tests/workflow.test.mjs', 'scripts/verify.sh',
    'eslint.config.js', 'karma.conf.js', '.editorconfig', '.gitignore', '.github/dependabot.yml', '.github/workflows/audit.yml',
    // lookalikes
    'docsx/a.txt', 'x/docs/a.txt', 'dependency-audit-x/a.mjs', '.github/workflows/claude.yml.bak', '.github/workflows/claude.yaml',
    'README.md.bak', 'README.MD',
  ];
  for (const p of notShipped) it(`NOT SHIPPED: ${p}`, () => assert.equal(isShippedPath(p), false));
  for (const p of shipped) it(`SHIPPED: ${p}`, () => assert.equal(isShippedPath(p), true));

  it('PRECEDENCE PAIR: release/README.md skips, release/lib/shipped.mjs deploys — a change to the allowlist itself always deploys', () => {
    assert.equal(isShippedPath('release/README.md'), false);
    assert.equal(isShippedPath('release/lib/shipped.mjs'), true);
    assert.equal(decide([['release/README.md', '100644', blob('9')]]).skip, true);
    const d = decide([['release/lib/shipped.mjs', '100644', blob('9')]]);
    assert.deepEqual([d.skip, d.code], [false, 'shipped_change']);
  });

  it('PRECEDENCE: the always-shipped rules win over the allowlist (a .md under src/, the scanner under dependency-audit/)', () => {
    for (const p of ['src/app/notes.md', 'public/README.md', 'dependency-audit/scanner/package-lock.json', 'dependency-audit/scanner/README.md']) {
      const d = decide([[p, '100644', blob('9')]]);
      assert.deepEqual([d.skip, d.code], [false, 'shipped_change'], p);
    }
  });
});

describe('the tree comparison', () => {
  const map = (entries) => new Map(entries.map(([path, mode, sha]) => [path, { mode, type: mode === '160000' ? 'commit' : 'blob', sha }]));

  it('CONTROL: added, deleted and modified allowlisted files are changes that ship nothing', () => {
    const c = changedPaths(map([['README.md', '100644', blob('1')], ['docs/a.txt', '100644', blob('2')]]), map([['README.md', '100644', blob('3')], ['docs/b.txt', '100644', blob('4')]]));
    assert.deepEqual(c.map((x) => [x.path, x.change, x.shipped]), [['README.md', 'modified', false], ['docs/a.txt', 'deleted', false], ['docs/b.txt', 'added', false]]);
  });

  it('REGRESSION: a rename is judged on BOTH sides — out of src/ or into src/ is shipped', () => {
    const out = changedPaths(map([['src/a.md', '100644', blob('1')]]), map([['docs/a.md', '100644', blob('1')]]));
    assert.ok(out.some((x) => x.path === 'src/a.md' && x.shipped));
    const into = changedPaths(map([['docs/a.md', '100644', blob('1')]]), map([['src/a.md', '100644', blob('1')]]));
    assert.ok(into.some((x) => x.path === 'src/a.md' && x.shipped));
  });

  it('REGRESSION: only regular files can be skipped — a symlink, a submodule or a file turned into a symlink is shipped', () => {
    for (const [label, before, after] of [
      ['a new symlink', [], [['docs/link.md', '120000', blob('7')]]],
      ['a new submodule', [], [['docs/vendor', '160000', blob('7')]]],
      ['a file turned into a symlink', [['README.md', '100644', blob('1')]], [['README.md', '120000', blob('1')]]],
      ['a symlink removed', [['docs/link.md', '120000', blob('7')]], []],
    ]) {
      const c = changedPaths(map(before), map(after));
      assert.equal(c.length, 1, label);
      assert.deepEqual([c[0].shipped, c[0].why], [true, 'not a regular file'], label);
      assert.equal(decide(after.length ? after : [[before[0][0], null]], { trees: { base: [...before, ['src/main.ts', '100644', blob('1')]] } }).skip, false, label);
    }
  });

  it('CONTROL: an executable bit on a document is a regular-file change and still ships nothing', () => {
    const c = changedPaths(map([['docs/run.md', '100644', blob('1')]]), map([['docs/run.md', '100755', blob('1')]]));
    assert.deepEqual(c.map((x) => x.shipped), [false]);
  });

  it('REGRESSION: a truncated, unstated, mismatched or malformed tree is no answer at all', () => {
    const ok = apiTree(SERVED, blob('5'), [['README.md', '100644', blob('1')]]);
    assert.ok(readTree(SERVED, ok.commit, ok.tree).entries);
    const t = (mutate) => { const x = structuredClone(ok); mutate(x); return readTree(SERVED, x.commit, x.tree).problem; };
    assert.match(t((x) => { x.tree.truncated = true; }), /truncated/);
    assert.match(t((x) => { delete x.tree.truncated; }), /truncated/);
    assert.match(t((x) => { x.tree.sha = blob('9'); }), /could not be read/);
    assert.match(t((x) => { x.commit.sha = blob('9'); }), /could not be read/);
    assert.match(t((x) => { x.tree.tree[0].sha = 'nope'; }), /malformed/);
    assert.match(t((x) => { x.tree.tree.push({ ...x.tree.tree[0] }); }), /twice/);
    assert.match(t((x) => { x.tree.tree = null; }), /no entries/);
    assert.ok(readTree(SERVED, null, ok.tree).problem);
  });
});

describe('the decision', () => {
  const DOCS = [['README.md', '100644', blob('9')]];

  it('CONTROL: documentation only, served candidate retained with 30 days left → skip, with the exact reason', () => {
    const d = decide(DOCS);
    assert.deepEqual([d.skip, d.code, d.reason], [true, 'no_shipped_change', `No shipped change since ${SERVED}; not deployed`]);
    assert.equal(d.retention.ok, true);
    assert.deepEqual(d.changed.map((c) => c.path), ['README.md']);
  });

  it('CONTROL: identical trees ship nothing either → skip', () => {
    assert.equal(decide([]).skip, true);
  });

  it('CONTROL: one shipped path among documents → deploy, naming it', () => {
    const d = decide([...DOCS, ['src/main.ts', '100644', blob('8')]]);
    assert.deepEqual([d.skip, d.code], [false, 'shipped_change']);
    assert.match(d.reason, /1 shipped path changed since .*src\/main\.ts.*; deploying$/);
  });

  it('REGRESSION: a truncated served or target tree → deploy, never skip', () => {
    for (const trees of [{ servedOpts: { truncated: true } }, { targetOpts: { truncated: true } }]) {
      const d = decide(DOCS, { trees });
      assert.deepEqual([d.skip, d.code], [false, 'tree_unreadable'], JSON.stringify(trees));
    }
  });

  it('REGRESSION: an unreadable tree (an API failure) → deploy', () => {
    const p = pair(DOCS);
    const d = decideShippedChange({ served: SERVED, target: TARGET, ...p, servedTree: null, policy, ...servedCI(SERVED), now: Date.now() });
    assert.deepEqual([d.skip, d.code], [false, 'tree_unreadable']);
  });
});

describe(`the served-candidate retention guard (at least ${RETENTION_MIN_DAYS} days left)`, () => {
  const DOCS = [['docs/notes.txt', '100644', blob('9')]];
  const now = Date.parse('2026-11-04T22:00:00Z');
  const verdict = (ci, extra = {}) => decide(DOCS, { ci, now, ...extra });

  it('CONTROL: retained with 30 days left → skip', () => {
    const d = verdict({ daysLeft: 30 });
    assert.equal(d.skip, true);
    assert.match(d.retention.detail, /retained until 2026-12-04T22:00:00\.000Z \(30 days left\)/);
  });
  it('CONTROL: exactly 14 days left is enough → skip', () => assert.equal(verdict({ daysLeft: 14 }).skip, true));
  it('REGRESSION: 13 days left → deploy, and says why', () => {
    const d = verdict({ daysLeft: 13 });
    assert.deepEqual([d.skip, d.code], [false, 'retention_insufficient']);
    assert.match(d.reason, /admin-candidate-4242-1 expires 2026-11-17T22:00:00\.000Z \(13 days left; at least 14 required\); deploying$/);
  });
  it('REGRESSION: 13.9 days left → deploy (the boundary is not rounded up)', () => assert.equal(verdict({ daysLeft: 13.9 }).skip, false));
  it('REGRESSION: candidate missing from the served run → deploy', () => {
    const d = verdict({ artifact: false });
    assert.deepEqual([d.skip, d.code], [false, 'retention_insufficient']);
    assert.match(d.reason, /certification_no_candidate/);
  });
  it('REGRESSION: candidate already expired → deploy', () => {
    const d = verdict({ expired: true });
    assert.match(d.reason, /certification_expired/);
    assert.equal(d.skip, false);
  });
  for (const [label, expiresAt] of [['absent', null], ['not a date', 'soon'], ['an epoch number', 1790000000]]) {
    it(`REGRESSION: an unreadable expiry (${label}) → deploy`, () => {
      const d = verdict({ expiresAt });
      assert.deepEqual([d.skip, d.code], [false, 'retention_insufficient']);
      assert.match(d.reason, /states no readable expiry/);
    });
  }
  it('REGRESSION: no single served run (none read) → deploy', () => {
    const c = servedCI(SERVED, { now });
    const d = decideShippedChange({ served: SERVED, target: TARGET, ...pair(DOCS), policy, ...c, run: null, now });
    assert.deepEqual([d.skip, d.code], [false, 'retention_insufficient']);
  });
  it('REGRESSION: a run for another commit, an incomplete listing or no policy → deploy', () => {
    const c = servedCI(SERVED, { now });
    const base = { served: SERVED, target: TARGET, ...pair(DOCS), policy, ...c, now };
    assert.equal(decideShippedChange({ ...base, run: { ...c.run, head_sha: TARGET } }).skip, false);
    assert.equal(decideShippedChange({ ...base, artifacts: { ...c.artifacts, total_count: 2 } }).skip, false);
    assert.equal(decideShippedChange({ ...base, policy: null }).skip, false);
    assert.equal(servedRetention({ policy, served: SERVED, ...c, now: NaN }).ok, false);
  });
});

describe('THE REPLAY: Admin\'s four merges of 4 November 2026', () => {
  it('REPLAY: #57 and #56 deploy, #58 and #59 skip — and #59 is judged against #56, the commit still served', () => {
    let served = REPLAY_BASE;
    const got = [];
    for (const { pr, commit } of REPLAY_MERGES) {
      const s = replayTree(served);
      const t = replayTree(commit);
      const d = decideShippedChange({
        served, target: commit, servedCommit: s.commit, servedTree: s.tree, targetCommit: t.commit, targetTree: t.tree,
        policy, ...servedCI(served), now: Date.now(),
      });
      got.push({ pr, served: served.slice(0, 7), decision: d.skip ? 'skip' : 'deploy', shipped: (d.changed ?? []).filter((c) => c.shipped).map((c) => c.path) });
      if (!d.skip) served = commit;
    }
    assert.deepEqual(got, [
      { pr: '#57', served: '52643af', decision: 'deploy', shipped: ['package-lock.json'] },
      { pr: '#56', served: 'd73dd04', decision: 'deploy', shipped: REPLAY_PATHS.filter((p) => p.startsWith('src/')) },
      { pr: '#58', served: '547e647', decision: 'skip', shipped: [] },
      { pr: '#59', served: '547e647', decision: 'skip', shipped: [] },
    ]);
  });

  // The fixture is real history. Where this clone holds those commits (not CI's depth-1
  // checkout), re-derive every entry from git and require the fixture to match it.
  const git = (...args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const have = [REPLAY_BASE, ...REPLAY_MERGES.map((m) => m.commit)].every((c) => git('cat-file', '-e', `${c}^{commit}`).status === 0);
  it('CONTROL: the replay fixture is this repository\'s own git objects', { skip: have ? false : 'the replay commits are not in this clone (a depth-1 checkout)' }, () => {
    for (const commit of [REPLAY_BASE, ...REPLAY_MERGES.map((m) => m.commit)]) {
      const t = replayTree(commit);
      assert.equal(git('rev-parse', `${commit}^{tree}`).stdout.trim(), t.tree.sha);
      for (const e of t.tree.tree) assert.equal(git('rev-parse', `${commit}:${e.path}`).stdout.trim(), e.sha, `${commit}:${e.path}`);
    }
  });
});

describe('EXECUTED: `release/cli.mjs shipped-change`', () => {
  const CLI = join(REPO_ROOT, 'release', 'cli.mjs');
  function run(args, { served = SERVED, changes = [['README.md', '100644', blob('9')]], ci = {}, omit = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'shipped-cli-'));
    try {
      const p = pair(changes);
      const c = servedCI(served, ci);
      mkdirSync(join(dir, 'facts'));
      mkdirSync(join(dir, 'sf'));
      const files = {
        'facts/commit.json': p.targetCommit, 'facts/tree.json': p.targetTree, 'sf/commit.json': p.servedCommit, 'sf/tree.json': p.servedTree,
        'sf/ci-workflow.json': c.ciWorkflow, 'sf/run.json': c.run, 'sf/artifacts.json': c.artifacts,
      };
      for (const [f, v] of Object.entries(files)) if (!omit.includes(f)) writeFileSync(join(dir, f), JSON.stringify(v));
      const r = spawnSync(process.execPath, [CLI, 'shipped-change', ...(args ?? ['--served', served, '--target', TARGET, '--facts', 'facts', '--served-facts', 'sf'])], { cwd: dir, encoding: 'utf8' });
      return { status: r.status, stderr: r.stderr, decision: r.status === 0 ? JSON.parse(r.stdout) : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('CONTROL: documentation only, retained → exit 0 and {skip: true}', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([r.decision.skip, r.decision.code, r.decision.schema], [true, 'no_shipped_change', 'dinify.admin.shipped-change/1']);
  });
  it('CONTROL: a deploy decision is still exit 0, {skip: false}', () => {
    assert.deepEqual([run(undefined, { ci: { daysLeft: 13 } }).decision.skip, run(undefined, { changes: [['package.json', '100644', blob('9')]] }).decision.skip], [false, false]);
  });
  it('REGRESSION: a missing fact file → {skip: false}', () => {
    for (const f of ['sf/tree.json', 'sf/commit.json', 'facts/tree.json', 'sf/run.json', 'sf/artifacts.json', 'sf/ci-workflow.json']) {
      const r = run(undefined, { omit: [f] });
      assert.equal(r.status, 0, f);
      assert.equal(r.decision.skip, false, f);
    }
  });
  it('REGRESSION: usage errors exit non-zero (the guard then deploys)', () => {
    assert.equal(run(['--served', 'nope', '--target', TARGET, '--facts', 'facts', '--served-facts', 'sf']).status, 64);
    assert.equal(run(['--served', SERVED, '--target', TARGET, '--facts', 'facts']).status, 64);
    assert.equal(run(['--served', SERVED, '--target', TARGET, '--facts', 'facts', '--served-facts', 'sf', '--force', 'yes']).status, 64);
  });
});
