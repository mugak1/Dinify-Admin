/**
 * THE SELF-TEST — run before every real audit, for the reason the repository's other
 * gates run theirs: an evaluator that silently stopped refusing would pass everything,
 * and "the tree is clean today" is not evidence that a gate works.
 *
 * Offline and deterministic. It proves, in this order:
 *   1. every conformance vector (the cross-ecosystem oracle) decides as recorded;
 *   2. a known-clean npm report passes — so a gate that always fails cannot pass here;
 *   3. a known runtime advisory blocks, a tooling moderate is triage (not zero), and a
 *      package vulnerable only through another is decided on the advisory it is traced
 *      to; a cause the report does not list, an error body, an empty body, an unparseable
 *      body, an uncounted graph and an exit-status/body contradiction are each incomplete.
 * Returns the list of failures; empty means trustworthy.
 */

import { readFileSync } from 'node:fs';

import { evaluate } from './core.mjs';
import { readReport } from './npm.mjs';

const CONFORMANCE = new URL('../conformance.json', import.meta.url);

export function runConformance(doc) {
  const failures = [];
  for (const c of doc.cases) {
    const r = evaluate({ incomplete: c.incomplete, findings: c.findings, records: c.records, now: c.now });
    const refused = r.records.filter((x) => x.status === 'refused').map((x) => x.id).sort();
    const errs = [];
    if (r.outcome !== c.expect.outcome) errs.push(`outcome ${r.outcome} ≠ ${c.expect.outcome}`);
    if (r.exitCode !== c.expect.exitCode) errs.push(`exit ${r.exitCode} ≠ ${c.expect.exitCode}`);
    if (JSON.stringify(refused) !== JSON.stringify(c.expect.refused)) errs.push(`refused [${refused}] ≠ [${c.expect.refused}]`);
    for (const [k, v] of Object.entries(c.expect.counts)) if (r.counts[k] !== v) errs.push(`${k} ${r.counts[k]} ≠ ${v}`);
    if (errs.length) failures.push(`conformance "${c.name}": ${errs.join('; ')}`);
  }
  return failures;
}

const INV = {
  packages: [
    { path: 'application:node_modules/shipped', name: 'shipped', version: '2.0.0', scope: 'runtime' },
    { path: 'application:node_modules/tool', name: 'tool', version: '1.0.0', scope: 'tooling' },
    { path: 'application:node_modules/tool/node_modules/helper', name: 'helper', version: '3.1.0', scope: 'tooling' },
  ],
};
const advisory = (name, severity, range) => ({ source: 1, name, dependency: name, title: 't', url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkl', severity, range });
/** A body the way npm writes one: entries name themselves, counters count entries by severity. */
const report = (vulnerabilities) => {
  const counted = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const body = {};
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    body[name] = { name, ...entry };
    counted[entry.severity] += 1;
  }
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities: body, metadata: { vulnerabilities: { ...counted, total: Object.keys(body).length }, dependencies: { total: INV.packages.length } } });
};
const decide = (run) => {
  const r = readReport({ graph: 'application', run, inv: INV });
  return evaluate({ incomplete: r.problems, findings: r.findings, records: [], now: '2026-01-01T00:00:00Z' });
};

export function selfTest() {
  const failures = runConformance(JSON.parse(readFileSync(CONFORMANCE, 'utf8')));
  const expect = (label, run, outcome, extra = () => true) => {
    const r = decide(run);
    if (r.outcome !== outcome || !extra(r)) failures.push(`control "${label}": got ${r.outcome} ${JSON.stringify(r.counts)}`);
  };
  expect('known-clean report passes', { status: 0, stdout: report({}) }, 'within_policy', (r) => r.counts.findings === 0);
  expect('runtime advisory blocks', { status: 1, stdout: report({ shipped: { severity: 'low', via: [advisory('shipped', 'low', '<3.0.0')], nodes: ['node_modules/shipped'] } }) }, 'blocking');
  expect('tooling moderate is triage, not zero', { status: 1, stdout: report({ tool: { severity: 'moderate', via: [advisory('tool', 'moderate', '<2.0.0')], nodes: ['node_modules/tool'] } }) }, 'within_policy', (r) => r.counts.triageRequired === 1);
  expect('a package vulnerable through another is decided on the advisory it is traced to', { status: 1, stdout: report({
    tool: { severity: 'moderate', via: ['helper'], nodes: ['node_modules/tool'] },
    helper: { severity: 'moderate', via: [advisory('helper', 'moderate', '<4.0.0')], nodes: ['node_modules/tool/node_modules/helper'] },
  }) }, 'within_policy', (r) => r.counts.findings === 1 && r.counts.triageRequired === 1);
  expect('a cause the report does not list is incomplete', { status: 1, stdout: report({ shipped: { severity: 'high', via: ['missing-cause'], nodes: ['node_modules/shipped'] } }) }, 'incomplete');
  expect('error body is incomplete', { status: 1, stdout: JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'endpoint unavailable' } }) }, 'incomplete');
  expect('empty output is incomplete', { status: 0, stdout: '' }, 'incomplete');
  expect('truncated output is incomplete', { status: 1, stdout: report({}).slice(0, 20) }, 'incomplete');
  expect('an uncounted graph is incomplete', { status: 0, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 }, dependencies: { total: 0 } } }) }, 'incomplete');
  expect('status 0 with findings is incomplete', { status: 0, stdout: report({ tool: { severity: 'high', via: [advisory('tool', 'high', '<2.0.0')], nodes: ['node_modules/tool'] } }) }, 'incomplete');
  expect('a timeout is incomplete', { status: null, timedOut: true, stdout: '' }, 'incomplete');
  return failures;
}
