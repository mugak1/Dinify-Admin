/**
 * A disposable npm project for the regression matrix: a real package.json, a real v3
 * lockfile, a real node_modules tree, the committed policy shape and a scanner directory
 * — so the inventory, binding and orchestration code run against files, not mocks.
 *
 * The scanner's ANSWERS are canned (fixtures of `npm audit --json`), because the matrix
 * has to exercise timeouts, error bodies and truncation deterministically. The live
 * scanner is exercised separately, against the real graph, by `npm run audit:deps`.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { audit, snapshot, verifyScannerPin } from '../lib/audit.mjs';

export const SCANNER_VERSION = '11.19.1';

const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};

export function makeProject({ nodeMajor = Number(process.versions.node.split('.')[0]), records = [], extraLock = {}, skipInstall = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dependency-audit-'));
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { shipped: '^2.0.0' }, devDependencies: { tool: '^1.0.0' } };
  const lock = {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
      'node_modules/shipped': { version: '2.0.0', resolved: 'https://registry.npmjs.org/shipped/-/shipped-2.0.0.tgz', integrity: 'sha512-AAAA' },
      'node_modules/tool': { version: '1.0.0', dev: true, resolved: 'https://registry.npmjs.org/tool/-/tool-1.0.0.tgz', integrity: 'sha512-BBBB',
        optionalDependencies: { 'tool-darwin': '1.0.0' }, dependencies: { helper: '^3.0.0' } },
      'node_modules/tool/node_modules/helper': { version: '3.1.0', dev: true, integrity: 'sha512-CCCC' },
      'node_modules/tool-darwin': { version: '1.0.0', dev: true, optional: true, os: ['darwin'], cpu: ['arm64'], integrity: 'sha512-DDDD' },
      ...extraLock,
    },
  };
  write(join(root, 'package.json'), manifest);
  write(join(root, 'package-lock.json'), lock);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || skipInstall.includes(path)) continue;
    if (entry.os && !entry.os.includes(process.platform)) continue;
    write(join(root, path, 'package.json'), { name: path.split('node_modules/').pop(), version: entry.version });
  }
  write(join(root, 'dependency-audit', 'policy.json'), {
    schema: 'dinify.dependency-audit.policy/v1',
    repository: 'mugak1/Dinify-Fixture',
    ecosystem: 'npm',
    target: { nodeMajor },
    scanner: { package: 'npm', version: SCANNER_VERSION, root: 'dependency-audit/scanner', registry: 'https://registry.npmjs.org/', timeoutSeconds: 60 },
    records,
  });
  const scanner = join(root, 'dependency-audit', 'scanner');
  write(join(scanner, 'package.json'), { name: 'scanner', version: '0.0.0', private: true, dependencies: { npm: SCANNER_VERSION } });
  write(join(scanner, 'package-lock.json'), {
    name: 'scanner', version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'scanner', version: '0.0.0', dependencies: { npm: SCANNER_VERSION } },
      'node_modules/npm': { version: SCANNER_VERSION, integrity: 'sha512-EEEE', dependencies: { bundled: '1.0.0' } },
      'node_modules/npm/node_modules/bundled': { version: '1.0.0', inBundle: true },
    },
  });
  write(join(scanner, 'node_modules', 'npm', 'package.json'), { name: 'npm', version: SCANNER_VERSION });
  write(join(scanner, 'node_modules', 'npm', 'node_modules', 'bundled', 'package.json'), { name: 'bundled', version: '1.0.0' });
  return { root, evidence: join(root, 'dependency-audit', 'evidence'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/**
 * An `npm audit --json` body for `total` locked packages, written the way npm writes one:
 * each entry names itself, carries the most severe of its own advisories unless the
 * fixture states a severity, and the counters count entries by severity. These bodies
 * used to count zero by severity whatever they listed — a shape npm never writes, and
 * one the reader now refuses — so a fixture has to be internally consistent to test
 * anything but that refusal.
 */
