#!/usr/bin/env node
/**
 * Standing gate (ADMIN-CLAIM-CODE-00): a raw owner claim code is displayed once and
 * persisted, logged, routed or linked NOWHERE.
 *
 * Modelled on `check-design-tokens.mjs` and `check-mock-isolation.mjs`, including the
 * `--self-test` mode: a matcher that silently stopped matching would otherwise pass
 * everything forever, and "the tree happens to be clean today" is not evidence that a
 * gate works.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 *
 * Restaurant creation and owner-invitation reissue each answer with a BEARER
 * CREDENTIAL — the raw claim token the backend returns exactly once and then holds only
 * as a hash. The frontend rule (Step 2G) is that the credential may exist transiently in
 * component state to be displayed and copied, and must never be written to
 * localStorage, sessionStorage, IndexedDB, a cookie, the URL, router state, the
 * workspace store, a canonical model, a log, a notice, a defect report or a fabricated
 * claim link. Every one of those is a one-line convenience away, and none of them is
 * something the type checker, the linter or a runtime test reliably notices — a test
 * proves the code paths it exercises, and the leak that ships is in the path nobody
 * wrote a test for.
 *
 * ── THE THREE RULES ───────────────────────────────────────────────────────────────
 *
 *   1. CREDENTIAL BESIDE A SINK — a code line that names a claim-code identifier
 *      (`claim_token`, `claimToken`, `claimCode`, `claim_code`, `rawToken`) AND a sink
 *      (`localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `console.`,
 *      `navigate(`, `navigateByUrl(`, `routerLink`, `queryParams`, `location.`,
 *      `history.`, `.setItem(`, `notices.`, `defects.`, `analytics`) is refused.
 *   2. NO CLAIM URL — nothing may assemble a claim link: `owner-claim?`, `owner-claim#`,
 *      `owner-claim/${`, or a `token=` / `claim_token=` / `claimToken=` query fragment.
 *      A URL is a product promise the platform does not make; the portal's screen takes
 *      a pasted CODE, and the code travels by hand.
 *   3. THE STORE AND THE MODEL CARRY NO CREDENTIAL — `restaurant-workspace.store.ts`
 *      and `restaurant.model.ts` may mention a claim-code identifier only in the ONE
 *      response type that carries it off the wire (`IssuedOwnerInvitation`), never in
 *      the store (which outlives every tab) or in a canonical detail/onboarding shape.
 *
 * ── COMMENT-AWARE, DELIBERATELY ───────────────────────────────────────────────────
 *
 * The files that handle the credential explain, in comments, exactly which sinks it
 * must never reach — so a raw line scan would fail on the documentation of the rule.
 * Line comments, block comments and HTML comments in inline templates are skipped; the
 * rule asks "does this code RUN", not "does this string appear".
 *
 * ── SCOPE, AND WHAT IT DOES NOT GUARD ─────────────────────────────────────────────
 *
 * `src/app/**\/*.ts`, excluding `*.spec.ts` (specs assert the NEGATIVE and legitimately
 * name a sink beside a fixture token). It is source text, not semantic analysis: a
 * credential copied into a differently-named variable and then stored passes, as does
 * a sink reached through an alias. What it proves is that no line WRITES a claim code
 * to a sink — which is the failure mode that actually happens, because it is the
 * convenient one. The runtime specs cover the aliases for the screens that exist.
 *
 * Usage (no build, no deps):
 *
 *     node scripts/check-claim-code-handling.mjs              # scan the tree
 *     node scripts/check-claim-code-handling.mjs --self-test  # prove the matcher fires
 *
 * Exit 0 if clean, 1 if any violation is found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = join(REPO_ROOT, 'src', 'app');

const CREDENTIAL = /\b(claim_token|claimToken|claimCode|claim_code|rawToken)\b/;
const SINKS = [
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bdocument\.cookie\b/,
  /\bconsole\./,
  /\bnavigate\(/,
  /\bnavigateByUrl\(/,
  /\brouterLink\b/,
  /\bqueryParams\b/,
  /\blocation\./,
  /\bhistory\./,
  /\.setItem\(/,
  /\bnotices\./,
  /\bdefects\./,
  /\banalytics\b/,
];
const CLAIM_URL = [/owner-claim\?/, /owner-claim#/, /owner-claim\/\$\{/, /[?&]token=/, /claim_token=/, /claimToken=/];

/**
 * Files in which a claim-code identifier is allowed at all, and the ONE line shape
 * allowed there. The model may DECLARE the wire field of the issuance response; nothing
 * else in the model, and nothing in the store, may name it.
 */
const CREDENTIAL_FILE_RULES = [
  { file: 'core/restaurants/restaurant-workspace.store.ts', allowed: () => false },
  {
    file: 'core/restaurants/restaurant.model.ts',
    allowed: (line) => /^\s*readonly claim_token: string;\s*$/.test(line),
  },
];

