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
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

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

  it('CONTRACT: the scan is the LAST validation step — every existing gate still reports first — and only evidence retention follows it', () => {
    const scan = indexOfRun(VALIDATE, SCAN);
    assert.ok(scan > indexOfRun(VALIDATE, 'npm run check:mock-isolation'));
    const after = VALIDATE.slice(scan + 1);
    assert.equal(after.length, 1);
    assert.equal(after[0].if, 'always()');
    assert.match(String(after[0].uses), /^actions\/upload-artifact@[0-9a-f]{40}$/);
    assert.equal(after[0].with.path, 'dependency-audit/evidence/');
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
