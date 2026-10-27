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

import {
  HIGH_DEFERRAL_DAYS, OUTCOMES, classify, deferralDeadline, evaluate, exitCodeFor, headline, parseDate, validateRecord,
} from '../lib/core.mjs';
import { runConformance, selfTest } from '../lib/self-test.mjs';

const CONFORMANCE_URL = new URL('../conformance.json', import.meta.url);
const BYTES = readFileSync(CONFORMANCE_URL);
const VECTORS = JSON.parse(BYTES.toString('utf8'));

/** Pinned identically in the three repositories. Change it only with the vectors, everywhere. */
export const CONFORMANCE_SHA256 = '6365e880c55153f5ce50ca144434cb42d5c937be48218445da36cefb8ffb9653';

/**
 * INERTNESS, BYTE FOR BYTE. The first 41 vectors are the ones that existed before the dated
 * obligation (A-1). These are the sha256 digests of the FULL result each of them produced on
 * the evaluator before A-1 (Dinify-Frontend 0079b54 / Dinify-Admin 668b627 / Dinify-Backend
 * e50429d), serialized as `JSON.stringify({ headline, ...result })`. The Python suite pins
 * the SAME digests: on that evaluator the two languages already produced identical bytes.
 * A rule that leaks a `deferred: 0`, a `deadline` or a new reason into a result that
 * deferred nothing changes one of these, and every consumer that re-decides a retained
 * result and compares it exactly would then refuse evidence certified before A-1.
 */
