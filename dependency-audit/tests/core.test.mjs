/**
 * THE POLICY CORE, against the cross-ecosystem oracle and on its own terms.
 *
 * conformance.json is byte-identical in Dinify-Frontend, Dinify-Admin and Dinify-Backend,
 * and the Python evaluator in Dinify-Backend is tested against the same cases. The digest
 * below is pinned in all three repositories' suites: editing the vectors in one of them
 * fails that suite until the digest — and therefore the change — is made deliberately
 * everywhere. That is how two implementations in two languages are kept to one policy
 * without granting a pull request job access to another repository.
 *
 * Labels: CONTRACT pins a rule this change introduces; CONTROL pins something that must
 * keep passing so a gate that always fails cannot satisfy the suite.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { classify, evaluate, exitCodeFor, headline, parseDate, validateRecord } from '../lib/core.mjs';
import { runConformance, selfTest } from '../lib/self-test.mjs';

const CONFORMANCE_URL = new URL('../conformance.json', import.meta.url);
const BYTES = readFileSync(CONFORMANCE_URL);
const VECTORS = JSON.parse(BYTES.toString('utf8'));

/** Pinned identically in the three repositories. Change it only with the vectors, everywhere. */
export const CONFORMANCE_SHA256 = '341102170ee013d39560a7a919a33bb20218526bc1c8bfedb79aa7a411d67070';

describe('the cross-ecosystem conformance vectors', () => {
  it('CONTRACT: the vectors are the pinned, shared bytes', () => {
    assert.equal(createHash('sha256').update(BYTES).digest('hex'), CONFORMANCE_SHA256);
    assert.equal(VECTORS.schema, 'dinify.dependency-audit.conformance/v1');
  });

  for (const c of VECTORS.cases) {
    it(`vector: ${c.name}`, () => {
      const r = evaluate({ incomplete: c.incomplete, findings: c.findings, records: c.records, now: c.now });
      assert.equal(r.outcome, c.expect.outcome, JSON.stringify(r.reasons));
      assert.equal(r.exitCode, c.expect.exitCode);
      assert.deepEqual(r.records.filter((x) => x.status === 'refused').map((x) => x.id).sort(), c.expect.refused);
      for (const [k, v] of Object.entries(c.expect.counts)) assert.equal(r.counts[k], v, k);
    });
  }

  it('CONTROL: the vectors cover all four outcomes, so no one outcome can satisfy them', () => {
    const outcomes = new Set(VECTORS.cases.map((c) => c.expect.outcome));
    assert.deepEqual([...outcomes].sort(), ['blocking', 'exceptions_only', 'incomplete', 'within_policy']);
  });

  it('CONTRACT: the self-test runs every vector and passes on this build', () => {
    assert.deepEqual(runConformance(VECTORS), []);
    assert.deepEqual(selfTest(), []);
  });

  it('CONTRACT: a core that always passed, or always failed, would fail the vectors', () => {
    // Mutation controls, run through the same comparison the self-test uses.
    const always = (outcome) => ({ cases: VECTORS.cases.map((c) => ({ ...c, expect: { ...c.expect, outcome } })) });
    assert.ok(runConformance(always('within_policy')).length > 0);
    assert.ok(runConformance(always('blocking')).length > 0);
  });
});

describe('the rules, directly', () => {
  it('CONTRACT: high/critical block in every scope; any runtime advisory blocks; lower tooling is triage', () => {
    for (const scope of ['runtime', 'tooling', 'unknown']) {
      assert.equal(classify({ scope, severity: 'critical' }), 'blocking');
      assert.equal(classify({ scope, severity: 'high' }), 'blocking');
    }
    for (const severity of ['moderate', 'low', 'info', 'unknown', 'weird']) assert.equal(classify({ scope: 'runtime', severity }), 'blocking');
    for (const severity of ['moderate', 'low', 'info']) assert.equal(classify({ scope: 'tooling', severity }), 'triage');
    assert.equal(classify({ scope: 'tooling', severity: 'unknown' }), 'unresolved');
    assert.equal(classify({ scope: 'unknown', severity: 'moderate' }), 'unresolved');
  });

  it('CONTRACT: exit codes separate blocking from incomplete, and nothing unknown exits 0', () => {
    assert.equal(exitCodeFor('within_policy'), 0);
    assert.equal(exitCodeFor('exceptions_only'), 0);
    assert.equal(exitCodeFor('blocking'), 1);
    assert.equal(exitCodeFor('incomplete'), 2);
    assert.equal(exitCodeFor('something-new'), 2);
  });

  it('CONTRACT: a triage-only result is never worded as zero findings', () => {
    const r = evaluate({ findings: [{ advisory: 'GHSA-1111-2222-3333', aliases: [], package: 'tool', version: '1.0.0', path: 'application:node_modules/tool', scope: 'tooling', severity: 'moderate' }], now: '2026-01-01T00:00:00Z' });
    assert.equal(r.outcome, 'within_policy');
    assert.match(headline(r), /REQUIRE TRIAGE \(not zero findings\)/);
    assert.doesNotMatch(headline(r), /no advisories/);
  });

  it('CONTRACT: an incomplete result says so in the headline', () => {
    const r = evaluate({ incomplete: [{ code: 'scanner_timeout', detail: 'x' }], now: '2026-01-01T00:00:00Z' });
    assert.match(headline(r), /^AUDIT UNAVAILABLE OR INCOMPLETE — NOT A CLEAN RESULT/);
  });

  it('CONTRACT: a missing decision time is incomplete rather than a free pass for every record', () => {
    assert.equal(evaluate({ findings: [], now: 'not-a-time' }).outcome, 'incomplete');
  });

  it('CONTRACT: dates are calendar dates and a record lapses at 00:00 UTC on its expiry date', () => {
    assert.equal(parseDate('2026-02-30'), null);
    assert.equal(parseDate('2026-2-3'), null);
    assert.notEqual(parseDate('2028-02-29'), null);
    const base = { id: 'EXC-1', kind: 'exception', advisory: 'GHSA-aaaa-bbbb-cccc', aliases: [], package: 'a', version: '1.0.0', paths: ['application:node_modules/a'], scope: 'runtime',
      applicability: 'x'.repeat(20), reason: 'y'.repeat(20), owner: 'o', approval: { by: 'o', reference: 'https://github.com/mugak1/Dinify-Admin/pull/1', date: '2026-09-01' }, expires: '2026-10-01' };
    assert.deepEqual(validateRecord(base, Date.parse('2026-09-30T23:59:59Z')), []);
    assert.match(validateRecord(base, Date.parse('2026-10-01T00:00:00Z')).join(), /expired/);
  });
});
