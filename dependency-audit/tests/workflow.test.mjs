/**
 * DINIFY-ADMIN'S WIRING: the dependency audit is part of the required `validate` check,
 * a failure there cannot produce a green `validate`, and nothing about the audit can
 * authorize a deployment on its own. Repository-specific (the other test files in this
 * directory are shared byte-for-byte with Dinify-Frontend).
 *
 * Every claim is made against the committed workflow files, read by the oracle-checked
 * YAML subset reader, and — where the claim is about behaviour — by executing their steps
 * under the runner's own shell semantics or GitHub's step-sequencing rules.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { auditedProject, HIGH_RUNTIME_MISSING_CAUSE, SUPPORTED_CHAIN } from './project.mjs';
import { commandOf, loadWorkflow, runStep, simulateJob, statusSwallowers } from './workflow-harness.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const WF = (name) => join(ROOT, '.github/workflows', name);
const CI = loadWorkflow(WF('ci.yml'));
const AUDIT = loadWorkflow(WF('audit.yml'));
const DEPLOY = loadWorkflow(WF('deploy.yml'));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VALIDATE = CI.jobs.validate.steps;
const SNAPSHOT = 'npm run audit:snapshot';
const SCAN = 'npm run audit:deps';

const indexOfRun = (steps, run) => steps.findIndex((s) => commandOf(s) === run);

describe('the audit is part of the required `validate` check', () => {
  it('CONTRACT: the required job keeps its name and runs on every PR and every push to main', () => {
    assert.ok(CI.jobs.validate, 'the required status check is the job named `validate`');
    assert.deepEqual(CI.on.pull_request.branches, ['main']);
    assert.deepEqual(CI.on.push.branches, ['main']);
    assert.equal(CI.jobs.validate['continue-on-error'], undefined);
    assert.equal(CI.jobs.validate.if, undefined);
  });

  it('CONTRACT: the snapshot is taken immediately after installation, before any repository code runs', () => {
    const install = indexOfRun(VALIDATE, 'npm ci');
    assert.ok(install >= 0);
    assert.equal(indexOfRun(VALIDATE, SNAPSHOT), install + 1);
  });

  // ORACLE CORRECTED (D08 B2.4), not relaxed: this used to require that ONLY the evidence
  // upload follows the scan. Release certification now packages the candidate AFTER the
  // scan — it has to, because the certification record binds the audit's result — so the
  // contract is restated exactly: the scan is still the last GATE; what follows it is the
  // certification of a job in which every gate passed (unconditional, so a failed scan
  // skips it) and the always-run evidence upload, and nothing else.
  it('CONTRACT: the scan is the LAST validation gate — every existing gate still reports first — and only certification and evidence retention follow it', () => {
    const scan = indexOfRun(VALIDATE, SCAN);
    assert.ok(scan > indexOfRun(VALIDATE, 'npm run check:mock-isolation'));
    const after = VALIDATE.slice(scan + 1);
    assert.equal(after.length, 3);
    assert.equal(commandOf(after[0]), 'npm run release:certify');
    assert.equal(after[0].if, undefined);
    assert.match(String(after[1].uses), /^actions\/upload-artifact@[0-9a-f]{40}$/);
    assert.equal(after[1].if, undefined, 'a candidate is uploaded only when every gate passed');
    assert.equal(after[1].with.path, 'release/.work/candidate/');
    assert.equal(after[2].if, 'always()');
    assert.match(String(after[2].uses), /^actions\/upload-artifact@[0-9a-f]{40}$/);
    assert.equal(after[2].with.path, 'dependency-audit/evidence/');
  });

  it('CONTRACT: the pre-existing gates are all still present — the audit replaces none of them', () => {
    for (const run of ['npm run type-check', 'npm run lint', 'npm run check:tokens', 'npm run check:claim-code', 'npm run test:audit',
      'npm run test:ci', 'npm run build:prod', 'npm run check:mock-isolation']) {
      assert.ok(indexOfRun(VALIDATE, run) >= 0, run);
    }
  });

  it('CONTRACT: neither audit step can be skipped, softened or have its status rewritten', () => {
    for (const run of [SNAPSHOT, SCAN]) {
      const step = VALIDATE[indexOfRun(VALIDATE, run)];
      assert.equal(step.if, undefined, `${run} has a condition`);
      assert.equal(step['continue-on-error'], undefined, `${run} can continue on error`);
      assert.equal(step.shell, undefined, `${run} overrides the shell`);
      assert.deepEqual(statusSwallowers(commandOf(step)), [], run);
    }
  });

  it('CONTRACT: the npm scripts behind the steps are the pinned evaluator, self-test first', () => {
    assert.equal(PKG.scripts['audit:snapshot'], 'node dependency-audit/cli.mjs snapshot');
    assert.equal(PKG.scripts['audit:deps'], 'node dependency-audit/cli.mjs self-test && node dependency-audit/cli.mjs audit');
    assert.equal(PKG.scripts['test:audit'], 'node --test dependency-audit/tests/*.test.mjs');
  });
});

describe('an audit failure reaches the required check — executed, not asserted', () => {
  const outcome = (failing) => (step) => (failing.includes(commandOf(step)) ? 'failure' : 'success');

  it('CONTROL: every step green is a green `validate`', () => {
    assert.equal(simulateJob(VALIDATE, outcome([])).conclusion, 'success');
  });

  it('REGRESSION MATRIX: the audit fails while the application suite passes → `validate` is red', () => {
    const r = simulateJob(VALIDATE, outcome([SCAN]));
    assert.equal(r.conclusion, 'failure');
    assert.ok(r.ran.some(([name, o]) => /Retain/.test(name) && o === 'success'), 'the evidence is still kept');
  });

  it('REGRESSION MATRIX: the audit is cancelled → `validate` is not green', () => {
    assert.equal(simulateJob(VALIDATE, (s) => (commandOf(s) === SCAN ? 'cancelled' : 'success')).conclusion, 'cancelled');
  });

  it('REGRESSION MATRIX: the snapshot is refused → `validate` is red and the scan never runs on an unbound tree', () => {
    const r = simulateJob(VALIDATE, outcome([SNAPSHOT]));
    assert.equal(r.conclusion, 'failure');
    assert.ok(r.ran.some(([name, o]) => /scan the validated inventory/.test(name) && o === 'skipped'));
  });

  it('REGRESSION MATRIX: an existing gate fails while the audit passes → still red; the audit is not a replacement suite', () => {
    for (const gate of ['npm run test:ci', 'npm run build:prod', 'npm run check:mock-isolation', 'npm run check:claim-code']) {
      assert.equal(simulateJob(VALIDATE, outcome([gate])).conclusion, 'failure', gate);
    }
  });

  it('REGRESSION MATRIX: the step\'s own shell propagates the audit\'s exit status (1 blocking, 2 incomplete)', () => {
    const script = VALIDATE[indexOfRun(VALIDATE, SCAN)].run;
    assert.equal(runStep(script, { npmExit: 0 }).status, 0, 'CONTROL: a passing audit passes the step');
    assert.equal(runStep(script, { npmExit: 1 }).status, 1);
    assert.equal(runStep(script, { npmExit: 2 }).status, 2);
  });

  it('NEGATIVE CONTROL: piping the audit to a formatter under the default shell WOULD hide the failure — which is why no pipe is allowed', () => {
    // GitHub's default for a `run:` with no `shell:` is `bash -e {0}`: errexit, but NOT
    // pipefail. `npm run audit:deps | tee log` would exit 0 on a failed audit.
    assert.equal(runStep(`${SCAN} | tee audit.log\n`, { npmExit: 2 }).status, 0);
    assert.deepEqual(statusSwallowers(`${SCAN} | tee audit.log`), ['a pipe or `||`']);
    assert.notEqual(runStep(`${SCAN} | tee audit.log\n`, { npmExit: 2, shell: ['bash', '-eo', 'pipefail'] }).status, 0);
  });
});

describe('an unaccounted vulnerability fails `validate` — decided by the real evaluator, carried by the real step', () => {
  // The chain is EXECUTED, not assumed, three links long:
  //   1. the real audit() decides a SYNTHETIC answer injected at its runner seam, and
  //      leaves its evidence on disk;
  //   2. the `npm run audit:deps` step exactly as `validate` declares it runs under the
  //      runner's default shell, with `npm` answered by the REAL `evaluate` command over
  //      that evidence — so the step's status is the evaluator's own exit status;
  //   3. GitHub's step sequencing over the actual `validate` steps turns that status into
  //      the job's conclusion.
  const scanStep = VALIDATE[indexOfRun(VALIDATE, SCAN)];
  const retainStep = VALIDATE.find((s) => s.name === 'Retain the dependency-audit evidence');
  const within = (answer, fn) => { const p = auditedProject(answer); try { return fn(p); } finally { p.cleanup(); } };
  const validateWith = (p) => {
    const step = runStep(scanStep.run, { npmBody: p.evaluateCommand });
    const invoked = [];
    const job = simulateJob(VALIDATE, (s) => {
      invoked.push(s);
      if (s === scanStep) return step.status === 0 ? 'success' : 'failure';
      return 'success';
    });
    return { step, job, invoked };
  };

  it('REGRESSION MATRIX: a HIGH runtime entry whose cause the report does not list turns `validate` red with status 2', () => within(HIGH_RUNTIME_MISSING_CAUSE, (p) => {
    assert.equal(p.result.outcome, 'incomplete');
    const { step, job } = validateWith(p);
    assert.equal(step.status, 2, step.stdout + step.stderr);
    assert.match(step.stdout, /scanner_dangling_cause/);
    assert.equal(job.conclusion, 'failure');
  }));

  it('CONTROL: the same path with a supported dependency chain is a green `validate`', () => within(SUPPORTED_CHAIN, (p) => {
    const { step, job } = validateWith(p);
    assert.equal(step.status, 0, step.stdout + step.stderr);
    assert.equal(job.conclusion, 'success');
  }));

  it('REGRESSION MATRIX: the evidence is retained on that failure, and `if: always()` does not rescue the job', () => within(HIGH_RUNTIME_MISSING_CAUSE, (p) => {
    const { job } = validateWith(p);
    assert.equal(retainStep.if, 'always()');
    assert.deepEqual(job.ran.find(([name]) => name === retainStep.name), [retainStep.name, 'success'], 'the evidence step ran after the failure');
    assert.equal(job.conclusion, 'failure', 'collecting the evidence did not turn the job green');
    // What that step collects is on disk and says why: the raw answer, byte for byte, and
    // a result that names the unaccounted cause.
    assert.equal(retainStep.with.path, 'dependency-audit/evidence/');
    assert.equal(readFileSync(join(p.evidence, 'application.scanner-stdout.txt'), 'utf8'), HIGH_RUNTIME_MISSING_CAUSE.stdout);
    const result = JSON.parse(readFileSync(join(p.evidence, 'result.json'), 'utf8'));
    assert.equal(result.outcome, 'incomplete');
    assert.ok(result.reasons.some((r) => r.code === 'scanner_dangling_cause'));
    assert.ok(existsSync(join(p.evidence, 'collection.json')) && existsSync(join(p.evidence, 'snapshot.json')));
    // And a retention step that itself failed would not make a failed job pass either.
    assert.equal(simulateJob(VALIDATE, (s) => (s === retainStep || commandOf(s) === SCAN ? 'failure' : 'success')).conclusion, 'failure');
  }));

  it('CONTRACT: nothing that ran holds a credential — `validate` references no secret and requests no OIDC token', () => within(HIGH_RUNTIME_MISSING_CAUSE, (p) => {
    const { invoked } = validateWith(p);
    assert.ok(invoked.length > 0);
    for (const s of invoked) assert.doesNotMatch(JSON.stringify(s), /secrets\.|id-token/, s.name);
    assert.doesNotMatch(readFileSync(WF('ci.yml'), 'utf8'), /secrets\.|id-token/);
  }));

  it('CONTRACT (static — Dinify-Admin has no workflow engine): a red `validate` reaches no deployment job', () => {
    // deploy.yml's only automatic trigger is this workflow's completion, its first job
    // proceeds on that trigger only for a SUCCESSFUL push run on main, and every other job
    // needs it — so the credentialed job cannot start after a failed audit.
    const jobs = DEPLOY.jobs;
    const first = Object.entries(jobs).filter(([, j]) => j.needs === undefined);
    assert.equal(first.length, 1);
    const [firstName, firstJob] = first[0];
    assert.match(String(firstJob.if), /github\.event\.workflow_run\.conclusion == 'success'/);
    for (const [name, job] of Object.entries(jobs)) {
      if (name === firstName) continue;
      assert.ok([].concat(job.needs).includes(firstName), `${name} does not wait for ${firstName}`);
    }
  });
});

describe('nothing about the audit can authorize a deployment', () => {
  it('CONTRACT: deploy.yml is triggered by the CI workflow only, and re-verifies the run is ci.yml by path', () => {
    assert.deepEqual(DEPLOY.on.workflow_run.workflows, [CI.name]);
    const text = readFileSync(WF('deploy.yml'), 'utf8');
    assert.match(text, /actions\/workflows\/ci\.yml/);
    assert.doesNotMatch(text, /actions\/workflows\/audit\.yml/);
  });

  it('CONTRACT: the scheduled audit is not named like the validation workflow, and no workflow consumes its runs', () => {
    assert.notEqual(AUDIT.name, CI.name);
    assert.deepEqual(Object.keys(AUDIT.on).sort(), ['schedule', 'workflow_dispatch']);
    for (const file of readdirSync(join(ROOT, '.github/workflows'))) {
      const wf = loadWorkflow(WF(file));
      const consumed = wf.on?.workflow_run?.workflows ?? [];
      assert.ok(!consumed.includes(AUDIT.name), `${file} triggers on the audit workflow`);
    }
  });

  it('CONTRACT: the scheduled audit uses the same evaluator and policy, not a weaker parallel opinion', () => {
    const runs = AUDIT.jobs.audit.steps.map(commandOf).filter(Boolean);
    assert.deepEqual(runs, ['npm ci', SNAPSHOT, SCAN]);
    for (const file of readdirSync(join(ROOT, '.github/workflows'))) {
      assert.doesNotMatch(readFileSync(WF(file), 'utf8'), /npm audit --audit-level/, `${file} runs a raw threshold audit`);
    }
  });
});
