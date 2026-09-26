/**
 * THE WORKFLOWS — the committed ci.yml and deploy.yml, held to the release contract.
 *
 * Two kinds of test, labelled as such:
 *   STATIC   — the parsed workflow files: which job holds what permission, which code
 *              each job can run, which artifacts are fetched how, and in what order.
 *   EXECUTED — a step's actual `run:` text, taken from the file and run under bash the
 *              way the runner runs `shell: bash` (`-eo pipefail`), with `gh`, `curl`,
 *              `aws` and (where the step would reach the network) `node` replaced by
 *              stubs that exit 99 on anything they do not recognise. The verify step runs
 *              the REAL CLI from a fixture checkout.
 *
 * NOT PROVED here: GitHub itself (queueing, concurrency, masking, artifact storage),
 * OIDC, AWS, SSM or the live host. Those are stated as not proved in the README.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { simulateJob } from '../../dependency-audit/tests/workflow-harness.mjs';
import { parseYaml } from '../../dependency-audit/tests/yaml-subset.mjs';
import { decideAdmission } from '../lib/admission.mjs';
import { recordBytes } from '../lib/common.mjs';
import { sha256Hex } from '../lib/tree.mjs';
import { EVAL_RUN_ID, REPO_ROOT, evaluatedProject, git } from './fixtures.mjs';
import { remoteScriptOf } from './host-model.mjs';

const DEPLOY_TEXT = readFileSync(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
const DEPLOY = parseYaml(DEPLOY_TEXT);
const CI = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const PREPARE = DEPLOY.jobs.prepare.steps;
const PRIV = DEPLOY.jobs.deploy.steps;
const VALIDATE = CI.jobs.validate.steps;
const step = (steps, name) => { const s = steps.find((x) => x.name === name); assert.ok(s, `no step "${name}"`); return s; };
const index = (steps, name) => steps.findIndex((x) => x.name === name);
const OIDC = 'Configure AWS credentials (OIDC)';

/** Run a step's `run:` text as `shell: bash` does, in `cwd`, with stub tools first on PATH. */
function execStep(run, { env = {}, stubs = {}, cwd }) {
  const bin = mkdtempSync(join(tmpdir(), 'stubs-'));
  try {
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${bin}/calls.log"\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(bin, 'calls.log'), '');
    const file = join(bin, 'step.sh');
    writeFileSync(file, run);
    const output = join(bin, 'github_output');
    writeFileSync(output, '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      cwd, encoding: 'utf8', timeout: 60000,
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: bin, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'mugak1/Dinify-Admin', ...env },
    });
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs, calls: readFileSync(join(bin, 'calls.log'), 'utf8') };
  } finally { rmSync(bin, { recursive: true, force: true }); }
}