const PRE_DEFERRAL_RESULTS_SHA256 = Object.freeze([
  '4659842661c49f472e5a5c7d92c94a8c36f582c6bf8932efc1f2d2758fe96e0b',
  '6916a116d26094bbaed646964a89651c7e95fdaa447e6650bdb58ec5762fb317',
  '58800523fd48a82c100d205a31a2467901366a17b97cfac02b705b02df6f5a8d',
  '753c81c544689f6a08984f6de9ff68f23aeb7110a8c2b9620cc1f0034bf786b6',
  'b509a94a6527e2b2a50c153d36d1e0120d452f5d9adf564ec785cc6461ec94aa',
  '1e7ca1e20263e798b74a267adf4e0d961b9d51f706739c54a7230f7fc3e28c84',
  '60e8d37cb9c930907e3f4863014a84b3e2510c41f163af99dee5f95404797f41',
  '81f8b5181f02deaf00ff482b82b15710ce22e1f01e87a6bd2a1c928ac095ba05',
  'f346869124d1fbcf1e5eaea551cd869b6807860a8622bdec16cb04d4e82f0270',
  'b7550aea88cf644329a3418a90750497e0c7b2afbb9af46e417d9cd544553d18',
  'a44afe6c338013d7bcd418156e22a478bdc930b4351b238372408ffcaab42b24',
  'd64f763cbb044dd93b92b6cf96f6210b4cdd578e83a13deddf058cea8d04de98',
  '1c971aa6c17d5684c6f52c415fcec44b9b98b58de3a522b40eeeacc28ef01084',
  'f2c69a6fd3a3d05f0453d485f9a22cfa82e93fdd5dbddb7124a48c38ff97413e',
  '9e73cdf5efb50cef32a02f1b695a2d3c07d3ee6bf05d42b81a985466c7380f81',
  '9e73cdf5efb50cef32a02f1b695a2d3c07d3ee6bf05d42b81a985466c7380f81',
  '10aecfd1145c6c3e410b1cbc303edc88e4b83f9ee89629f2d4fdcb71a7d5f738',
  '000fcd469c65dfa828d1ebd60c9fa8af8ea91c13f29658bb179aaf1699f5deda',
  '9e73cdf5efb50cef32a02f1b695a2d3c07d3ee6bf05d42b81a985466c7380f81',
  '9ec5fb47733893902f9daf22ac904ae45ae7735b00b779b7f2acc1736ac3cd9b',
  'cba27976d3289b2d1de73111919a1c25399d052d57cadd9eafd6de1f2715a693',
  'd3df95160f55c844f9dd7235dd97374516f9461b2a2b107cae99a059be949a1c',
  '2ef9a6584f47fb41da84cf753388942fd69a6119dc22a4366c75d77d7d05ac04',
  'a39ecf8a06aa43d6db1e9b81ced45c017c365455d7b13308ffc54c1170bafd8d',
  '5717ec5fae6f990087afd9e77b1b74e71a181ce5e55cfea71f3fff0aded0e889',
  'cba5065d76f52441dc09a316ef992445e2a22436f6bf9494c7f557926d330a77',
  '046aa97db05267a9c748085b6f9f16f7d46126d9e301e8679cbe704b3dbc8df1',
  '046aa97db05267a9c748085b6f9f16f7d46126d9e301e8679cbe704b3dbc8df1',
  '0ab928879d43eb4e05fdad2a5fbc19d61b188201f1258b557b578143abeaa9e3',
  'f961b35afd062902eb6a25125428f250832c1eecde295ab2ed3ddcb05e88ff5f',
  '743af8f7e61e3fd2aedf920bb18b16a61f4b4c86b31ddc3f0b762d6670dec598',
  '60ca9fd7e6ae8b04ac3487013076a045020371dc1f1f665c67fcea71eaa425e0',
  '091f0778a7161d382b5f341aba831ff66996158545fdde7d3a9c4809d94d3e9a',
  '2bf366a1b1c7478f78d6228643e000f67e3a4c1b08c7bebc5857ac2399ba1aad',
  'ff3a3f19f49b463bbcce8e5a6b36fd0630442f33569b203bebbcea742ef78a4d',
  'ba4cc172e5dfc668afdc6b78deb43eb6d257b2dbf4f914d039967e5be64e3067',
  'e84392eb163a85b592b3ee1c29a520a9a67cf49946af4522a0b67df6567ab7af',
  'e45b7fb77f068fe13975744cde9ac647b2f63746eba51587afe0b5f4c9ac5963',
  '76b5f3506d48ff55e83d09f91a5d971afc1355a5a1dc5c92c4f1786c6dd4fa05',
  'e80bb106e9e7b657983eae22e8eda94182aa66683cd85793432a14e7579b5411',
  'f90fedf8401cec088aa7f0827841bbc139c1a0ed922c17734793eee03726e8e7',
]);
const resultDigest = (r) => createHash('sha256').update(JSON.stringify({ headline: headline(r), ...r })).digest('hex');

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
      // The deadlines a vector records (absent: none), and nothing deferral-shaped otherwise.
      const deadlines = c.expect.deadlines ?? [];
      assert.deepEqual(r.findings.filter((f) => f.class === 'deferred').map((f) => f.deadline).sort(), deadlines);
      assert.equal('deferred' in r.counts, deadlines.length > 0, 'the deferred count appears only when a deferral applied');
      assert.equal(r.findings.some((f) => f.class !== 'deferred' && 'deadline' in f), false);
      assert.equal(r.reasons.some((x) => x.code === 'deferred_finding'), deadlines.length > 0);
    });
  }

  it('CONTROL: the vectors cover all five outcomes, so no one outcome can satisfy them', () => {
    const outcomes = new Set(VECTORS.cases.map((c) => c.expect.outcome));
    assert.deepEqual([...outcomes].sort(), [...OUTCOMES].sort());
    assert.deepEqual([...outcomes].sort(), ['blocking', 'exceptions_only', 'incomplete', 'obligations_pending', 'within_policy']);
  });

  it('CONTRACT (inertness): every vector that predates the dated obligation decides byte-identically to before', () => {
    assert.equal(PRE_DEFERRAL_RESULTS_SHA256.length, 41);
    VECTORS.cases.slice(0, 41).forEach((c, i) => {
      const r = evaluate({ incomplete: c.incomplete, findings: c.findings, records: c.records, now: c.now });
      assert.equal(resultDigest(r), PRE_DEFERRAL_RESULTS_SHA256[i], `vector ${i}: ${c.name}`);
    });
  });

  it('CONTRACT: the deferral vectors are appended, so the 41 above keep their positions', () => {
    assert.equal(VECTORS.cases.length, 61);
    assert.equal(VECTORS.cases.slice(0, 41).some((c) => c.name.startsWith('deferral:')), false);
    assert.equal(VECTORS.cases.slice(41).every((c) => c.name.startsWith('deferral:')), true);
  });

  it('CONTRACT: the self-test runs every vector and passes on this build', () => {
    assert.deepEqual(runConformance(VECTORS), []);
    assert.deepEqual(selfTest(), []);
  });

  it('CONTRACT: a core that always passed, or always failed, would fail the vectors', () => {
    // Mutation controls, run through the same comparison the self-test uses.
    const always = (outcome) => ({ cases: VECTORS.cases.map((c) => ({ ...c, expect: { ...c.expect, outcome } })) });
    for (const outcome of OUTCOMES) assert.ok(runConformance(always(outcome)).length > 0, outcome);
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
    assert.equal(exitCodeFor('obligations_pending'), 0);
    assert.equal(exitCodeFor('blocking'), 1);
    assert.equal(exitCodeFor('incomplete'), 2);
    assert.equal(exitCodeFor('something-new'), 2);
    assert.deepEqual(OUTCOMES.map(exitCodeFor), [0, 0, 0, 1, 2], 'the same oracle the Python suite pins');
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

  it('CONTRACT: the deferral window is 7 days for high, and critical has none', () => {
    assert.equal(HIGH_DEFERRAL_DAYS, 7);
    const inherited = { scope: 'tooling', severity: 'high', provenance: 'inherited', reportableSince: '2026-09-30' };
    assert.equal(deferralDeadline(inherited, Date.parse('2026-10-06T23:59:59.999Z')), '2026-10-07');
    assert.equal(deferralDeadline(inherited, Date.parse('2026-10-07T00:00:00Z')), null);
    for (const severity of ['critical', 'moderate', 'low', 'info', 'unknown']) assert.equal(deferralDeadline({ ...inherited, severity }, Date.parse('2026-10-01T00:00:00Z')), null, severity);
    assert.equal(deferralDeadline({ ...inherited, scope: 'runtime' }, Date.parse('2026-10-01T00:00:00Z')), null);
    assert.equal(deferralDeadline(inherited, NaN), null, 'no decision time, no deferral');
    // A deadline that cannot be written as a calendar date is not established: it blocks.
    assert.equal(deferralDeadline({ ...inherited, reportableSince: '9999-12-30' }, Date.parse('9999-12-31T00:00:00Z')), null);
  });

  it('CONTRACT: obligations_pending passes but is never worded as clean, and names its earliest deadline', () => {
    const finding = (advisory, reportableSince) => ({ advisory, aliases: [], package: 'tool', version: '1.0.0', path: `application:node_modules/${advisory}`, scope: 'tooling', severity: 'high', provenance: 'inherited', reportableSince });
    const r = evaluate({ findings: [finding('GHSA-aaaa-0000-0001', '2026-10-02'), finding('GHSA-aaaa-0000-0002', '2026-09-30')], now: '2026-10-03T00:00:00Z' });
    assert.equal(r.outcome, 'obligations_pending');
    assert.equal(r.exitCode, 0);
    assert.match(headline(r), /^AUDIT COMPLETE — PASSES WITH DATED OBLIGATIONS OUTSTANDING: /);
    assert.match(headline(r), /2 inherited high tooling finding\(s\) DEFERRED under a dated obligation \(blocks from 00:00 UTC on 2026-10-07 at the earliest\)/);
    assert.doesNotMatch(headline(r), /WITHIN POLICY|no advisories/);
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