export function npmReport(vulnerabilities = {}, total = 4) {
  const body = {};
  const counted = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const own = (entry.via ?? []).filter((v) => v && typeof v === 'object').map((v) => v.severity);
    const severity = 'severity' in entry ? entry.severity : SEVERITIES.filter((s) => own.includes(s)).at(-1);
    body[name] = { name, ...entry, ...(severity === undefined ? {} : { severity }) };
    if (severity in counted) counted[severity] += 1;
  }
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: body,
    metadata: {
      vulnerabilities: { ...counted, total: Object.keys(body).length },
      dependencies: { prod: 1, dev: 3, optional: 1, peer: 0, peerOptional: 0, total },
    },
  });
}

export const via = (name, severity, range, ghsa = 'GHSA-aaaa-bbbb-cccc', source = 1100) => ({
  source, name, dependency: name, title: `${name} advisory`, url: `https://github.com/advisories/${ghsa}`, severity, cwe: [], cvss: {}, range,
});

/** A scanner runner that answers per graph directory, recording every call. */
export function cannedRunner(byGraph) {
  const calls = [];
  const runner = (call) => {
    calls.push(call);
    const graph = call.cwd.endsWith('scanner') ? 'scanner' : 'application';
    const answer = typeof byGraph[graph] === 'function' ? byGraph[graph](call) : byGraph[graph];
    return { command: call.command, args: call.args, cwd: call.cwd, status: 0, signal: null, timedOut: false, error: null, stdout: '', stderr: '', durationMs: 1, ...answer };
  };
  runner.calls = calls;
  return runner;
}

export const CLEAN = { status: 0, stdout: npmReport({}, 4) };
export const CLEAN_SCANNER = { status: 0, stdout: npmReport({}, 2) };
export const NOW = '2026-09-24T12:00:00.000Z';

/**
 * SYNTHETIC answers for the unaccounted-vulnerability boundary, shared by the orchestration
 * suite and each repository's workflow suite. Internally consistent (counters, severity,
 * exit status, real fixture paths), so the only flaw is the one under test.
 */
export const HIGH_RUNTIME_MISSING_CAUSE = { status: 1, stdout: npmReport({ shipped: { severity: 'high', via: ['missing-cause'], nodes: ['node_modules/shipped'] } }) };
export const UNGROUNDED_CYCLE = { status: 1, stdout: npmReport({
  tool: { severity: 'high', via: ['helper'], nodes: ['node_modules/tool'] },
  helper: { severity: 'high', via: ['tool'], nodes: ['node_modules/tool/node_modules/helper'] },
}) };
export const SUPPORTED_CHAIN = { status: 1, stdout: npmReport({
  tool: { severity: 'moderate', via: ['helper'], nodes: ['node_modules/tool'] },
  helper: { severity: 'moderate', via: [via('helper', 'moderate', '>=3.0.0 <3.2.0')], nodes: ['node_modules/tool/node_modules/helper'] },
}) };

/** Installation of the pinned scanner, minus the network: the pin is still verified. */
export const fakeInstall = ({ scannerRoot, policy }) => ({ problems: verifyScannerPin(scannerRoot, policy), summary: { status: 0 } });

/**
 * A fixture project that has been through snapshot → audit() with `answer` injected at the
 * runner seam, and has THIS directory's real CLI installed beside its policy — so the
 * CLI's ROOT and evidence directory are the fixture's own. `evaluateCommand` is the shell
 * that runs that CLI's `evaluate` over the retained evidence.
 */
export function auditedProject(answer) {
  const p = makeProject({});
  snapshot(p.root, { evidenceDir: p.evidence, now: NOW });
  const result = audit(p.root, { evidenceDir: p.evidence, now: NOW, runner: cannedRunner({ application: answer, scanner: CLEAN_SCANNER }), installScanner: fakeInstall });
  const here = new URL('..', import.meta.url).pathname;
  const cli = join(p.root, 'dependency-audit', 'cli.mjs');
  cpSync(join(here, 'cli.mjs'), cli);
  cpSync(join(here, 'lib'), join(p.root, 'dependency-audit', 'lib'), { recursive: true });
  return { ...p, result, cli, evaluateCommand: `exec "${process.execPath}" "${cli}" evaluate` };
}
