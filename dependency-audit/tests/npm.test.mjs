/**
 * THE npm ADAPTER: what is inventoried, how the scanner is invoked, and how every shape of
 * scanner answer is read. Scanner answers are fixtures — a synthetic advisory here is a
 * test input, never a claim that such a vulnerability exists in any Dinify dependency.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluate } from '../lib/core.mjs';
import { explainAbsences, inventory, readReport, resolveEdge, scannerArgs, scannerEnvironment } from '../lib/npm.mjs';
import { satisfies } from '../lib/range.mjs';
import { makeProject, npmReport, NOW, via } from './project.mjs';

const LINUX = { node: 'v24.21.0', platform: 'linux', arch: 'x64', libc: 'glibc' };

function withProject(options, fn) {
  const p = makeProject(options);
  try { return fn(p); } finally { p.cleanup(); }
}

const decide = (run, inv) => {
  const r = readReport({ graph: 'application', run, inv });
  return evaluate({ incomplete: r.problems, findings: r.findings, records: [], now: NOW });
};

describe('the inventory: the lock graph the scanner reads, proved to be the tree that was installed', () => {
  it('CONTROL: a lock graph whose installed tree corresponds is usable evidence', () => withProject({}, ({ root }) => {
    const inv = inventory(root, { graph: 'application', env: LINUX });
    assert.deepEqual(inv.problems, []);
    assert.equal(inv.counts.locked, 4);
    assert.equal(inv.counts.installed, 3);
    const darwin = inv.packages.find((p) => p.name === 'tool-darwin');
    assert.equal(darwin.absence, 'platform', 'a platform-specific optional package is classified, not silently dropped');
    assert.equal(inv.packages.find((p) => p.name === 'shipped').scope, 'runtime');
    assert.equal(inv.packages.find((p) => p.name === 'tool').scope, 'tooling');
    assert.match(inv.digests.lockfileSha256, /^[0-9a-f]{64}$/);
  }));

  it('CONTRACT: a locked package that is not installed, with no platform reason, refuses the inventory', () => withProject({ skipInstall: ['node_modules/tool/node_modules/helper'] }, ({ root }) => {
    const inv = inventory(root, { graph: 'application', env: LINUX });
    assert.deepEqual(inv.problems.map((p) => p.code), ['not_installed']);
  }));

  it('CONTRACT: an installed version that differs from the lock refuses the inventory', () => withProject({}, ({ root }) => {
    writeFileSync(join(root, 'node_modules/shipped/package.json'), JSON.stringify({ name: 'shipped', version: '2.0.1' }));
    assert.deepEqual(inventory(root, { graph: 'application', env: LINUX }).problems.map((p) => p.code), ['installed_version_mismatch']);
  }));

  it('CONTRACT: an installed package the lock does not know is refused as extraneous', () => withProject({}, ({ root }) => {
    mkdirSync(join(root, 'node_modules/stowaway'), { recursive: true });
    writeFileSync(join(root, 'node_modules/stowaway/package.json'), JSON.stringify({ name: 'stowaway', version: '0.0.1' }));
    assert.deepEqual(inventory(root, { graph: 'application', env: LINUX }).problems.map((p) => p.code), ['extraneous']);
  }));

  it('CONTRACT: a lockfile that does not match package.json is refused', () => withProject({}, ({ root }) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { shipped: '^2.0.0', other: '1.0.0' }, devDependencies: { tool: '^1.0.0' } }));
    const codes = inventory(root, { graph: 'application', env: LINUX }).problems.map((p) => p.code);
    assert.ok(codes.includes('lock_manifest_mismatch'));
    assert.ok(codes.includes('missing_declared'));
  }));

  it('CONTRACT: an empty lock graph is refused, never vacuously clean', () => withProject({}, ({ root }) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } }));
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    assert.deepEqual(inventory(root, { graph: 'application', env: LINUX }).problems.map((p) => p.code), ['empty_inventory']);
  }));

  it('CONTRACT: no lockfile is refused', () => withProject({}, ({ root }) => {
    rmSync(join(root, 'package-lock.json'));
    assert.deepEqual(inventory(root, { graph: 'application' }).problems.map((p) => p.code), ['no_lockfile']);
  }));

  it('CONTRACT: absences are explained the way npm decides them — platform, engines, and pruned optional subtrees', () => {
    const packages = {
      '': { dependencies: { rollup: '1' } },
      'node_modules/rollup': { version: '1.0.0', dev: true, optionalDependencies: { 'binding-wasm': '1', 'lzma-gnu': '1' } },
      'node_modules/binding-wasm': { version: '1.0.0', dev: true, optional: true, cpu: ['wasm32'], dependencies: { runtime: '1' } },
      'node_modules/runtime': { version: '1.0.0', dev: true, optional: true, peerDependencies: { core: '1' } },
      'node_modules/core': { version: '1.0.0', dev: true, optional: true, peer: true },
      'node_modules/lzma-gnu': { version: '1.0.0', dev: true, optional: true, os: ['linux'], cpu: ['x64'], engines: { node: '^22.20 || ^24.12 || >=25' } },
      'node_modules/orphan-optional': { version: '1.0.0', dev: true, optional: true },
    };
    const installed = new Map([['node_modules/rollup', '1.0.0']]);
    const why20 = explainAbsences(packages, installed, { ...LINUX, node: 'v20.20.2' });
    assert.equal(why20.get('node_modules/binding-wasm'), 'platform');
    assert.equal(why20.get('node_modules/runtime'), 'optional-subtree');
    assert.equal(why20.get('node_modules/core'), 'optional-subtree');
    assert.equal(why20.get('node_modules/lzma-gnu'), 'engines');
    assert.equal(why20.has('node_modules/orphan-optional'), false, 'an optional package nobody explains stays a problem');
    const why24 = explainAbsences(packages, installed, LINUX);
    assert.equal(why24.has('node_modules/lzma-gnu'), false, 'on a Node that satisfies its engines, its absence is NOT explained');
  });

  it('CONTRACT: lock-path resolution walks up the tree as Node does', () => {
    const packages = { 'node_modules/a': {}, 'node_modules/b': {}, 'node_modules/a/node_modules/b': {}, 'node_modules/@s/c': {} };
    assert.equal(resolveEdge(packages, 'node_modules/a', 'b'), 'node_modules/a/node_modules/b');
    assert.equal(resolveEdge(packages, 'node_modules/@s/c', 'b'), 'node_modules/b');
    assert.equal(resolveEdge(packages, '', '@s/c'), 'node_modules/@s/c');
    assert.equal(resolveEdge(packages, 'node_modules/a', 'missing'), null);
  });
});

describe('the scanner invocation cannot be narrowed by what it inherits', () => {
  it('CONTRACT: every dependency type is included explicitly and the registry is pinned', () => {
    const args = scannerArgs('https://registry.npmjs.org/');
    for (const t of ['prod', 'dev', 'optional', 'peer']) assert.ok(args.includes(`--include=${t}`), t);
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--package-lock=true'), 'npm audit reads the lock graph; package-lock=false would switch it to an ideal tree');
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
    assert.ok(!args.some((a) => a.startsWith('--omit') || a.startsWith('--audit-level') || a === '--production'));
  });

  it('REGRESSION: an inherited NODE_ENV=production or npm_config_omit never reaches the scanner', () => {
    // Measured on main: with NODE_ENV=production `npm audit --json` reported ZERO findings
    // for a graph with five, while metadata still counted every package.
    const { env, removed } = scannerEnvironment({ PATH: '/bin', NODE_ENV: 'production', npm_config_omit: 'dev', NPM_CONFIG_PRODUCTION: 'true', npm_config_registry: 'https://evil.example/', NODE_OPTIONS: '--require x', HOME: '/h' });
    assert.equal(env.NODE_ENV, undefined);
    assert.equal(env.npm_config_omit, undefined);
    assert.equal(env.NPM_CONFIG_PRODUCTION, undefined);
    assert.equal(env.npm_config_registry, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.PATH, '/bin');
    assert.deepEqual(removed, ['NODE_ENV', 'NODE_OPTIONS', 'NPM_CONFIG_PRODUCTION', 'npm_config_omit', 'npm_config_registry']);
  });
});

describe('reading a scanner answer', () => withProject({}, ({ root }) => {
  const inv = inventory(root, { graph: 'application', env: LINUX });

  it('CONTROL: a complete, clean report is within policy with zero findings', () => {
    const r = decide({ status: 0, stdout: npmReport({}, 4) }, inv);
    assert.equal(r.outcome, 'within_policy');
    assert.equal(r.counts.findings, 0);
  });

  it('CONTRACT: an applicable runtime advisory blocks', () => {
    const r = decide({ status: 1, stdout: npmReport({ shipped: { name: 'shipped', severity: 'low', via: [via('shipped', 'low', '<2.1.0')], nodes: ['node_modules/shipped'] } }) }, inv);
    assert.equal(r.outcome, 'blocking');
    assert.equal(r.findings[0].scope, 'runtime');
    assert.equal(r.findings[0].advisory, 'GHSA-aaaa-bbbb-cccc');
    assert.deepEqual(r.findings[0].aliases, ['npm:1100']);
  });

  it('CONTRACT: a HIGH advisory only on a build/test path still blocks', () => {
    const r = decide({ status: 1, stdout: npmReport({ helper: { name: 'helper', severity: 'high', via: [via('helper', 'high', '>=3.0.0 <3.2.0')], nodes: ['node_modules/tool/node_modules/helper'] } }) }, inv);
    assert.equal(r.outcome, 'blocking');
    assert.equal(r.findings[0].scope, 'tooling');
  });

  it('CONTRACT: a lower-severity build-only finding is visible triage, never zero findings', () => {
    const r = decide({ status: 1, stdout: npmReport({ tool: { name: 'tool', severity: 'moderate', via: [via('tool', 'moderate', '<2.0.0')], nodes: ['node_modules/tool'] } }) }, inv);
    assert.equal(r.outcome, 'within_policy');
    assert.equal(r.counts.findings, 1);
    assert.equal(r.counts.triageRequired, 1);
  });

  it('CONTRACT: unknown severity on tooling is incomplete, not a low-risk exemption', () => {
    const v = via('tool', 'catastrophic', '<2.0.0');
    const r = decide({ status: 1, stdout: npmReport({ tool: { name: 'tool', via: [v], nodes: ['node_modules/tool'] } }) }, inv);
    assert.equal(r.outcome, 'incomplete');
  });

  it('CONTRACT: an advisory is attributed only to the nodes its range names; an unreadable range to all of them', () => {
    const two = inv;
    const nodes = ['node_modules/tool', 'node_modules/tool/node_modules/helper'];
    const precise = readReport({ graph: 'application', run: { status: 1, stdout: npmReport({ x: { via: [via('x', 'moderate', '>=3.0.0 <4.0.0')], nodes } }) }, inv: two });
    assert.deepEqual(precise.findings.map((f) => f.path), ['application:node_modules/tool/node_modules/helper']);
    const vague = readReport({ graph: 'application', run: { status: 1, stdout: npmReport({ x: { via: [via('x', 'moderate', 'who knows')], nodes } }) }, inv: two });
    assert.equal(vague.findings.length, 2, 'over-attribution is the safe direction');
  });

  const incompleteCases = [
    ['a scanner timeout', { status: null, signal: 'SIGTERM', timedOut: true, stdout: '' }, 'scanner_timeout'],
    ['a scanner that could not start', { status: null, error: 'ENOENT spawn npm', stdout: '' }, 'scanner_error'],
    ['a scanner killed by a signal', { status: null, signal: 'SIGKILL', stdout: '' }, 'scanner_signal'],
    ['an unexpected exit status', { status: 3, stdout: npmReport({}, 4) }, 'scanner_status'],
    ['empty output', { status: 0, stdout: '' }, 'scanner_empty'],
    ['non-JSON output', { status: 1, stdout: 'npm ERR! network request failed' }, 'scanner_unparseable'],
    ['truncated JSON', { status: 1, stdout: npmReport({}, 4).slice(0, 40) }, 'scanner_unparseable'],
    ['the body npm really printed when the advisory endpoint was unreachable', { status: 1, stdout: JSON.stringify({ message: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9', error: { summary: '', detail: '' } }) }, 'scanner_reported_error'],
    ['an error body (a bad registry response)', { status: 1, stdout: JSON.stringify({ error: { code: 'EAUDITNOLOCK', summary: 'Neither npm-shrinkwrap.json nor package-lock.json found' } }) }, 'scanner_reported_error'],
    ['an unsupported report version', { status: 0, stdout: JSON.stringify({ auditReportVersion: 1, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 }, dependencies: { total: 4 } } }) }, 'scanner_format'],
    ['an empty counted inventory', { status: 0, stdout: npmReport({}, 0) }, 'coverage_empty'],
    ['a count that is not the lock graph', { status: 0, stdout: npmReport({}, 3) }, 'coverage_mismatch'],
    ['exit 0 contradicting listed findings', { status: 0, stdout: npmReport({ tool: { via: [via('tool', 'low', '<9')], nodes: ['node_modules/tool'] } }) }, 'scanner_inconsistent'],
    ['exit 1 with nothing to explain it', { status: 1, stdout: npmReport({}, 4) }, 'scanner_status'],
    ['an advisory on a node outside the inventory', { status: 1, stdout: npmReport({ ghost: { via: [via('ghost', 'low', '<9')], nodes: ['node_modules/ghost'] } }) }, 'coverage_unknown_node'],
  ];
  it('CONTRACT: a network failure names its real cause rather than "unspecified"', () => {
    const report = readReport({ graph: 'application', run: { status: 1, stdout: JSON.stringify({ message: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9', error: { summary: '', detail: '' } }) }, inv });
    assert.match(report.problems[0].detail, /ECONNREFUSED/);
  });

  for (const [label, run, code] of incompleteCases) {
    it(`CONTRACT: ${label} is incomplete and the required check fails`, () => {
      const report = readReport({ graph: 'application', run, inv });
      assert.ok(report.problems.some((p) => p.code === code), JSON.stringify(report.problems));
      const r = evaluate({ incomplete: report.problems, findings: report.findings, records: [], now: NOW });
      assert.equal(r.outcome, 'incomplete');
      assert.equal(r.exitCode, 2);
    });
  }
}));

describe('the range subset', () => {
  it('CONTRACT: advisory and engines ranges', () => {
    assert.equal(satisfies('4.3.1', '>=4.0.0 <4.3.2'), true);
    assert.equal(satisfies('4.3.2', '>=4.0.0 <4.3.2'), false);
    assert.equal(satisfies('6.15.3', '>=2.2.5 <6.16.0'), true);
    assert.equal(satisfies('3.1.5', '3.0.0 - 3.1.5'), true);
    assert.equal(satisfies('1.0.0', '<1.0.0 || >=2.0.0'), false);
    assert.equal(satisfies('20.20.2', '^22.20 || ^24.12 || >=25'), false);
    assert.equal(satisfies('24.21.0', '^22.20 || ^24.12 || >=25'), true);
    assert.equal(satisfies('20.20.2', '^20.19.0 || ^22.13.0 || >=23.5.0'), true);
    assert.equal(satisfies('0.2.5', '^0.2.3'), true);
    assert.equal(satisfies('0.3.0', '^0.2.3'), false);
    assert.equal(satisfies('1.2.9', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2'), false);
    assert.equal(satisfies('2.0.0-rc.1', '<2.0.0'), true, 'prereleases are included — the direction that reports more');
  });

  it('CONTRACT: anything outside the subset is null, never a guess', () => {
    assert.equal(satisfies('1.0.0', 'latest'), null);
    assert.equal(satisfies('not-a-version', '>=1.0.0'), null);
  });

  // Codex review on #698: npm evaluates advisory ranges with `includePrerelease`, under
  // which node-semver floors every lower bound it DERIVES from a partial version at the
  // lowest prerelease (`>=1.0` is `>=1.0.0-0`). Reading `>=1.0` as `>=1.0.0` dropped a
  // prerelease node npm itself calls vulnerable. Every literal below was checked against
  // the scanner's own node-semver with npm's options.
  it('REGRESSION: a lower bound derived from a partial version admits its prereleases, as npm does', () => {
    assert.equal(satisfies('1.0.0-beta.1', '>=1.0'), true);
    assert.equal(satisfies('1.2.0-rc.1', '^1.2'), true);
    assert.equal(satisfies('1.2.0-rc.1', '~1.2'), true);
    assert.equal(satisfies('1.0.0-0', '1.x'), true);
    assert.equal(satisfies('1.0.0-0', '1'), true);
    assert.equal(satisfies('1.3.0-alpha', '>1.2'), true);
    assert.equal(satisfies('1.2.3-beta', '1.2.3 - 2'), true, 'a hyphen range floors its start even when it is a full version');
  });

  it('CONTROL: a lower bound STATED as a full version keeps exactly what it says', () => {
    assert.equal(satisfies('1.0.0-beta.1', '>=1.0.0'), false);
    assert.equal(satisfies('1.0.0-beta.1', '>=1.0.0 <2'), false);
    assert.equal(satisfies('1.2.3-beta', '^1.2.3'), false);
    assert.equal(satisfies('1.2.3-beta', '~1.2.3'), false);
    assert.equal(satisfies('0.9.9', '>=1.0'), false);
    assert.equal(satisfies('2.0.0-0', '1.x'), false, 'the derived upper bound is exclusive of its own floor');
  });

  it('CONTRACT: a partial node-semver refuses to read is null, not a guess', () => {
    assert.equal(satisfies('1.2.2', '1.x.2'), null);
    assert.equal(satisfies('1.2.0', '>=1.2-beta'), null);
  });

  it('REGRESSION: a runtime prerelease keeps its attribution beside a matching tooling copy', () => withProject({
    extraLock: {
      'node_modules/shipped': { version: '2.0.0', resolved: 'https://registry.npmjs.org/shipped/-/shipped-2.0.0.tgz', integrity: 'sha512-AAAA', dependencies: { dup: '^1.0.0-beta.1' } },
      'node_modules/dup': { version: '1.0.0-beta.1', integrity: 'sha512-FFFF' },
      'node_modules/tool/node_modules/dup': { version: '1.2.0', dev: true, integrity: 'sha512-GGGG' },
    },
  }, ({ root }) => {
    // The attribution rule keeps only the nodes the range names whenever ANY node matches,
    // so a mis-read prerelease is not over-attributed back in: it is silently dropped, and
    // a moderate advisory on shipped code read as build-only triage.
    const inv = inventory(root, { graph: 'application', env: LINUX });
    assert.deepEqual(inv.problems, []);
    const nodes = ['node_modules/dup', 'node_modules/tool/node_modules/dup'];
    const r = decide({ status: 1, stdout: npmReport({ dup: { name: 'dup', severity: 'moderate', via: [via('dup', 'moderate', '>=1.0')], nodes } }, inv.counts.locked) }, inv);
    assert.deepEqual(r.findings.map((f) => [f.path, f.scope]).sort(), [['application:node_modules/dup', 'runtime'], ['application:node_modules/tool/node_modules/dup', 'tooling']]);
    assert.equal(r.outcome, 'blocking', 'a runtime advisory blocks at any severity');
  }));
});