describe('STATIC: the privilege boundary', () => {
  it('CONTRACT: only the deploy job can request an OIDC token; prepare holds contents:read and actions:read and nothing else', () => {
    assert.deepEqual(DEPLOY.jobs.prepare.permissions, { contents: 'read', actions: 'read' });
    assert.equal(DEPLOY.jobs.deploy.permissions['id-token'], 'write');
    for (const [name, job] of Object.entries(DEPLOY.jobs)) if (name !== 'deploy') assert.notEqual(job.permissions?.['id-token'], 'write', name);
    assert.equal(DEPLOY.permissions, undefined, 'no workflow-level grant for a job to inherit');
    assert.equal(CI.jobs.validate.permissions?.['id-token'], undefined);
  });

  it('CONTRACT: no npm, npx, build, package script or checkout of the target runs in the privileged job', () => {
    for (const s of PRIV) {
      const text = `${s.run ?? ''}`;
      assert.doesNotMatch(text, /\bnpm\b|\bnpx\b|\bng build\b|\byarn\b|\bpnpm\b/, s.name);
      assert.doesNotMatch(text, /node\s+(?!trusted\/release\/cli\.mjs\b)\S+\.m?js/, `${s.name}: node runs only the trusted verifier`);
      assert.doesNotMatch(text, /(bash|sh|node)\s+candidate\//, `${s.name}: the candidate is data`);
    }
    const checkouts = PRIV.filter((s) => String(s.uses).startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 1);
    assert.equal(checkouts[0].with.ref, '${{ github.sha }}', 'the verifier is the workflow revision, never the target');
    assert.equal(checkouts[0].with['persist-credentials'], false);
    assert.equal(checkouts[0].with.path, 'trusted');
    assert.deepEqual(String(checkouts[0].with['sparse-checkout']).trim().split('\n').map((x) => x.trim()), ['release', 'dependency-audit']);
  });

  it('CONTRACT: prepare runs no application build and no install of the application graph either', () => {
    for (const s of PREPARE) assert.doesNotMatch(`${s.run ?? ''}`, /\bnpm (ci|install|run)\b|\bng build\b/, s.name);
    const checkout = PREPARE.find((s) => String(s.uses).startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}');
  });

  it('CONTRACT: every step before the OIDC exchange is workflow shell, a first-party action, or the trusted verifier — and verification comes first', () => {
    const oidc = index(PRIV, OIDC);
    assert.ok(oidc > 0);
    assert.ok(index(PRIV, 'Verify the admission (privileged re-decision, before any credential)') < oidc);
    assert.ok(index(PRIV, 'Validate deploy role ARN') < oidc);
    for (const s of PRIV.slice(0, oidc)) {
      if (s.uses) assert.match(s.uses, /^actions\/(checkout|setup-node|download-artifact)@[0-9a-f]{40}$/, s.name);
    }
    for (const s of PRIV.slice(oidc + 1)) if (s.uses) assert.fail(`${s.name}: no action runs after the credential exists`);
  });

  it('CONTRACT: every action in ci.yml and deploy.yml is pinned to a full commit SHA', () => {
    for (const wf of [CI, DEPLOY]) {
      for (const job of Object.values(wf.jobs)) for (const s of job.steps) if (s.uses) assert.match(s.uses, /@[0-9a-f]{40}$/, s.uses);
    }
  });

  it('CONTRACT: no event-derived or step-derived value is interpolated into a script; no secret is referenced', () => {
    for (const s of [...PREPARE, ...PRIV]) assert.doesNotMatch(`${s.run ?? ''}`, /\$\{\{/, `${s.name} interpolates into run:`);
    assert.doesNotMatch(DEPLOY_TEXT, /\$\{\{\s*secrets\./, 'no stored secret: the credential is OIDC');
  });

  it('CONTRACT: artifacts are fetched BY ID with digest enforcement — never by name', () => {
    const downloads = [...PREPARE, ...PRIV].filter((s) => String(s.uses).startsWith('actions/download-artifact@'));
    assert.equal(downloads.length, 3);
    for (const d of downloads) {
      assert.equal(d.with['digest-mismatch'], 'error', d.name);
      assert.ok(d.with['artifact-ids'], d.name);
      assert.equal(d.with.name, undefined, d.name);
    }
  });

  it('CONTRACT: automatic deployment hangs off a successful CI run only — no push, schedule or pull_request trigger', () => {
    assert.deepEqual(Object.keys(DEPLOY.on).sort(), ['workflow_dispatch', 'workflow_run']);
    assert.deepEqual(DEPLOY.on.workflow_run.workflows, ['CI']);
    assert.ok(DEPLOY.on.workflow_dispatch.inputs.ci_run_id, 'a manual run may name the certifying run');
  });

  it('CONTRACT: the S3 upload, the remote script and SSM are all gated on the ordering decision, and the upload on a CERTIFIED deploy', () => {
    for (const name of ['Validate deploy role ARN', OIDC, 'Write remote deploy script', 'Deploy via SSM and verify the box\'s own attestation', 'Assert the public origin serves the admitted release']) {
      assert.match(String(step(PRIV, name).if), /steps\.ordering\.outputs\.proceed == 'true'/, name);
    }
    assert.match(String(step(PRIV, 'Upload the admitted payload archive to the private S3 prefix').if), /steps\.verify\.outputs\.kind == 'certified'/);
  });
});

describe('STATIC: certification in ci.yml', () => {
  it('CONTRACT: prebuild opens the chain before the build, freeze follows the mock-isolation scan, certify follows the audit', () => {
    const at = (cmd) => VALIDATE.findIndex((s) => s.run === cmd);
    assert.ok(at('npm run release:prebuild') < at('npm run build:prod'));
    assert.ok(at('npm run check:mock-isolation') < at('npm run release:freeze'));
    assert.ok(at('npm run audit:deps') < at('npm run release:certify'));
  });

  it('CONTRACT: the candidate is uploaded ONLY when every gate passed, named by run and attempt', () => {
    const upload = step(VALIDATE, 'Retain the certified candidate');
    assert.equal(upload.if, undefined);
    assert.equal(upload['continue-on-error'], undefined);
    assert.equal(upload.with.name, 'admin-candidate-${{ github.run_id }}-${{ github.run_attempt }}');
    assert.equal(upload.with.path, 'release/.work/candidate/');
    // Every gate failure → the upload is skipped (GitHub's sequencing, simulated).
    for (const gate of VALIDATE.filter((s) => typeof s.run === 'string' && VALIDATE.indexOf(s) < VALIDATE.indexOf(upload))) {
      const r = simulateJob(VALIDATE, (s) => (s === gate ? 'failure' : 'success'));
      assert.deepEqual(r.ran.find(([n]) => n === upload.name), [upload.name, 'skipped'], gate.name);
      assert.equal(r.conclusion, 'failure');
    }
    const clean = simulateJob(VALIDATE, () => 'success');
    assert.deepEqual(clean.ran.find(([n]) => n === upload.name), [upload.name, 'success']);
  });

  it('CONTRACT: the dependency-audit evidence is retained whatever happened (it is evidence, not a candidate)', () => {
    assert.equal(step(VALIDATE, 'Retain the dependency-audit evidence').if, 'always()');
  });
});

describe('STATIC: the verifier imports only what the privileged job has', () => {
  it('CONTRACT: release/cli.mjs reaches only node: built-ins, release/ and dependency-audit/lib/', () => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        if (spec.startsWith('node:')) { assert.ok(builtinModules.includes(spec.slice(5)), spec); continue; }
        assert.ok(spec.startsWith('.'), `${relative(REPO_ROOT, file)} imports a package: ${spec}`);
        const target = resolve(dirname(file), spec);
        const rel = relative(REPO_ROOT, target);
        assert.match(rel, /^(release\/(cli\.mjs|lib\/[^/]+\.mjs)|dependency-audit\/lib\/[^/]+\.mjs)$/, `${relative(REPO_ROOT, file)} → ${rel}`);
        visit(target);
      }
      assert.doesNotMatch(text, /\bimport\s*\(/, `${relative(REPO_ROOT, file)} has a dynamic import`);
    };
    visit(join(REPO_ROOT, 'release', 'cli.mjs'));
    assert.ok(seen.size >= 8);
  });

  it('CONTRACT: every CLI invocation in deploy.yml names only options its command accepts (the CLI refuses any other)', () => {
    const source = readFileSync(join(REPO_ROOT, 'release', 'cli.mjs'), 'utf8');
    const table = source.slice(source.indexOf('const OPTIONS = {'), source.indexOf('};', source.indexOf('const OPTIONS = {')));
    const accepted = (cmd) => {
      const m = table.match(new RegExp(`'?${cmd}'?: \\[([^\\]]*)\\]`));
      assert.ok(m, `no OPTIONS entry for ${cmd}`);
      return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
    };
    const joined = DEPLOY_TEXT.replace(/\\\n\s*/g, ' ');
    const calls = [...joined.matchAll(/node trusted\/release\/cli\.mjs (\S+)([^\n|>)]*)/g)];
    assert.ok(calls.length >= 10);
    for (const [, cmd, rest] of calls) for (const [, opt] of rest.matchAll(/--([a-z-]+)/g)) assert.ok(accepted(cmd).includes(opt), `${cmd} --${opt}`);
  });

  it('CONTRACT: dependency-audit/lib/retained.mjs is Dinify-Frontend\'s file, byte for byte (4ce0183)', () => {
    assert.equal(sha256Hex(readFileSync(join(REPO_ROOT, 'dependency-audit', 'lib', 'retained.mjs'))), '5453f5f289f5740ce82356a8fcfd310162bfdbf868b9f9efe527d81a976a7ab5');
  });
});

describe('EXECUTED: the remote script is written from verified values only', () => {
  const writer = step(PRIV, 'Write remote deploy script');
  const base = {
    TARGET_SHA: 'a1'.repeat(20), MODE: 'deploy', KIND: 'certified', ARTIFACT_SHA256: 'b'.repeat(64), S3_KEY: `admin/${'a1'.repeat(20)}/${'b'.repeat(64)}.tar.gz`,
    PAYLOAD_TREE: 'c'.repeat(64), INDEX_SHA256: 'd'.repeat(64), DEADLINE_EPOCH: '1790510644',
  };
  const run = (env) => {
    const cwd = mkdtempSync(join(tmpdir(), 'writer-'));
    try {
      const r = execStep(writer.run, { env, cwd });
      return { ...r, script: existsSync(join(cwd, 'deploy.sh')) ? readFileSync(join(cwd, 'deploy.sh'), 'utf8') : null, pwned: existsSync(join(cwd, 'pwned')) || existsSync('/tmp/pwned-release-test') };
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  };

  it('CONTROL: a certified deploy writes exactly the embedded procedure with the verified values substituted', () => {
    const r = run(base);
    assert.equal(r.status, 0, r.stderr);
    let expected = remoteScriptOf(DEPLOY_TEXT);
    for (const [k, v] of Object.entries(base)) expected = expected.split(`__${k}__`).join(v);
    assert.equal(r.script.replace(/\n$/, ''), expected);
  });

  it('CONTRACT: a certified ROLLBACK carries no S3 path, and a legacy rollback carries no payload identity, whatever it was handed', () => {
    const rb = run({ ...base, MODE: 'rollback' });
    assert.equal(rb.status, 0, rb.stderr);
    assert.match(rb.script, /^ARTIFACT_SHA256=""$/m);
    assert.match(rb.script, /^S3_KEY=""$/m);
    const lg = run({ ...base, MODE: 'rollback', KIND: 'legacy' });
    assert.equal(lg.status, 0, lg.stderr);
    assert.match(lg.script, /^PAYLOAD_TREE=""$/m);
    assert.match(lg.script, /^DEADLINE_EPOCH="0"$/m);
  });

  for (const [label, over] of [
    ['a command substitution in the target', { TARGET_SHA: '$(touch pwned)' }],
    ['a sed delimiter in the payload tree', { PAYLOAD_TREE: `${'c'.repeat(63)}|` }],
    ['a newline in the S3 key', { S3_KEY: `admin/x\nrm -rf /` }],
    ['an unknown kind', { KIND: 'trusted' }],
    ['a certified release with no deadline', { DEADLINE_EPOCH: '' }],
    ['a legacy DEPLOY', { KIND: 'legacy' }],
    ['a mode that is not deploy or rollback', { MODE: 'deploy;id' }],
  ]) {
    it(`REGRESSION MATRIX: ${label} → refused before substitution, nothing executes`, () => {
      const r = run({ ...base, ...over });
      assert.equal(r.status, 1, r.stdout);
      assert.equal(r.pwned, false);
    });
  }
});

describe('EXECUTED: the upload re-hashes the archive it is about to send', () => {
  const upload = step(PRIV, 'Upload the admitted payload archive to the private S3 prefix');
  const withCandidate = (bytes, fn) => {
    const cwd = mkdtempSync(join(tmpdir(), 'upload-'));
    try { mkdirSync(join(cwd, 'candidate')); writeFileSync(join(cwd, 'candidate', 'payload.tar.gz'), bytes); return fn(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
  };
  const aws = 'if [ "$1 $2" = "s3 cp" ]; then exit 0; fi; echo "unexpected aws $*" >&2; exit 99';

  it('CONTROL: the admitted archive is uploaded under admin/<sha>/<archive sha256>.tar.gz', () => withCandidate(Buffer.from('archive'), (cwd) => {
    const r = execStep(upload.run, { cwd, env: { TARGET_SHA: 'a1'.repeat(20), ARCHIVE_SHA256: sha256Hex(Buffer.from('archive')), ARTIFACT_BUCKET: 'bucket' }, stubs: { aws } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.s3_key, `admin/${'a1'.repeat(20)}/${sha256Hex(Buffer.from('archive'))}.tar.gz`);
    assert.match(r.calls, /^aws s3 cp candidate\/payload\.tar\.gz s3:\/\/bucket\/admin\//m);
  }));

  it('REGRESSION: bytes that are not the verified archive are never uploaded', () => withCandidate(Buffer.from('swapped'), (cwd) => {
    const r = execStep(upload.run, { cwd, env: { TARGET_SHA: 'a1'.repeat(20), ARCHIVE_SHA256: sha256Hex(Buffer.from('archive')), ARTIFACT_BUCKET: 'bucket' }, stubs: { aws } });
    assert.equal(r.status, 1);
    assert.equal(r.calls, '');
  }));
});

describe('EXECUTED: the ordering guard (automatic runs), against stubbed curl, gh and served-check', () => {
  const guard = step(PRIV, 'Forward-only ordering guard (automatic runs only)');
  const TARGET = 'a1'.repeat(20);
  const SERVED = 'b2'.repeat(20);
  const curl = (body, { code = 200, cache = 'no-store' } = {}) => `
d=""; prev=""
for a in "$@"; do [ "$prev" = "-D" ] && d="$a"; prev="$a"; done
[ -n "$d" ] && printf 'HTTP/2 ${code}\\ncache-control: ${cache}\\n' > "$d"
printf '%s\\n${code}' '${body}'`;
  const gh = (status, base) => `echo '{"status":"${status}","merge_base_commit":{"sha":"${base}"}}'`;
  const node = (exit) => `[ "$2" = served ] || { echo "unexpected node $*" >&2; exit 99; }; echo '{"mismatched":["main.js"],"unreachable":[]}'; exit ${exit}`;
  const run = ({ source = 'automatic', curlBody = SERVED, curlOpts = {}, compare = ['ahead', SERVED], served = 0 } = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), 'guard-'));
    try {
      return execStep(guard.run, {
        cwd, env: { TARGET_SHA: TARGET, SOURCE: source, PUBLIC_HOST: 'admin.example.invalid', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' },
        stubs: { curl: curl(curlBody, curlOpts), gh: gh(...compare), node: node(served) },
      });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  };

  it('CONTROL: a manual run is not subject to the automatic policy', () => {
    const r = run({ source: 'manual' });
    assert.equal(r.status, 0);
    assert.deepEqual([r.outputs.proceed, r.outputs.decision], ['true', 'MANUAL']);
    assert.equal(r.calls, '');
  });
  it('CONTROL: a target that descends from the served commit proceeds', () => {
    const r = run();
    assert.deepEqual([r.status, r.outputs.proceed, r.outputs.decision], [0, 'true', 'AUTO-PROCEED']);
  });
  it('REGRESSION: a stale automatic run never downgrades the origin', () => {
    const r = run({ compare: ['behind', TARGET] });
    assert.deepEqual([r.status, r.outputs.proceed, r.outputs.decision], [0, 'false', 'AUTO-SKIP-STALE']);
  });
  it('CONTRACT: the same commit served with EVERY admitted file matching → identical artifact; a mismatch is only "same commit", never evidence of this candidate', () => {
    const same = run({ curlBody: TARGET, served: 0 });
    assert.deepEqual([same.status, same.outputs.proceed, same.outputs.decision], [0, 'false', 'AUTO-SKIP-IDENTICAL-ARTIFACT']);
    const other = run({ curlBody: TARGET, served: 1 });
    assert.deepEqual([other.status, other.outputs.proceed, other.outputs.decision], [0, 'false', 'AUTO-SKIP-SAME-COMMIT']);
    assert.match(other.outputs.reason, /NOT evidence that this candidate is served/);
  });
  for (const [label, opts] of [
    ['diverged histories', { compare: ['diverged', 'e'.repeat(40)] }],
    ['an unreadable served SHA', { curlBody: 'not a sha' }],
    ['a cacheable release.txt', { curlOpts: { cache: 'max-age=300' } }],
    ['a failed read', { curlOpts: { code: 503 } }],
  ]) {
    it(`REGRESSION MATRIX: ${label} → fail closed, nothing proceeds`, () => {
      const r = run(opts);
      assert.equal(r.status, 1);
      assert.notEqual(r.outputs.proceed, 'true');
    });
  }
});

describe('EXECUTED: the privileged verify step, running the REAL verifier from a fixture checkout', () => {
  const verifyStep = step(PRIV, 'Verify the admission (privileged re-decision, before any credential)');

  /**
   * A workspace laid out as the deploy job leaves it: `trusted` (the fixture repository,
   * carrying the real verifier code), `facts/` (the API's answers — MODELLED from the
   * fixture's git objects), `candidate/` and `admission/`.
   */
  function workspace(p, { admissionRecord, admissionAttempt = '1', listingDigest, candidate = true } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), 'deploy-job-'));
    symlinkSync(p.root, join(cwd, 'trusted'));
    const facts = join(cwd, 'facts');
    mkdirSync(facts);
    const top = { sha: p.facts.topTree.sha, tree: p.facts.topTree.tree };
    const w = (n, v) => writeFileSync(join(facts, n), JSON.stringify(v));
    w('commit.json', p.facts.commit); w('tree.json', p.facts.tree); w('trusted-tree.json', top); w('main-tree.json', top);
    w('ci-workflow.json', p.facts.ciWorkflow); w('run.json', p.facts.run); w('artifacts.json', p.facts.artifacts);
    const record = admissionRecord ?? decideAdmission(p.input()).record;
    const bytes = recordBytes(record);
    mkdirSync(join(cwd, 'admission'));
    writeFileSync(join(cwd, 'admission', 'admission.json'), bytes);
    cpSync(p.assessmentDir, join(cwd, 'admission', 'assessment'), { recursive: true });
    const digest = sha256Hex(Buffer.concat([bytes, Buffer.from('zip')]));
    w('run-artifacts.json', { total_count: 1, artifacts: [{ id: 7770001, name: `admin-admission-${EVAL_RUN_ID}-${admissionAttempt}`, digest: `sha256:${listingDigest ?? digest}`, expired: false }] });
    if (candidate) cpSync(p.candidateDir, join(cwd, 'candidate'), { recursive: true });
    return { cwd, digest, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const envFor = (p, ws, over = {}) => ({
    TARGET_SHA: p.commit, MODE: 'deploy', SOURCE: 'automatic', ADMISSION_ID: '7770001', ADMISSION_DIGEST: ws.digest, ADMISSION_ATTEMPT: '1',
    GITHUB_RUN_ID: EVAL_RUN_ID, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: p.commit, ...over,
  });
  const withRun = (opts, fn) => {
    // Assessed ten minutes ago by the real clock: the step reads the real clock.
    const p = evaluatedProject({ withVerifier: true, at: new Date(Date.now() - 10 * 60_000).toISOString() });
    try { return fn(p); } finally { p.cleanup(); }
  };

  it('CONTROL: an agreeing admission verifies, and only the bounded values reach the step outputs', () => withRun({}, (p) => {
    const ws = workspace(p);
    try {
      const r = execStep(verifyStep.run, { cwd: ws.cwd, env: envFor(p, ws) });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.outputs.kind, 'certified');
      assert.equal(`sha256:${r.outputs.payload_tree}`, p.inspection.payload.treeDigest);
      assert.equal(r.outputs.archive_sha256, p.inspection.payload.archiveSha256);
      assert.match(r.outputs.deadline_epoch, /^[1-9][0-9]{9}$/);
      assert.deepEqual(Object.keys(r.outputs).sort(), ['archive_sha256', 'deadline_epoch', 'index_sha256', 'kind', 'payload_tree']);
      const verified = JSON.parse(readFileSync(join(ws.cwd, 'verified.json'), 'utf8'));
      assert.equal(verified.entries.length, p.inspection.payload.entryCount);
    } finally { ws.cleanup(); }
  }));

  it('REGRESSION: the admission artifact downloaded is not the one prepare uploaded (digest differs from the listing) → no outputs, exit 1', () => withRun({}, (p) => {
    const ws = workspace(p, { listingDigest: 'e'.repeat(64) });
    try {
      const r = execStep(verifyStep.run, { cwd: ws.cwd, env: envFor(p, ws) });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /admission_unlisted/);
      assert.deepEqual(r.outputs, {});
    } finally { ws.cleanup(); }
  }));

  it('REGRESSION: the candidate the privileged job received differs from the one prepare assessed → refused', () => withRun({}, (p) => {
    const ws = workspace(p);
    try {
      writeFileSync(join(ws.cwd, 'candidate', 'certification.json'), `${readFileSync(join(ws.cwd, 'candidate', 'certification.json'), 'utf8')} `);
      const r = execStep(verifyStep.run, { cwd: ws.cwd, env: envFor(p, ws) });
      assert.equal(r.status, 1);
      assert.deepEqual(r.outputs, {});
    } finally { ws.cleanup(); }
  }));

  it('REGRESSION: the verifier checkout is not the workflow revision → refused', () => withRun({}, (p) => {
    const ws = workspace(p);
    try {
      const r = execStep(verifyStep.run, { cwd: ws.cwd, env: envFor(p, ws, { GITHUB_SHA: 'f'.repeat(40) }) });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /trusted_unreadable/);
    } finally { ws.cleanup(); }
  }));

  it('REGRESSION: the verifier checkout carries a local modification → refused', () => withRun({}, (p) => {
    const ws = workspace(p);
    try {
      writeFileSync(join(p.root, 'release', 'lib', 'admission.mjs'), `${readFileSync(join(p.root, 'release', 'lib', 'admission.mjs'), 'utf8')}\n// edited\n`);
      const r = execStep(verifyStep.run, { cwd: ws.cwd, env: envFor(p, ws) });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /trusted_modified/);
    } finally { ws.cleanup(); git(p.root, 'checkout', '--', 'release/lib/admission.mjs'); }
  }));
});
