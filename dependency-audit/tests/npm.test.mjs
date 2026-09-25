/**
 * THE npm ADAPTER: what is inventoried, how the scanner is invoked, and how every shape of
 * scanner answer is read. Scanner answers are fixtures — a synthetic advisory here is a
 * test input, never a claim that such a vulnerability exists in any Dinify dependency.
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluate } from '../lib/core.mjs';
import { explainAbsences, inventory, readReport, resolveEdge, scannerArgs, scannerEnvironment, sha256 } from '../lib/npm.mjs';
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

describe('every declared vulnerability is accounted for by evidence the report carries', () => {
  // The scanner's answers below are SYNTHETIC unless a title says CAPTURED. They are
  // internally consistent (counters, severities, exit status and inventory paths all
  // agree) so each case isolates ONE flaw, and the refusal it expects comes from the
  // decoder rather than from an unrelated count. They are malformed on purpose: healthy
  // npm does not emit these shapes, and nothing here claims a Dinify scan did.
  const captured = (file) => {
    const doc = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
    assert.equal(sha256(doc.stdout), doc.stdoutSha256, `${file}: the fixture is not the bytes that were captured`);
    const inv = { packages: doc.packages.map(([path, version, scope]) => ({ path: `application:${path}`, version, scope })) };
    return { run: { status: doc.status, stdout: doc.stdout }, inv, report: JSON.parse(doc.stdout) };
  };

  it('CONTROL (CAPTURED, Dinify-Admin 5074511): a real clean report of a 794-package inventory is within policy with zero findings', () => {
    const c = captured('captured-admin-5074511.json');
    assert.equal(c.inv.packages.length, 794);
    const r = decide(c.run, c.inv);
    assert.equal(r.outcome, 'within_policy', JSON.stringify(r.reasons));
    assert.equal(r.counts.findings, 0);
  });

  it('CONTROL (CAPTURED, Dinify-Frontend 1e339ed): npm\'s own dependency chains are accepted and decided on the advisories they are traced to', () => {
    // Real npm 11.19.1 output: firebase-tools is listed through three packages by NAME,
    // and @google-cloud/pubsub through @opentelemetry/core — a two-level chain.
    const c = captured('captured-frontend-1e339ed.json');
    assert.deepEqual(c.report.vulnerabilities['firebase-tools'].via, ['@google-cloud/pubsub', 'csv-parse', 'stream-json']);
    assert.deepEqual(c.report.vulnerabilities['@google-cloud/pubsub'].via, ['@opentelemetry/core']);
    const read = readReport({ graph: 'application', run: c.run, inv: c.inv });
    assert.deepEqual(read.problems, []);
    const r = decide(c.run, c.inv);
    assert.equal(r.outcome, 'within_policy', JSON.stringify(r.reasons));
    // Five vulnerable packages, three advisories: one finding per advisory and path, and
    // none for the packages listed only through a dependency.
    assert.equal(Object.keys(c.report.vulnerabilities).length, 5);
    assert.deepEqual(r.findings.map((f) => [f.package, f.advisory, f.scope, f.class]).sort(), [
      ['@opentelemetry/core', 'GHSA-8988-4f7v-96qf', 'tooling', 'triage'],
      ['csv-parse', 'GHSA-8cw4-87c7-c6xx', 'tooling', 'triage'],
      ['stream-json', 'GHSA-528h-pc64-c93x', 'tooling', 'triage'],
    ]);
    assert.equal(r.counts.triageRequired, 3, 'lower-severity tooling findings stay visible — never zero findings');
  });

  describe('against a fixture project whose shipped package has runtime dependencies', () => withProject({
    extraLock: {
      'node_modules/shipped': { version: '2.0.0', resolved: 'https://registry.npmjs.org/shipped/-/shipped-2.0.0.tgz', integrity: 'sha512-AAAA', dependencies: { inner: '^1.0.0', dup: '^1.0.0' } },
      'node_modules/inner': { version: '1.0.0', integrity: 'sha512-HHHH' },
      'node_modules/dup': { version: '1.0.0', integrity: 'sha512-FFFF' },
      'node_modules/tool/node_modules/dup': { version: '1.2.0', dev: true, integrity: 'sha512-GGGG' },
    },
  }, ({ root }) => {
    const inv = inventory(root, { graph: 'application', env: LINUX });
    const total = inv.counts.locked;
    const answer = (vulns) => {
      const body = npmReport(vulns, total);
      const counts = JSON.parse(body).metadata.vulnerabilities;
      return { status: ['low', 'moderate', 'high', 'critical'].some((s) => counts[s] > 0) ? 1 : 0, stdout: body };
    };
    const read = (vulns) => readReport({ graph: 'application', run: answer(vulns), inv });
    const codes = (r) => r.problems.map((p) => p.code);
    const on = { shipped: ['node_modules/shipped'], inner: ['node_modules/inner'], tool: ['node_modules/tool'], helper: ['node_modules/tool/node_modules/helper'], dup: ['node_modules/dup', 'node_modules/tool/node_modules/dup'] };

    it('CONTROL: the fixture inventory is itself clean evidence', () => {
      assert.deepEqual(inv.problems, []);
      assert.equal(inv.packages.find((p) => p.name === 'inner').scope, 'runtime');
    });

    it('CONTROL: a genuinely empty package-name map, with consistent counters, is within policy', () => {
      const r = decide(answer({}), inv);
      assert.equal(r.outcome, 'within_policy');
      assert.equal(r.counts.findings, 0);
    });

    it('CONTRACT: a complete direct advisory on a runtime package blocks', () => {
      const r = decide(answer({ inner: { severity: 'low', via: [via('inner', 'low', '<2.0.0')], nodes: on.inner } }), inv);
      assert.equal(r.outcome, 'blocking');
      assert.deepEqual(r.findings.map((f) => [f.path, f.scope]), [['application:node_modules/inner', 'runtime']]);
    });

    it('CONTRACT: a supported TOOLING chain is decided on the advisory it is traced to — strings are not rejected', () => {
      const r = decide(answer({
        tool: { severity: 'moderate', via: ['helper'], nodes: on.tool, effects: [] },
        helper: { severity: 'moderate', via: [via('helper', 'moderate', '>=3.0.0 <3.2.0')], nodes: on.helper, effects: ['tool'] },
      }), inv);
      assert.equal(r.outcome, 'within_policy', JSON.stringify(r.reasons));
      assert.deepEqual(r.findings.map((f) => [f.package, f.path, f.class]), [['helper', 'application:node_modules/tool/node_modules/helper', 'triage']]);
    });

    it('CONTRACT: a supported RUNTIME chain keeps its runtime exposure and blocks', () => {
      const r = decide(answer({
        shipped: { severity: 'moderate', via: ['inner'], nodes: on.shipped, effects: [] },
        inner: { severity: 'moderate', via: [via('inner', 'moderate', '<2.0.0')], nodes: on.inner, effects: ['shipped'] },
      }), inv);
      assert.equal(r.outcome, 'blocking');
      assert.deepEqual(r.findings.map((f) => [f.package, f.scope]), [['inner', 'runtime']]);
    });

    it('CONTRACT: several advisories and paths behind several dependents — attributed per advisory and path, not per package', () => {
      const r = decide(answer({
        dup: { severity: 'high', via: [via('dup', 'moderate', '<2.0.0', 'GHSA-aaaa-bbbb-0001', 2001), via('dup', 'high', '>=1.2.0 <1.3.0', 'GHSA-aaaa-bbbb-0002', 2002)], nodes: on.dup, effects: ['shipped', 'tool'] },
        shipped: { severity: 'moderate', via: ['dup'], nodes: on.shipped, effects: [] },
        tool: { severity: 'high', via: ['dup'], nodes: on.tool, effects: [] },
      }), inv);
      assert.equal(r.outcome, 'blocking');
      // Three vulnerable packages, three findings — but NOT one per package: the moderate
      // advisory covers both installed copies, the high one only the copy in its range, and
      // the two dependents add nothing of their own.
      assert.deepEqual(r.findings.map((f) => [f.advisory, f.path, f.scope]).sort(), [
        ['GHSA-aaaa-bbbb-0001', 'application:node_modules/dup', 'runtime'],
        ['GHSA-aaaa-bbbb-0001', 'application:node_modules/tool/node_modules/dup', 'tooling'],
        ['GHSA-aaaa-bbbb-0002', 'application:node_modules/tool/node_modules/dup', 'tooling'],
      ]);
    });

    it('CONTRACT: a legitimate cycle that reaches an advisory is accepted, not refused for being a cycle', () => {
      const r = decide(answer({
        tool: { severity: 'moderate', via: [via('tool', 'moderate', '<2.0.0'), 'helper'], nodes: on.tool, effects: ['helper'] },
        helper: { severity: 'moderate', via: ['tool'], nodes: on.helper, effects: ['tool'] },
      }), inv);
      assert.equal(r.outcome, 'within_policy', JSON.stringify(r.reasons));
      assert.deepEqual(r.findings.map((f) => f.package), ['tool']);
    });

    it('REGRESSION: a HIGH runtime entry whose only cause the report does not list is incomplete, not zero findings', () => {
      const answerIs = read({ shipped: { severity: 'high', via: ['missing-cause'], nodes: on.shipped } });
      assert.deepEqual(answerIs.findings, []);
      assert.ok(codes(answerIs).includes('scanner_dangling_cause'), JSON.stringify(answerIs.problems));
      const r = evaluate({ incomplete: answerIs.problems, findings: answerIs.findings, records: [], now: NOW });
      assert.equal(r.outcome, 'incomplete');
      assert.equal(r.exitCode, 2);
    });

    it('REGRESSION: a string-only causal cycle with no advisory is incomplete, and a very long one neither hangs nor overflows', () => {
      const small = read({ tool: { severity: 'high', via: ['helper'], nodes: on.tool }, helper: { severity: 'high', via: ['tool'], nodes: on.helper } });
      assert.deepEqual(codes(small), ['scanner_ungrounded', 'scanner_ungrounded']);
      assert.match(small.problems[0].detail, /loop back/);
      // 20 000 entries in one ring, each vulnerable only via the next — far past any
      // recursion limit, and a walk that followed a cycle would never finish.
      const ring = {};
      for (let i = 0; i < 20000; i += 1) ring[`p${i}`] = { severity: 'high', via: [`p${(i + 1) % 20000}`], nodes: on.tool };
      const started = Date.now();
      const big = read(ring);
      assert.equal(big.problems.filter((p) => p.code === 'scanner_ungrounded').length, 20000);
      assert.ok(Date.now() - started < 10000, 'the ring was decided in bounded time — a per-entry walk takes minutes');
    });

    it('REGRESSION: one valid finding beside one unaccounted entry is incomplete — the valid part does not hide the missing part', () => {
      const answerIs = read({
        helper: { severity: 'moderate', via: [via('helper', 'moderate', '>=3.0.0 <3.2.0')], nodes: on.helper },
        shipped: { severity: 'high', via: ['missing-cause'], nodes: on.shipped },
      });
      assert.equal(answerIs.findings.length, 1, 'the valid finding is still reported');
      const r = evaluate({ incomplete: answerIs.problems, findings: answerIs.findings, records: [], now: NOW });
      assert.equal(r.outcome, 'incomplete');
    });

    it('REGRESSION: a vulnerabilities value that is not the package-name map is incomplete, whatever the counters say', () => {
      for (const [label, value] of [['an empty list', []], ['a list', [{ name: 'shipped' }]], ['null', null], ['zero', 0], ['a string', 'shipped'], ['true', true]]) {
        const listed = Array.isArray(value) ? value.length : 0;
        const stdout = JSON.stringify({ auditReportVersion: 2, vulnerabilities: value, metadata: { vulnerabilities: { info: 0, low: 0, moderate: listed, high: 0, critical: 0, total: listed }, dependencies: { total } } });
        const answerIs = readReport({ graph: 'application', run: { status: listed ? 1 : 0, stdout }, inv });
        assert.deepEqual(codes(answerIs), ['scanner_shape'], `${label}: ${JSON.stringify(answerIs.problems)}`);
        assert.equal(evaluate({ incomplete: answerIs.problems, findings: answerIs.findings, records: [], now: NOW }).exitCode, 2, label);
      }
    });

    it('REGRESSION: malformed metadata and counters are a controlled incomplete result, never a TypeError', () => {
      const base = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, dependencies: { total } } });
      const shapes = {
        'metadata null': (d) => { d.metadata = null; },
        'metadata a list': (d) => { d.metadata = []; },
        'dependencies null': (d) => { d.metadata.dependencies = null; },
        'vulnerability counters null': (d) => { d.metadata.vulnerabilities = null; },
        'vulnerability counters a list': (d) => { d.metadata.vulnerabilities = []; },
        'a counter missing': (d) => { delete d.metadata.vulnerabilities.high; },
        'a fractional counter': (d) => { d.metadata.vulnerabilities.low = 0.5; },
        'a counter as a string': (d) => { d.metadata.vulnerabilities.total = '0'; },
        'a negative counter': (d) => { d.metadata.vulnerabilities.info = -1; d.metadata.vulnerabilities.low = 1; },
      };
      for (const [label, mutate] of Object.entries(shapes)) {
        const doc = base();
        mutate(doc);
        let answerIs;
        assert.doesNotThrow(() => { answerIs = readReport({ graph: 'application', run: { status: 0, stdout: JSON.stringify(doc) }, inv }); }, label);
        assert.equal(answerIs.problems.length, 1, `${label}: ${JSON.stringify(answerIs.problems)}`);
        assert.equal(evaluate({ incomplete: answerIs.problems, findings: answerIs.findings, records: [], now: NOW }).outcome, 'incomplete', label);
      }
    });

    it('REGRESSION: malformed entries and via members are named, never filtered out of a report that then passes', () => {
      const good = via('helper', 'moderate', '>=3.0.0 <3.2.0');
      const shapes = {
        'an entry that is null': { helper: null },
        'an entry that is a list': { helper: [] },
        'an entry with no via': { helper: { severity: 'moderate', nodes: on.helper } },
        'an entry with an empty via': { helper: { severity: 'moderate', via: [], nodes: on.helper } },
        'a node that is not a path': { helper: { severity: 'moderate', via: [good], nodes: [...on.helper, 7] } },
        'a numeric via member beside a valid advisory': { helper: { severity: 'moderate', via: [good, 42] } },
        'a null via member beside a valid advisory': { helper: { severity: 'moderate', via: [good, null] } },
        'a list as a via member beside a valid advisory': { helper: { severity: 'moderate', via: [good, []] } },
        'a boolean via member beside a valid advisory': { helper: { severity: 'moderate', via: [good, true] } },
        'an empty cause beside a valid advisory': { helper: { severity: 'moderate', via: [good, ''] } },
        'an unknown entry severity': { helper: { severity: 'severe', via: [good] } },
        'an advisory whose source is not an id': { helper: { severity: 'moderate', via: [{ ...good, source: { id: 1 } }] } },
        'an advisory filed under another package': { helper: { severity: 'moderate', via: [{ ...good, name: 'shipped', dependency: 'shipped' }] } },
        'an entry that names another package': { helper: { name: 'shipped', severity: 'moderate', via: [good] } },
      };
      for (const [label, vulns] of Object.entries(shapes)) {
        for (const e of Object.values(vulns)) if (e && !Array.isArray(e) && !e.nodes && e.via) e.nodes = on.helper;
        const counted = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
        for (const e of Object.values(vulns)) if (e && e.severity in counted) counted[e.severity] += 1;
        if (!Object.values(counted).some(Boolean)) counted.moderate = 1;
        const stdout = JSON.stringify({ auditReportVersion: 2, vulnerabilities: vulns, metadata: { vulnerabilities: { ...counted, total: 1 }, dependencies: { total } } });
        let answerIs;
        assert.doesNotThrow(() => { answerIs = readReport({ graph: 'application', run: { status: 1, stdout }, inv }); }, label);
        assert.ok(answerIs.problems.length > 0, `${label}: nothing was said`);
        const r = evaluate({ incomplete: answerIs.problems, findings: answerIs.findings, records: [], now: NOW });
        assert.equal(r.outcome, 'incomplete', `${label}: ${JSON.stringify(r.reasons)}`);
      }
    });

    it('REGRESSION: counters that do not describe the entries are incomplete', () => {
      const stdout = JSON.stringify({ auditReportVersion: 2, vulnerabilities: JSON.parse(npmReport({ tool: { severity: 'low', via: [via('tool', 'low', '<2.0.0')], nodes: on.tool } }, total)).vulnerabilities,
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 }, dependencies: { total } } });
      const answerIs = readReport({ graph: 'application', run: { status: 1, stdout }, inv });
      assert.ok(codes(answerIs).includes('scanner_inconsistent'), JSON.stringify(answerIs.problems));
    });

    it('REGRESSION: an entry more severe than every advisory it is traced to is incomplete — the HIGH is not accounted for', () => {
      const answerIs = read({
        tool: { severity: 'high', via: ['helper'], nodes: on.tool },
        helper: { severity: 'moderate', via: [via('helper', 'moderate', '>=3.0.0 <3.2.0')], nodes: on.helper },
      });
      assert.deepEqual(codes(answerIs), ['scanner_unaccounted']);
    });

    it('REGRESSION: a runtime entry traced only to tooling paths is incomplete — its runtime exposure is not silently lost', () => {
      const answerIs = read({
        shipped: { severity: 'moderate', via: ['helper'], nodes: on.shipped },
        helper: { severity: 'moderate', via: [via('helper', 'moderate', '>=3.0.0 <3.2.0')], nodes: on.helper },
      });
      assert.deepEqual(codes(answerIs), ['scanner_unattributed']);
      assert.equal(answerIs.findings[0].scope, 'tooling', 'the only finding the report supports is a tooling one');
    });

    it('CONTRACT: the exit status follows npm\'s own rule — an info-only report exits 0 and is read, and 1 there is inconsistent', () => {
      const body = npmReport({ tool: { severity: 'info', via: [via('tool', 'info', '<2.0.0')], nodes: on.tool } }, total);
      const r = decide({ status: 0, stdout: body }, inv);
      assert.equal(r.outcome, 'within_policy', JSON.stringify(r.reasons));
      assert.equal(r.counts.triageRequired, 1, 'an info finding is visible, not zero findings');
      assert.ok(codes(readReport({ graph: 'application', run: { status: 1, stdout: body }, inv })).includes('scanner_inconsistent'));
    });
  }));
});
