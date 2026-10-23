/**
 * THE ORCHESTRATION: snapshot → bound scan → decide, and re-deciding retained evidence.
 *
 * Each case builds a real disposable project and drives `audit()` with a canned scanner
 * (see project.mjs). The CLI itself exposes no way to substitute the scanner; the runner
 * parameter exists for this suite only.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { audit, reevaluate, renderSummary, snapshot } from '../lib/audit.mjs';
import { evaluate, parseDate, validateRecord } from '../lib/core.mjs';
import {
  auditedProject, CLEAN, CLEAN_SCANNER, cannedRunner, fakeInstall, HIGH_RUNTIME_MISSING_CAUSE, makeProject, npmReport, NOW, SUPPORTED_CHAIN, UNGROUNDED_CYCLE, via,
} from './project.mjs';


function run(options, fn) {
  const p = makeProject(options);
  try { return fn(p); } finally { p.cleanup(); }
}

const scan = (p, byGraph, extra = {}) => {
  const runner = cannedRunner(byGraph);
  const result = audit(p.root, { evidenceDir: p.evidence, now: NOW, runner, installScanner: fakeInstall, ...extra });
  return { result, runner };
};

describe('snapshot → audit', () => {
  it('CONTROL: a complete, clean scan of both graphs is within policy and says what it covered', () => run({}, (p) => {
    assert.equal(snapshot(p.root, { evidenceDir: p.evidence, now: NOW }).ok, true);
    const { result, runner } = scan(p, { application: CLEAN, scanner: CLEAN_SCANNER });
    assert.equal(result.outcome, 'within_policy', JSON.stringify(result.reasons));
    assert.equal(result.exitCode, 0);
    // Both graphs were scanned, by the pinned scanner, with the hardened argv.
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.equal(call.command, process.execPath);
      assert.match(call.args[0], /dependency-audit[\\/]scanner[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
      assert.ok(call.args.includes('--include=dev'));
      assert.ok(call.args.includes('--audit-level=low'), 'the level the status check assumes is the level the scanner runs at');
      assert.equal(call.env.NODE_ENV, undefined);
    }
    const collection = JSON.parse(readFileSync(join(p.evidence, 'collection.json'), 'utf8'));
    assert.equal(collection.binding.repository, 'mugak1/Dinify-Fixture');
    assert.match(collection.binding.application.lockfileSha256, /^[0-9a-f]{64}$/);
    assert.equal(collection.scanner.pinned, '11.19.1');
    assert.equal(collection.startedAt, NOW);
    assert.equal(collection.graphs.application.counts.locked, 4);
    assert.ok(existsSync(join(p.evidence, 'application.scanner-stdout.txt')));
    assert.ok(existsSync(join(p.evidence, 'result.json')));
  }));

  it('CONTRACT: without a post-install snapshot nothing is scanned and the result is incomplete', () => run({}, (p) => {
    const { result, runner } = scan(p, { application: CLEAN, scanner: CLEAN_SCANNER });
    assert.equal(result.outcome, 'incomplete');
    assert.ok(result.reasons.some((r) => r.code === 'no_snapshot'));
    assert.equal(runner.calls.length, 0);
  }));

  it('CONTRACT: an inventory that changed after the snapshot is refused as evidence', () => run({}, (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    const lockPath = join(p.root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/shipped'].integrity = 'sha512-CHANGED';
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    const { result, runner } = scan(p, { application: CLEAN, scanner: CLEAN_SCANNER });
    assert.equal(result.outcome, 'incomplete');
    assert.ok(result.reasons.some((r) => r.code === 'binding_mismatch' && /lockfileSha256/.test(r.detail)));
    assert.equal(runner.calls.length, 0, 'a stale inventory is not scanned at all');
  }));

  it('CONTRACT: a scan taken in a different target environment is refused', () => run({}, (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    const { result } = scan(p, { application: CLEAN, scanner: CLEAN_SCANNER }, { env: { node: process.version, platform: 'darwin', arch: 'arm64', libc: null } });
    assert.equal(result.outcome, 'incomplete');
    assert.ok(result.reasons.some((r) => r.code === 'binding_mismatch' && /environment/.test(r.detail)));
  }));

  it('CONTRACT: a Node major other than the policy target is not the validation environment', () => run({ nodeMajor: 99 }, (p) => {
    const snap = snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(snap.ok, false);
    assert.ok(snap.problems.some((x) => x.code === 'target_mismatch'));
  }));

  it('CONTRACT: an inventory that changes WHILE it is scanned produces no clean result', () => run({}, (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    const mutate = () => {
      writeFileSync(join(p.root, 'node_modules/shipped/package.json'), JSON.stringify({ name: 'shipped', version: '2.0.0', touched: true }));
      writeFileSync(join(p.root, 'package-lock.json'), `${readFileSync(join(p.root, 'package-lock.json'), 'utf8')}\n`);
      return CLEAN;
    };
    const { result } = scan(p, { application: mutate, scanner: CLEAN_SCANNER });
    assert.equal(result.outcome, 'incomplete');
    assert.ok(result.reasons.some((r) => r.code === 'inventory_changed_during_audit'));
  }));

  it('CONTRACT: a scanner failure keeps its raw cause in the evidence and fails the check', () => run({}, (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    const { result } = scan(p, { application: { status: 1, stdout: 'garbage', stderr: 'npm error code ECONNRESET\nnpm error network aborted' }, scanner: CLEAN_SCANNER });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.exitCode, 2);
    assert.match(readFileSync(join(p.evidence, 'application.scanner-stderr.txt'), 'utf8'), /ECONNRESET/);
    assert.equal(readFileSync(join(p.evidence, 'application.scanner-stdout.txt'), 'utf8'), 'garbage');
    const collection = JSON.parse(readFileSync(join(p.evidence, 'collection.json'), 'utf8'));
    assert.equal(collection.graphs.application.run.status, 1);
  }));

  it('CONTRACT: a scanner that is not the pinned one refuses the audit before anything is scanned', () => run({}, (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    writeFileSync(join(p.root, 'dependency-audit/scanner/node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: '10.0.0' }));
    const { result, runner } = scan(p, { application: CLEAN, scanner: CLEAN_SCANNER });
    assert.equal(result.outcome, 'incomplete');
    assert.ok(result.reasons.some((r) => r.code === 'scanner_pin'));
    assert.equal(runner.calls.length, 0);
  }));

  it('CONTRACT: an advisory in the scanner\'s own graph is decided like any other tooling finding', () => run({}, (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    const bad = { status: 1, stdout: npmReport({ bundled: { via: [via('bundled', 'high', '<2.0.0')], nodes: ['node_modules/npm/node_modules/bundled'] } }, 2) };
    const { result } = scan(p, { application: CLEAN, scanner: bad });
    assert.equal(result.outcome, 'blocking');
    assert.equal(result.findings[0].path, 'scanner:node_modules/npm/node_modules/bundled');
    assert.equal(result.findings[0].scope, 'tooling');
  }));

  it('CONTRACT: a narrow approved exception applies to exactly its finding and stays visible', () => {
    const record = {
      id: 'EXC-0001', kind: 'exception', advisory: 'GHSA-aaaa-bbbb-cccc', aliases: [], package: 'shipped', version: '2.0.0',
      paths: ['application:node_modules/shipped'], scope: 'runtime',
      applicability: 'The affected API is never called by the bundle; verified in the linked review.',
      reason: 'No fixed release inside the declared range; tracked in the linked review.',
      owner: 'Dinify platform owner', approval: { by: 'Dinify platform owner', reference: 'https://github.com/mugak1/Dinify-Admin/pull/1', date: '2026-09-20' },
      expires: '2026-10-20',
    };
    run({ records: [record] }, (p) => {
      snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
      const finding = { status: 1, stdout: npmReport({ shipped: { via: [via('shipped', 'high', '<3.0.0')], nodes: ['node_modules/shipped'] } }) };
      const { result } = scan(p, { application: finding, scanner: CLEAN_SCANNER });
      assert.equal(result.outcome, 'exceptions_only');
      assert.equal(result.exitCode, 0);
      assert.equal(result.findings[0].disposition, 'excepted');
      assert.match(result.headline, /PASSES ONLY WITH APPROVED EXCEPTIONS/);
      assert.match(renderSummary(result), /excepted \(EXC-0001\)/);
      // The same record against a later day, after it lapsed: refused, and the finding blocks.
      const lapsed = audit(p.root, { evidenceDir: p.evidence, now: '2026-10-21T00:00:00.000Z', runner: cannedRunner({ application: finding, scanner: CLEAN_SCANNER }), installScanner: fakeInstall });
      assert.equal(lapsed.outcome, 'blocking');
    });
  });
});

describe('re-deciding retained evidence', () => {
  const prepare = (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    return scan(p, { application: CLEAN, scanner: CLEAN_SCANNER }).result;
  };

  it('CONTROL: evidence for this checkout re-decides to the same outcome', () => run({}, (p) => {
    assert.equal(prepare(p).outcome, 'within_policy');
    assert.equal(reevaluate(p.root, { evidenceDir: p.evidence, now: NOW }).outcome, 'within_policy');
  }));

  it('CONTRACT: evidence for another lockfile is not accepted for this validation', () => run({}, (p) => {
    prepare(p);
    const lockPath = join(p.root, 'package-lock.json');
    writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace('sha512-AAAA', 'sha512-ZZZZ'));
    const r = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(r.outcome, 'incomplete');
    assert.ok(r.reasons.some((x) => x.code === 'evidence_foreign'));
  }));

  it('CONTRACT: evidence recorded for another revision or environment is not accepted', () => run({}, (p) => {
    prepare(p);
    const path = join(p.evidence, 'collection.json');
    const c = JSON.parse(readFileSync(path, 'utf8'));
    c.binding.revision = { commit: 'f'.repeat(40), tree: 'e'.repeat(40) };
    writeFileSync(path, JSON.stringify(c));
    assert.ok(reevaluate(p.root, { evidenceDir: p.evidence, now: NOW }).reasons.some((x) => x.code === 'evidence_foreign' && /revision/.test(x.detail)));
    c.binding.revision = null; c.binding.environment = { ...c.binding.environment, node: 'v18.0.0' };
    writeFileSync(path, JSON.stringify(c));
    assert.ok(reevaluate(p.root, { evidenceDir: p.evidence, now: NOW }).reasons.some((x) => x.code === 'evidence_foreign' && /environment/.test(x.detail)));
  }));

  it('CONTRACT: raw output that is not the recorded bytes is refused as tampered', () => run({}, (p) => {
    prepare(p);
    writeFileSync(join(p.evidence, 'application.scanner-stdout.txt'), npmReport({}, 4).replace('"total":0', '"total": 0'));
    const r = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(r.outcome, 'incomplete');
    assert.ok(r.reasons.some((x) => x.code === 'evidence_tampered'));
  }));
});

describe('an invalid policy is incomplete on every path, never a crash', () => {
  // Codex review on #698: loadPolicy recorded `policy_invalid` and still returned the
  // object, every caller guarded on a truthy policy, and `capture` then read
  // `policy.target.nodeMajor` — so a parseable policy with a missing or null target
  // (or an array for a policy) crashed `snapshot` with a TypeError instead of
  // reporting itself, and re-deciding retained evidence crashed on those and on a
  // missing scanner too. An uncaught throw is not one of the four outcomes.
  const SHAPES = {
    'no target': (p) => { delete p.target; },
    'a null target': (p) => { p.target = null; },
    'a target that is not an object': (p) => { p.target = '24'; },
    'no scanner': (p) => { delete p.scanner; },
    'a null scanner': (p) => { p.scanner = null; },
    'records that are not a list': (p) => { p.records = { a: 1 }; },
    'an array for a policy': () => [],
  };
  const breakPolicy = (root, mutate) => {
    const file = join(root, 'dependency-audit', 'policy.json');
    const policy = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify(mutate(policy) ?? policy));
  };
  const onlyPolicyInvalid = (problems, label) => {
    assert.ok(problems.length > 0, label);
    // Exactly the named problem — not a spurious target_mismatch read off a malformed target.
    assert.deepEqual([...new Set(problems.map((x) => x.code))], ['policy_invalid'], `${label}: ${JSON.stringify(problems)}`);
  };
  const refuseToRun = () => { throw new Error('an invalid policy must not reach the scanner'); };

  it('REGRESSION: the snapshot reports it, is still written, and the audit after it is incomplete', () => {
    for (const [label, mutate] of Object.entries(SHAPES)) run({}, (p) => {
      breakPolicy(p.root, mutate);
      const snap = snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
      assert.equal(snap.ok, false, label);
      onlyPolicyInvalid(snap.problems, label);
      const written = JSON.parse(readFileSync(join(p.evidence, 'snapshot.json'), 'utf8'));
      assert.deepEqual(written.problems, snap.problems, `${label}: the evidence says why`);
      const result = audit(p.root, { evidenceDir: p.evidence, now: NOW, runner: refuseToRun, installScanner: refuseToRun });
      assert.equal(result.outcome, 'incomplete', label);
      assert.equal(result.exitCode, 2, label);
    });
  });

  it('REGRESSION: a policy broken after a valid snapshot scans nothing and is incomplete', () => {
    for (const [label, mutate] of Object.entries(SHAPES)) run({}, (p) => {
      assert.equal(snapshot(p.root, { evidenceDir: p.evidence, now: NOW }).ok, true, label);
      breakPolicy(p.root, mutate);
      const result = audit(p.root, { evidenceDir: p.evidence, now: NOW, runner: refuseToRun, installScanner: refuseToRun });
      assert.equal(result.outcome, 'incomplete', label);
      assert.equal(result.exitCode, 2, label);
      onlyPolicyInvalid(result.reasons, label);
    });
  });

  it('REGRESSION: re-deciding retained evidence under an invalid policy is incomplete', () => {
    for (const [label, mutate] of Object.entries(SHAPES)) run({}, (p) => {
      snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
      assert.equal(scan(p, { application: CLEAN, scanner: CLEAN_SCANNER }).result.outcome, 'within_policy', label);
      breakPolicy(p.root, mutate);
      const result = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
      assert.equal(result.outcome, 'incomplete', label);
      assert.equal(result.exitCode, 2, label);
      onlyPolicyInvalid(result.reasons, label);
    });
  });
});

describe('retained evidence that is not a document is incomplete, never clean', () => {
  // Codex review on mugak1/Dinify-Backend#339: evidence that PARSES is not yet evidence.
  // `reevaluate` guarded on truthy documents, so a collection.json or snapshot.json holding
  // `null`, `0`, `""` or `false` skipped every binding and graph check and re-decided to
  // within policy, exit 0 — a clean verdict about evidence that does not exist.
  const SHAPES = {
    'null': null, 'zero': 0, 'an empty string': '', 'false': false,
    'an empty object': {}, 'an empty list': [], 'a list': [1, 2],
    'an object with another schema': { schema: 'dinify.dependency-audit.something-else/v1' },
  };
  const prepare = (p) => {
    snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
    assert.equal(scan(p, { application: CLEAN, scanner: CLEAN_SCANNER }).result.outcome, 'within_policy');
  };

  it('REGRESSION: re-deciding a collection or snapshot that is not a document is incomplete', () => {
    for (const [label, value] of Object.entries(SHAPES)) for (const file of ['collection.json', 'snapshot.json']) run({}, (p) => {
      prepare(p);
      writeFileSync(join(p.evidence, file), JSON.stringify(value));
      const r = reevaluate(p.root, { evidenceDir: p.evidence, now: NOW });
      assert.equal(r.outcome, 'incomplete', `${file} holding ${label}: ${JSON.stringify(r.reasons)}`);
      assert.equal(r.exitCode, 2, `${file} holding ${label}`);
      assert.ok(r.reasons.some((x) => x.code === 'evidence_unreadable' && x.detail.startsWith(file)), `${file} holding ${label}: the reason names the file`);
    });
  });

  it('REGRESSION: the audit refuses a snapshot that is not a document, and scans nothing', () => {
    const shapes = { ...SHAPES, 'problems that are not a list': 'problems-string', 'a problem that is not an object': 'problems-null' };
    for (const [label, value] of Object.entries(shapes)) run({}, (p) => {
      snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
      const path = join(p.evidence, 'snapshot.json');
      const good = JSON.parse(readFileSync(path, 'utf8'));
      const doc = value === 'problems-string' ? { ...good, problems: 'none' } : value === 'problems-null' ? { ...good, problems: [null] } : value;
      writeFileSync(path, JSON.stringify(doc));
      const { result, runner } = scan(p, { application: CLEAN, scanner: CLEAN_SCANNER });
      assert.equal(result.outcome, 'incomplete', label);
      assert.equal(result.exitCode, 2, label);
      assert.ok(result.reasons.some((x) => x.code === 'snapshot_unreadable'), `${label}: ${JSON.stringify(result.reasons)}`);
      assert.equal(runner.calls.length, 0, `${label}: nothing is scanned`);
    });
  });
});

describe('an unaccounted vulnerability reaches the final outcome — through audit() and the evaluate command', () => {
  // The scanner answers are SYNTHETIC (project.mjs), injected at the runner seam audit()
  // already has. The evaluate command is the real CLI, run as its own process.
  const evaluateCommand = (p) => spawnSync(process.execPath, [p.cli, 'evaluate'], { encoding: 'utf8' });
  const within = (answer, fn) => { const p = auditedProject(answer); try { return fn(p); } finally { p.cleanup(); } };

  it('REGRESSION: a HIGH runtime entry with a cause the report does not list is incomplete end to end, and its raw output is kept', () => within(HIGH_RUNTIME_MISSING_CAUSE, (p) => {
    const { result } = p;
    assert.equal(result.outcome, 'incomplete', JSON.stringify(result.reasons));
    assert.equal(result.exitCode, 2);
    assert.equal(result.counts.findings, 0, 'nothing was invented to stand for the missing cause');
    assert.ok(result.reasons.some((r) => r.code === 'scanner_dangling_cause' && /missing-cause/.test(r.detail)));
    assert.match(result.headline, /NOT A CLEAN RESULT/);
    assert.equal(readFileSync(join(p.evidence, 'application.scanner-stdout.txt'), 'utf8'), HIGH_RUNTIME_MISSING_CAUSE.stdout, 'the raw answer is retained byte for byte');
    assert.equal(JSON.parse(readFileSync(join(p.evidence, 'result.json'), 'utf8')).outcome, 'incomplete');
    assert.equal(reevaluate(p.root, { evidenceDir: p.evidence, now: NOW }).outcome, 'incomplete');
    const cli = evaluateCommand(p);
    assert.equal(cli.status, 2, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /AUDIT UNAVAILABLE OR INCOMPLETE — NOT A CLEAN RESULT/);
    assert.match(cli.stdout, /scanner_dangling_cause: application: shipped is listed as vulnerable via missing-cause/);
  }));

  it('REGRESSION: a string-only causal cycle with no advisory is incomplete end to end', () => within(UNGROUNDED_CYCLE, (p) => {
    assert.equal(p.result.outcome, 'incomplete');
    assert.deepEqual([...new Set(p.result.reasons.map((r) => r.code))], ['scanner_ungrounded']);
    const cli = evaluateCommand(p);
    assert.equal(cli.status, 2, cli.stdout + cli.stderr);
  }));

  it('CONTROL: a supported dependency chain passes end to end — the fix is not "refuse every string"', () => within(SUPPORTED_CHAIN, (p) => {
    assert.equal(p.result.outcome, 'within_policy', JSON.stringify(p.result.reasons));
    assert.equal(p.result.counts.triageRequired, 1);
    const cli = evaluateCommand(p);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /REQUIRE TRIAGE \(not zero findings\)/);
  }));
});

describe('the committed policy of THIS repository', () => {
  const ROOT = resolve(new URL('../..', import.meta.url).pathname);
  const policy = JSON.parse(readFileSync(join(ROOT, 'dependency-audit/policy.json'), 'utf8'));

  it('CONTRACT: it names this repository, the public registry and the pinned scanner the scanner lockfile installs', () => {
    assert.equal(policy.schema, 'dinify.dependency-audit.policy/v1');
    assert.match(policy.repository, /^mugak1\/Dinify-(Frontend|Admin)$/);
    assert.equal(policy.scanner.registry, 'https://registry.npmjs.org/');
    const manifest = JSON.parse(readFileSync(join(ROOT, 'dependency-audit/scanner/package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(ROOT, 'dependency-audit/scanner/package-lock.json'), 'utf8'));
    assert.equal(manifest.dependencies.npm, policy.scanner.version);
    assert.equal(lock.packages['node_modules/npm'].version, policy.scanner.version);
    assert.match(lock.packages['node_modules/npm'].integrity, /^sha512-/);
  });

  // The approved set is pinned by id AND by graph, so a record can only join it, or move to
  // another graph, through a reviewed change to this test as well as to the policy. Each one is
  // checked AS OF ITS APPROVAL DATE: whether it is still in date, still matches a finding and
  // still covers exactly its paths is the audit's own decision on every run, and an expired or
  // stale record fails CI there. Every approved record is a TOOLING exception: excepting a
  // runtime finding is a different decision and has to change this test to be made.
  //
  // ONE record remains since the scanner moved to npm 11.21.1. The three 2026-10-01 scanner
  // records were REMEDIATED: 11.21.1 bundles undici 6.29.0 and brace-expansion 5.0.12, whose
  // code carries the fixes. The scanner http-cache-semantics record became STALE, NOT
  // remediated: 11.21.1 bundles 4.3.0, which is outside the advisory's recorded range while the
  // vulnerable max-stale handling is unchanged. GitHub withdrew GHSA-vfj7-8cjw-p6xm (braces) on
  // 2026-10-23, so the braces record matched nothing: STALE, NOT remediated.
  const GRAPH = {
    'application-http-cache-semantics-GHSA-ch52-4w7c-c8xp': 'application',
  };
  it('CONTRACT: the only approved record is the 2026-10-07 application http-cache-semantics tooling exception, pinned to its graph and well-formed as approved', () => {
    assert.deepEqual(policy.records.map((r) => r.id), Object.keys(GRAPH));
    for (const record of policy.records) {
      assert.deepEqual(validateRecord(record, parseDate(record.approval.date)), [], record.id);
      assert.equal(record.kind, 'exception', record.id);
      assert.equal(record.scope, 'tooling', `${record.id} excepts tooling only`);
      assert.equal(record.paths.length, 1, `${record.id} excepts exactly one path`);
      assert.ok(record.paths.every((p) => p.startsWith(`${GRAPH[record.id]}:`)), `${record.id} excepts the ${GRAPH[record.id]} graph only`);
    }
  });

  // Who approved the remaining record, where, and until when. It is retained exactly as the
  // owner approved it on 2026-10-07 and is not renewed automatically.
  it('CONTRACT: the provenance and expiry of every approved record', () => {
    const PROVENANCE = {
      'application-http-cache-semantics-GHSA-ch52-4w7c-c8xp': ['https://github.com/mugak1/Dinify-Admin/pull/42', '2026-10-07'],
    };
    assert.deepEqual(Object.keys(PROVENANCE), Object.keys(GRAPH));
    for (const record of policy.records) {
      const [reference, date] = PROVENANCE[record.id];
      assert.deepEqual(record.approval, { by: 'mugak1', reference, date }, record.id);
      assert.equal(record.owner, 'mugak1', record.id);
      assert.equal(record.expires, '2026-10-31', record.id);
    }
  });

  // The approved record driven through the real evaluator with findings shaped exactly as the
  // pinned scanner reports them, and the subjects of the five records removed with the scanner
  // move. These pin what the committed record DOES cover and what it must keep refusing, and
  // that nothing committed covers a former subject if it is ever reported again (an advisory
  // reinstated or widened, or the scanner rolled back). The generic rules themselves are pinned
  // by the conformance vectors and the core suite.
  describe('the approved exception against its exact subject, and the five former subjects', () => {
    const APP_HCS = 'application-http-cache-semantics-GHSA-ch52-4w7c-c8xp';
    const IN_DATE = '2026-10-30T23:59:59Z';
    const finding = (advisory, alias, pkg, version, path, severity = 'high', scope = 'tooling') => ({ advisory, aliases: [alias], package: pkg, version, path, scope, severity });
    const SUBJECTS = {
      [APP_HCS]: finding('GHSA-ch52-4w7c-c8xp', 'npm:1240991', 'http-cache-semantics', '4.2.0', 'application:node_modules/http-cache-semantics'),
    };
    const FORMER = {
      'scanner-undici-GHSA-rfgv-xxqx-mfg5': finding('GHSA-rfgv-xxqx-mfg5', 'npm:1240042', 'undici', '6.28.0', 'scanner:node_modules/npm/node_modules/undici'),
      'scanner-brace-expansion-GHSA-qhr7-859c-m2p7': finding('GHSA-qhr7-859c-m2p7', 'npm:1240107', 'brace-expansion', '5.0.9', 'scanner:node_modules/npm/node_modules/brace-expansion'),
      'scanner-brace-expansion-GHSA-6j4f-fj2g-mc7p': finding('GHSA-6j4f-fj2g-mc7p', 'npm:1240111', 'brace-expansion', '5.0.9', 'scanner:node_modules/npm/node_modules/brace-expansion'),
      'application-braces-GHSA-vfj7-8cjw-p6xm': finding('GHSA-vfj7-8cjw-p6xm', 'npm:1240992', 'braces', '3.0.3', 'application:node_modules/braces'),
      'scanner-http-cache-semantics-GHSA-ch52-4w7c-c8xp': finding('GHSA-ch52-4w7c-c8xp', 'npm:1240991', 'http-cache-semantics', '4.2.0', 'scanner:node_modules/npm/node_modules/http-cache-semantics'),
    };
    const clone = (f) => ({ ...f, aliases: [...f.aliases] });
    const subjects = () => Object.values(SUBJECTS).map(clone);
    const former = () => Object.values(FORMER).map(clone);
    const replace = (id, change) => subjects().map((f) => (f.path === SUBJECTS[id].path && f.advisory === SUBJECTS[id].advisory ? { ...f, ...change } : f));
    const decide = (findings, { now = IN_DATE, records = policy.records, incomplete = [] } = {}) => evaluate({ incomplete, findings, records, now });
    const status = (result, id) => result.records.find((r) => r.id === id);
    const at = (result, path, advisory) => result.findings.find((x) => x.path === path && x.advisory === advisory);

    it('CONTROL: the record excepts exactly its own subject, and the result says it passes only with exceptions', () => {
      const r = decide(subjects());
      assert.equal(r.outcome, 'exceptions_only', JSON.stringify(r.reasons));
      assert.equal(r.exitCode, 0);
      assert.equal(r.counts.excepted, 1);
      assert.equal(r.counts.blocking, 0);
      assert.equal(r.counts.refusedRecords, 0);
      assert.equal(at(r, SUBJECTS[APP_HCS].path, SUBJECTS[APP_HCS].advisory).coveredBy, APP_HCS);
      assert.equal(status(r, APP_HCS).covers, 1);
    });

    it('CONTRACT: every former subject, if reported again, is open and blocking: nothing committed covers it', () => {
      for (const [id, f] of Object.entries(FORMER)) {
        assert.ok(!policy.records.some((x) => x.id === id), `${id} is no longer committed`);
        const r = decide([...subjects(), clone(f)]);
        assert.equal(r.outcome, 'blocking', id);
        assert.equal(r.exitCode, 1, id);
        const open = at(r, f.path, f.advisory);
        assert.equal(open.disposition, 'open', id);
        assert.equal(open.coveredBy, null, id);
        assert.equal(status(r, APP_HCS).status, 'applied', `${id}: the remaining record still covers its own subject`);
        assert.equal(r.counts.excepted, 1, `${id}: nothing else is excepted`);
      }
      const all = decide([...subjects(), ...former()]);
      assert.equal(all.outcome, 'blocking');
      assert.equal(all.counts.blocking, Object.keys(FORMER).length);
      assert.equal(all.counts.excepted, 1);
      assert.equal(all.counts.refusedRecords, 0);
    });

    it('CONTRACT: the scanner copy of http-cache-semantics is not covered by the application record', () => {
      const scannerHcs = clone(FORMER['scanner-http-cache-semantics-GHSA-ch52-4w7c-c8xp']);
      // Moved, not added: the application subject gone and only the scanner copy reported.
      const r = decide([scannerHcs]);
      assert.equal(r.outcome, 'blocking');
      assert.equal(status(r, APP_HCS).status, 'refused');
      assert.ok(status(r, APP_HCS).problems.some((p) => p.includes(`path ${SUBJECTS[APP_HCS].path} matches no current finding`)));
      const open = at(r, scannerHcs.path, scannerHcs.advisory);
      assert.equal(open.disposition, 'open');
      assert.equal(open.coveredBy, null);
    });

    it('CONTRACT: http-cache-semantics 4.3.0 is not matched by the 4.2.0 record', () => {
      const r = decide(replace(APP_HCS, { version: '4.3.0' }));
      assert.equal(r.outcome, 'blocking');
      assert.equal(status(r, APP_HCS).status, 'refused');
      assert.ok(status(r, APP_HCS).problems.some((p) => p.includes('version 4.2.0 does not match 4.3.0')));
      assert.equal(at(r, SUBJECTS[APP_HCS].path, SUBJECTS[APP_HCS].advisory).disposition, 'open');
    });

    it('CONTRACT: it expires at 00:00 UTC on 2026-10-31 — valid through the second before, refused from it', () => {
      const before = decide(subjects(), { now: '2026-10-30T23:59:59Z' });
      assert.equal(before.outcome, 'exceptions_only');
      assert.equal(before.counts.excepted, 1);
      const lapsed = decide(subjects(), { now: '2026-10-31T00:00:00Z' });
      assert.equal(lapsed.outcome, 'blocking');
      assert.equal(lapsed.counts.excepted, 0);
      assert.deepEqual(status(lapsed, APP_HCS).problems, ['expired on 2026-10-31']);
    });

    it('CONTRACT: a vanished subject refuses its record as stale', () => {
      const r = decide([]);
      assert.equal(r.outcome, 'blocking');
      assert.equal(status(r, APP_HCS).status, 'refused');
      assert.ok(status(r, APP_HCS).problems.some((p) => /stale/.test(p)));
    });

    it('CONTRACT: an alias the scanner does not report refuses the record', () => {
      // The scanner reports the advisory without the alias the record claims.
      const unreported = decide(replace(APP_HCS, { aliases: [] }));
      assert.equal(unreported.outcome, 'blocking');
      assert.equal(status(unreported, APP_HCS).status, 'refused');
      assert.ok(status(unreported, APP_HCS).problems.some((p) => p.includes(`aliases ${SUBJECTS[APP_HCS].aliases[0]} are not reported by the scanner`)));
      // The record claims a second alias the scanner never reported.
      const records = policy.records.map((x) => (x.id === APP_HCS ? { ...x, aliases: [...x.aliases, 'npm:1'] } : x));
      const claimed = decide(subjects(), { records });
      assert.equal(claimed.outcome, 'blocking');
      assert.equal(status(claimed, APP_HCS).status, 'refused');
    });

    it('CONTRACT: a runtime finding, a moved path or malformed approval metadata refuses the record', () => {
      const cases = {
        runtime: [replace(APP_HCS, { scope: 'runtime' })],
        path: [replace(APP_HCS, { path: 'application:node_modules/elsewhere/node_modules/http-cache-semantics' })],
        approval: [subjects(), policy.records.map((x) => (x.id === APP_HCS ? { ...x, approval: { ...x.approval, reference: 'not-a-review-link' } } : x))],
      };
      for (const [label, [findings, records]] of Object.entries(cases)) {
        const r = decide(findings, records ? { records } : {});
        assert.equal(r.outcome, 'blocking', label);
        assert.equal(status(r, APP_HCS).status, 'refused', label);
      }
    });

    it('CONTRACT: an incomplete scan fails closed whatever is excepted', () => {
      const r = decide(subjects(), { incomplete: [{ code: 'scanner_timeout', detail: 'the scanner did not finish' }] });
      assert.equal(r.outcome, 'incomplete');
      assert.equal(r.exitCode, 2);
    });
  });
});
