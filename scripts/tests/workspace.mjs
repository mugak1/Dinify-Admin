/**
 * A disposable copy of this workspace for the guard tests, so a scenario can break the
 * source, the build configuration, the output or the gate itself without touching the
 * checkout. `node_modules` is symlinked, not copied: nothing here installs anything.
 *
 * Commands run through the REAL `npm` executing the REAL package script, so what a test
 * observes is what `ci.yml`, `verify.sh` and `deploy.yml` observe.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** What the build and the gate read. Never `dist/`, `.angular/` or `node_modules/`. */
const COPIED = ['package.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json', 'tailwind.config.js', 'src', 'scripts'];

/** The npm CLI this process was launched by, or the one shipped beside this node. */
function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const found = candidates.find((candidate) => candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate));
  if (!found) throw new Error('no npm-cli.js found beside this node; the consumer tests need the real npm');
  return found;
}

export const NPM_CLI = npmCli();
export const NODE_DIR = dirname(process.execPath);

export function makeWorkspace(prefix = 'dinify-admin-guard-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const entry of COPIED) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const path = (p) => join(dir, p);
  return {
    dir,
    path,
    read: (p) => readFileSync(path(p), 'utf8'),
    write(p, text) {
      mkdirSync(dirname(path(p)), { recursive: true });
      writeFileSync(path(p), text);
    },
    /** Replace `find` with `replace` in `p`, insisting it occurs exactly once — a
     *  mutation that silently matches nothing would make its test vacuous. */
    mutate(p, find, replace) {
      const text = readFileSync(path(p), 'utf8');
      const count = text.split(find).length - 1;
      if (count !== 1) throw new Error(`mutation target occurs ${count} time(s) in ${p}: ${find}`);
      writeFileSync(path(p), text.replace(find, replace));
    },
    remove: (p) => rmSync(path(p), { recursive: true, force: true }),
    npm(...args) {
      const r = spawnSync(process.execPath, [NPM_CLI, '--silent', ...args], {
        cwd: dir,
        env: { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}` },
        encoding: 'utf8',
        timeout: 300_000,
      });
      return { status: r.status, output: `${r.stdout}${r.stderr}` };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A minimal output with the production layout: an entry, a static and a lazy chunk. */
export function writeSyntheticDist(ws, extra = {}) {
  ws.remove('dist');
  const files = {
    'dist/index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles-A1.css"><link rel="modulepreload" href="chunk-B2.js"></head><body><app-root></app-root><script src="polyfills-C3.js" type="module"></script><script src="main-D4.js" type="module"></script></body></html>',
    'dist/polyfills-C3.js': 'var z=1;',
    'dist/main-D4.js': 'import{a as b}from"./chunk-B2.js";const r=()=>import("./chunk-E5.js").then(m=>m.x);b(r,"Invalid credentials.");',
    'dist/chunk-B2.js': 'export const a=(f,m)=>f;',
    'dist/chunk-E5.js': 'import"./chunk-B2.js";export const x=1;',
    'dist/styles-A1.css': 'body{margin:0}',
    'dist/prerendered-routes.json': '{"routes":{}}',
    ...extra,
  };
  for (const [p, text] of Object.entries(files)) {
    if (text === null) continue;
    ws.write(p, text);
  }
}
