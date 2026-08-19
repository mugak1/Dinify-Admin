#!/usr/bin/env node
/**
 * Standing gate (ADMIN-MOCK-00): the mock transport and the primitives gallery must
 * not reach a production build.
 *
 * ── WHY A CHECK AND NOT A CONVENTION ──────────────────────────────────────────────
 *
 * The mock lets `npm start` render the whole application with no backend running,
 * which is how the visual direction gets reviewed before 0C ships a deploy. That
 * convenience is also a liability: a mock authentication implementation shipped to
 * the control plane is an authentication bypass with a friendly name.
 *
 * The structural defence is `angular.json`'s production `fileReplacements`, which
 * swaps `src/app/dev/dev-tools.ts` for `dev-tools.prod.ts` — a module that imports
 * nothing from `src/app/dev`. So neither the mock nor the gallery is in the
 * production module graph at all, rather than being present-but-unreachable and
 * relying on the bundler to eliminate it.
 *
 * This script CHECKS that, because a structural guarantee nobody verifies is a
 * guarantee until the day someone adds an import.
 *
 * ── HOW ───────────────────────────────────────────────────────────────────────────
 *
 * Both modules export a distinctive build marker, and each is used in a way a
 * minifier cannot drop — one through `console.warn`, one as a rendered `data-`
 * attribute. If either literal survives into `dist/`, it shipped.
 *
 * The scan FAILS LOUDLY when `dist/` is missing or holds no JavaScript, so a green
 * result can never mean "there was nothing to look at". Run it after `build:prod`.
 *
 * Usage:
 *
 *     npm run build:prod && node scripts/check-mock-isolation.mjs
 *     node scripts/check-mock-isolation.mjs --self-test
 *
 * Exit 0 if clean, 1 otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ROOT = join(REPO_ROOT, 'dist');

/**
 * Must match the exported constants in `src/app/dev/`. Spelled here rather than
 * imported: this script runs against BUILT output with no TypeScript toolchain, and
 * an import would also mean the checker and the checked share a single point of
 * failure.
 */
export const FORBIDDEN_MARKERS = [
  { marker: 'DINIFY_ADMIN_MOCK_AUTH_PRESENT', source: 'src/app/dev/mock-admin-auth.ts' },
  { marker: 'DINIFY_ADMIN_GALLERY_PRESENT', source: 'src/app/dev/gallery.page.ts' },
];

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.html', '.css'];

/** Return `[{marker, source}]` for any marker present in `content`. */
export function findMarkersInContent(content) {
  return FORBIDDEN_MARKERS.filter(({ marker }) => content.includes(marker));
}

function* iterBuiltFiles(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
      yield full;
    }
  }
}

function selfTest() {
  const cases = [
    ['a bundle carrying the mock marker', 'x="DINIFY_ADMIN_MOCK_AUTH_PRESENT"', 1],
    ['a bundle carrying the gallery marker', 'a.setAttribute("data-build-marker","DINIFY_ADMIN_GALLERY_PRESENT")', 1],
    ['a bundle carrying both', 'DINIFY_ADMIN_MOCK_AUTH_PRESENT DINIFY_ADMIN_GALLERY_PRESENT', 2],
    ['an ordinary production bundle', 'const e="Invalid credentials.";export{e};', 0],
    ['a near miss', 'const DINIFY_ADMIN = 1;', 0],
  ];

  let failures = 0;
  for (const [label, content, expected] of cases) {
    const got = findMarkersInContent(content).length;
    if (got !== expected) {
      failures += 1;
      console.error(`  self-test FAIL: ${label} — expected ${expected}, got ${got}`);
    }
  }

  if (failures) {
    console.error(`\nMock-isolation gate self-test: ${failures} case(s) failed.`);
    return 1;
  }
  console.log(`Mock-isolation gate self-test: OK — ${cases.length} cases, matcher fires.`);
  return 0;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  if (!existsSync(DIST_ROOT)) {
    console.error(
      'Mock-isolation gate: FAIL — dist/ does not exist. Run `npm run build:prod` first; ' +
        'a scan with nothing to scan must not report success.',
    );
    return 1;
  }

  const files = [...iterBuiltFiles(DIST_ROOT)];
  if (!files.length) {
    console.error('Mock-isolation gate: FAIL — dist/ contains no built files to scan.');
    return 1;
  }

  const found = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const hit of findMarkersInContent(content)) {
      found.push({ file: relative(REPO_ROOT, file).split(sep).join('/'), ...hit });
    }
  }

  if (found.length) {
    console.log('Mock-isolation gate: FAIL — development-only code reached the production build:');
    console.log('');
    for (const { file, marker, source } of found) {
      console.log(`  ${file}: ${marker} (from ${source})`);
    }
    console.log('');
    console.log(
      'The production configuration file-replaces src/app/dev/dev-tools.ts. Something now ' +
        'imports src/app/dev from a module the production build reaches.',
    );
    return 1;
  }

  console.log(
    `Mock-isolation gate: OK — scanned ${files.length} built file(s), no development-only code.`,
  );
  return 0;
}

process.exit(main());