/** The lines of `content` with every comment removed — line, block and HTML alike. */
export function codeLines(content) {
  const out = [];
  let inBlock = false;
  let inHtml = false;
  for (const raw of content.split('\n')) {
    let line = raw;
    let code = '';
    while (line.length) {
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end === -1) { line = ''; break; }
        line = line.slice(end + 2);
        inBlock = false;
        continue;
      }
      if (inHtml) {
        const end = line.indexOf('-->');
        if (end === -1) { line = ''; break; }
        line = line.slice(end + 3);
        inHtml = false;
        continue;
      }
      const block = line.indexOf('/*');
      const html = line.indexOf('<!--');
      const lineComment = line.indexOf('//');
      const candidates = [
        [block, 'block'],
        [html, 'html'],
        [lineComment, 'line'],
      ].filter(([index]) => index !== -1);
      if (!candidates.length) { code += line; line = ''; break; }
      candidates.sort((a, b) => a[0] - b[0]);
      const [index, kind] = candidates[0];
      // `//` inside a URL string (`https://`) is not a comment.
      if (kind === 'line' && index > 0 && line[index - 1] === ':') {
        code += line.slice(0, index + 2);
        line = line.slice(index + 2);
        continue;
      }
      code += line.slice(0, index);
      if (kind === 'line') { line = ''; break; }
      line = line.slice(index + (kind === 'block' ? 2 : 4));
      if (kind === 'block') inBlock = true;
      else inHtml = true;
    }
    out.push(code);
  }
  return out;
}

/** Return `[{line, rule, text}]` for every violation in `content` at `file`. */
export function findViolations(content, file = '') {
  const violations = [];
  const fileRule = CREDENTIAL_FILE_RULES.find((rule) => file.endsWith(rule.file));
  codeLines(content).forEach((code, index) => {
    const line = index + 1;
    const text = code.trim();
    if (!text) return;
    const namesCredential = CREDENTIAL.test(code);
    if (namesCredential && SINKS.some((sink) => sink.test(code))) {
      violations.push({ line, rule: 'credential beside a sink', text });
    }
    if (CLAIM_URL.some((shape) => shape.test(code))) {
      violations.push({ line, rule: 'claim URL fabricated', text });
    }
    if (namesCredential && fileRule && !fileRule.allowed(code)) {
      violations.push({ line, rule: 'credential in the store or a canonical model', text });
    }
  });
  return violations;
}

function* iterSourceFiles(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      yield full;
    }
  }
}

function selfTest() {
  const cases = [
    ['a credential written to sessionStorage', "sessionStorage.setItem('claim', result.owner_invitation.claim_token);", 1],
    ['a credential logged', 'console.log(this.claimToken());', 1],
    ['a credential routed as a query param', "this.router.navigate(['/owner-claim'], { queryParams: { token: claimToken } });", 1],
    ['a credential put in navigation state', 'this.router.navigateByUrl(`/restaurants/${id}`, { state: { claimCode } });', 1],
    ['a credential handed to the notice channel', 'this.notices.record({ claimToken });', 1],
    ['a claim URL assembled', 'const link = `${portal}/owner-claim?c=${claim_token}`;', 1],
    ['a claim URL with a path segment', 'const link = `${portal}/owner-claim/${code}`;', 1],
    ['a token query fragment', "const href = '/owner-claim' + '?token=' + code;", 1],
    ['a credential in the store', 'readonly claimToken = signal<string | null>(null);', 1, 'core/restaurants/restaurant-workspace.store.ts'],
    ['a credential typed onto a canonical detail', 'readonly claim_token: string | null;', 1, 'core/restaurants/restaurant.model.ts'],
    ['the ONE wire field the model may declare', '  readonly claim_token: string;', 0, 'core/restaurants/restaurant.model.ts'],
    ['a credential held in component state', 'this.claimToken.set(result.owner_invitation.claim_token);', 0],
    ['a credential rendered into a readonly field', '[value]="claimToken()"', 0],
    ['the rule described in a line comment', '// never sessionStorage.setItem(claimToken) — it is a bearer credential', 0],
    ['the rule described in a block comment', '/* the claimToken is never put in localStorage */', 0],
    ['the rule described in a template comment', '<!-- the claimToken is never put in localStorage -->', 0],
    ['a multi-line template comment', "<!-- a raw claimToken\n     must never reach localStorage -->\n<input [value]=\"claimToken()\" />", 0],
    ['the portal screen NAMED in prose, not linked', "on the restaurant portal's Claim your restaurant screen (/owner-claim), verifies", 0],
    ['a filter written to storage, with no credential in sight', "localStorage.setItem('dinify-admin.filter', value);", 0],
    ['a URL string that is not a comment', "const base = 'https://admin.dinifyapp.com'; sessionStorage.setItem(k, claimToken);", 1],
  ];

  let failures = 0;
  for (const [label, content, expected, file = 'src/app/features/example.ts'] of cases) {
    const got = findViolations(content, file).length;
    if (got !== expected) {
      failures += 1;
      console.error(`  self-test FAIL: ${label} — expected ${expected} violation(s), got ${got}`);
    }
  }

  if (failures) {
    console.error(`\nClaim-code gate self-test: ${failures} case(s) failed.`);
    return 1;
  }
  console.log(`Claim-code gate self-test: OK — ${cases.length} cases, matcher fires.`);
  return 0;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const found = [];
  let scanned = 0;
  for (const file of iterSourceFiles(APP_ROOT)) {
    scanned += 1;
    const rel = relative(REPO_ROOT, file).split(sep).join('/');
    for (const violation of findViolations(readFileSync(file, 'utf8'), rel)) {
      found.push({ file: rel, ...violation });
    }
  }

  if (found.length) {
    console.log('Claim-code gate: FAIL — a raw owner claim code reaches somewhere it must not:');
    console.log('');
    for (const { file, line, rule, text } of found) {
      console.log(`  ${file}:${line}  [${rule}]  ${text}`);
    }
    console.log('');
    console.log(
      'A claim code is a bearer credential shown once. It may live in component state to be ' +
        'displayed and copied, and nowhere else — see scripts/check-claim-code-handling.mjs.',
    );
    return 1;
  }

  console.log(`Claim-code gate: OK — scanned ${scanned} source file(s), no credential reaches a sink.`);
  return 0;
}

process.exit(main());
