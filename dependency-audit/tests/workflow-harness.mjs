/**
 * A bounded harness over the REAL workflow files, for the claims a pure helper cannot
 * make: that an audit failure reaches the required check, that no condition lets it be
 * skipped into a green job, and that the shell a step actually runs under propagates the
 * audit's exit status.
 *
 * Two pieces, both deliberately small:
 *   simulateJob   — GitHub's step-sequencing rules over a job's actual `steps:` list,
 *                   for the status functions these files use. An unmodelled `if:` throws,
 *                   so a new condition forces this harness to be revisited.
 *   runStep       — executes a step's actual `run:` text the way a GitHub runner does
 *                   when no `shell:` is given (`bash -e {0}`: errexit, NO pipefail), with
 *                   `npm` replaced by a stub that exits with a chosen status.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseYaml } from './yaml-subset.mjs';

export const loadWorkflow = (path) => parseYaml(readFileSync(path, 'utf8'));

const STATUS_FUNCTIONS = {
  'success()': (s) => s === 'success',
  'always()': () => true,
  'failure()': (s) => s === 'failure',
  'cancelled()': (s) => s === 'cancelled',
  '!cancelled()': (s) => s !== 'cancelled',
};

/**
 * @param {Array<object>} steps  a job's `steps:` exactly as the workflow file declares them
 * @param {(step, index) => 'success'|'failure'|'cancelled'} outcomeOf
 */
export function simulateJob(steps, outcomeOf) {
  let status = 'success';
  const ran = [];
  steps.forEach((step, index) => {
    const raw = step.if === undefined ? 'success()' : String(step.if).trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const gate = STATUS_FUNCTIONS[raw];
    if (!gate) throw new Error(`unmodelled step condition on "${step.name}": ${step.if}`);
    if (!gate(status)) { ran.push([step.name, 'skipped']); return; }
    const out = outcomeOf(step, index);
    ran.push([step.name, out]);
    if (out === 'cancelled') status = 'cancelled';
    else if (out === 'failure' && step['continue-on-error'] !== true && status === 'success') status = 'failure';
  });
  return { conclusion: status, ran };
}

/** Run a step's `run:` text under a runner's default shell with a stub `npm`. */
export function runStep(script, { npmExit, shell = ['bash', '-e'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'step-'));
  try {
    const stub = join(dir, 'npm');
    writeFileSync(stub, `#!/bin/sh\necho "stub npm $*" >&2\nexit ${Number(npmExit)}\n`);
    chmodSync(stub, 0o755);
    const file = join(dir, 'step.sh');
    writeFileSync(file, script);
    const r = spawnSync(shell[0], [...shell.slice(1), file], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }, cwd: dir, encoding: 'utf8', timeout: 30000,
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A step's command text, normalised. */
export const commandOf = (step) => (typeof step.run === 'string' ? step.run.trim() : null);

/** Everything in a `run:` that could swallow or rewrite an exit status. */
export function statusSwallowers(script) {
  const found = [];
  if (/\|/.test(script)) found.push('a pipe or `||`');
  if (/;/.test(script)) found.push('a `;` sequence');
  if (/\bset\s+\+e\b/.test(script)) found.push('`set +e`');
  if (/\btrue\b/.test(script)) found.push('`true`');
  if (/\bexit\s+0\b/.test(script)) found.push('`exit 0`');
  if (/&\s*$/m.test(script) && !/&&/.test(script)) found.push('a background `&`');
  return found;
}
