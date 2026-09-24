#!/usr/bin/env node
/**
 * dependency-audit — the CLI around lib/. See dependency-audit/README.md.
 *
 *   node dependency-audit/cli.mjs snapshot    offline; right after `npm ci`
 *   node dependency-audit/cli.mjs audit       NETWORK; scans the snapshotted inventory
 *   node dependency-audit/cli.mjs evaluate    offline; re-decides retained evidence
 *   node dependency-audit/cli.mjs self-test   offline; proves the evaluator can both
 *                                             pass and refuse before it is trusted
 *
 * Exit status: 0 within policy (or only approved exceptions) · 1 blocking ·
 * 2 incomplete/unavailable · 64 usage. There is deliberately no option to swap the
 * scanner, lower a threshold, skip a graph or tolerate a failed scan.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { audit, publishSummary, reevaluate, renderSummary, snapshot } from './lib/audit.mjs';
import { selfTest } from './lib/self-test.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EVIDENCE = join(ROOT, 'dependency-audit', 'evidence');

function main(argv) {
  const [command, ...rest] = argv;
  if (rest.length) { console.error(`unexpected arguments: ${rest.join(' ')}`); return 64; }
  const now = new Date().toISOString();
  switch (command) {
    case 'snapshot': {
      const r = snapshot(ROOT, { evidenceDir: EVIDENCE, now });
      const b = r.doc.binding;
      console.log(`inventory snapshot: ${b.application.locked ?? '?'} locked, ${b.application.installed ?? '?'} installed`);
      console.log(`  lockfile sha256 ${b.application.lockfileSha256 ?? '-'}`);
      console.log(`  installed tree  ${b.application.installedTreeSha256 ?? '-'}`);
      console.log(`  revision        ${b.revision?.commit ?? '(not a git checkout)'}`);
      console.log(`  environment     ${JSON.stringify(b.environment)}`);
      if (!r.ok) {
        for (const p of r.problems) console.error(`  ✗ ${p.code}: ${p.detail}`);
        console.error('SNAPSHOT REFUSED — the installed tree cannot serve as audit evidence.');
        return 2;
      }
      return 0;
    }
    case 'audit': {
      const result = audit(ROOT, { evidenceDir: EVIDENCE, now });
      console.log(renderSummary(result));
      console.log(`evidence: ${EVIDENCE}`);
      publishSummary(result);
      return result.exitCode;
    }
    case 'evaluate': {
      const result = reevaluate(ROOT, { evidenceDir: EVIDENCE, now });
      console.log(renderSummary(result));
      return result.exitCode;
    }
    case 'self-test': {
      const failures = selfTest();
      if (failures.length) {
        for (const f of failures) console.error(`  ✗ ${f}`);
        console.error('dependency-audit self-test FAILED — the evaluator cannot be trusted.');
        return 2;
      }
      console.log('dependency-audit self-test: ok (a clean control passes; blocking, triage, incomplete and refused-record controls behave)');
      return 0;
    }
    default:
      console.error('usage: node dependency-audit/cli.mjs <snapshot|audit|evaluate|self-test>');
      return 64;
  }
}

process.exitCode = main(process.argv.slice(2));
