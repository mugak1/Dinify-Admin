/**
 * A disposable npm project for the regression matrix: a real package.json, a real v3
 * lockfile, a real node_modules tree, the committed policy shape and a scanner directory
 * — so the inventory, binding and orchestration code run against files, not mocks.
 *
 * The scanner's ANSWERS are canned (fixtures of `npm audit --json`), because the matrix
 * has to exercise timeouts, error bodies and truncation deterministically. The live
 * scanner is exercised separately, against the real graph, by `npm run audit:deps`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** An `npm audit --json` body for `total` locked packages. */
export function npmReport(vulnerabilities = {}, total = 4) {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(vulnerabilities).length },
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
