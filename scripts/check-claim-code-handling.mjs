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
 *   1. CREDENTIAL BESIDE A SINK — a UNIT of code that names a claim-code identifier
 *      (`claim_token`, `claimToken`, `claimCode`, `claim_code`, `rawToken`) AND a sink
 *      (`localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `console.`,
 *      `navigate(`, `navigateByUrl(`, `routerLink`, `queryParams`, `href`,
 *      `window.location` and its writable members, `history.pushState` and kin,
 *      `window.open(`, `URLSearchParams`, `new URL(`, `.setItem(`, `notices.`,
 *      `defects.`, `analytics`) is refused.
 *   2. NO CLAIM URL — nothing may assemble a claim link: `owner-claim?`, `owner-claim#`,
 *      `owner-claim/${`, or a `token=` / `claim_token=` / `claimToken=` query fragment,
 *      whether written in one string or concatenated out of several. A URL is a product
 *      promise the platform does not make; the portal's screen takes a pasted CODE, and
 *      the code travels by hand.
 *   3. THE STORE AND THE MODEL CARRY NO CREDENTIAL — `restaurant-workspace.store.ts`
 *      and `restaurant.model.ts` may mention a claim-code identifier only in the ONE
 *      response type that carries it off the wire (`IssuedOwnerInvitation`), never in
 *      the store (which outlives every tab) or in a canonical detail/onboarding shape.
 *
 * ── A UNIT IS A STATEMENT, NOT A LINE ─────────────────────────────────────────────
 *
 * The first version of this gate compared each source LINE with itself, and review
 * found the hole in one sentence: an ordinarily formatted multi-line call —
 *
 *     sessionStorage.setItem(
 *       'claim',
 *       result.owner_invitation.claim_token,
 *     );
 *
 * — has the sink on one line and the credential on another, and passed. So rule 1 now
 * parses every file with the TypeScript compiler API and evaluates the INNERMOST
 * enclosing UNIT around each credential occurrence: a statement, a class member, a type
 * member, a decorator, an enum member or a parameter. Two refinements keep that honest
 * rather than merely broad:
 *
 *   • a unit is read with its NESTED units blanked out (they are units of their own and
 *     are judged on their own), so a sink in the statement before the credential's is
 *     not the credential reaching it; and
 *   • a callback that does NOT contain the occurrence is blanked out too, so
 *     `subscribe({ next: r => this.code.set(r.claim_token), error: e => this.defects.report(e) })`
 *     is not a credential handed to the defect channel — the two arrows are different
 *     scopes, and the value never crosses between them.
 *
 * Inline templates are markup, not code, and are read as such: each START TAG — from
 * `<` to its closing `>`, however many lines its attributes span — is a unit. Rule 2
 * runs over every unit as well as every line, and additionally over a SQUASHED copy of
 * the unit (quotes, `+`, whitespace and interpolation braces removed), so a claim link
 * concatenated out of `'/owner-claim' + '?' + 'token='` reads as the URL it builds.
 *
 * ── COMMENT-AWARE, DELIBERATELY ───────────────────────────────────────────────────
 *
 * The files that handle the credential explain, in comments, exactly which sinks it
 * must never reach — so a raw scan would fail on the documentation of the rule. Line
 * comments, block comments and HTML comments in inline templates are skipped; the rule
 * asks "does this code RUN", not "does this string appear".
 *
 * ── SCOPE, AND WHAT IT DOES NOT GUARD ─────────────────────────────────────────────
 *
 * `src/app/**\/*.ts`, excluding `*.spec.ts` (specs assert the NEGATIVE and legitimately
 * name a sink beside a fixture token). It is syntax, not semantic analysis: a credential
 * copied into a differently-named variable and then stored passes, as does a sink
 * reached through an alias. What it proves is that no unit WRITES a claim code to a sink
 * — which is the failure mode that actually happens, because it is the convenient one.
 * The runtime specs cover the aliases for the screens that exist.
 *
 * Usage (needs the repo's `typescript` devDependency, nothing else):
 *
 *     node scripts/check-claim-code-handling.mjs              # scan the tree
 *     node scripts/check-claim-code-handling.mjs --self-test  # prove the matcher fires
 *
 * Exit 0 if clean, 1 if any violation is found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

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
  /\bhref\b/,
  // The BROWSER location and the Angular `Location` service — never a restaurant's
  // `location` field, which every canonical shape in this domain carries and which a
  // statement building a creation response legitimately names beside the credential.
  /\b(window|document|globalThis|this)\.location\b/,
  /\blocation\.(href|assign|reload|hash|pathname|origin|host)\b/,
  /\b(window|globalThis|this)\.history\b/,
  /\bhistory\.(pushState|replaceState|state|back|forward)\b/,
  /\bwindow\.open\(/,
  /\bURLSearchParams\b/,
  /\bnew URL\(/,
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

/** Decorator properties that hold markup or styles, never code — scanned as such. */
const OPAQUE_PROPERTIES = new Set(['template', 'styles']);

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

/** `text` with its comments removed, line structure preserved. */
function stripComments(text) {
  return codeLines(text).join('\n');
}

/** A claim link read the way the browser will: delimiters, `+` and interpolation braces gone. */
function squash(text) {
  return text.replace(/\$\{|[}'"`+\s]/g, '');
}

function assemblesClaimUrl(text) {
  if (CLAIM_URL.some((shape) => shape.test(text))) return true;
  const squashed = squash(text);
  if (/owner-claim[?#]/.test(squashed)) return true;
  // A `token=` fragment split off its `?` — counted only where the fragment is itself a
  // string, so a ternary that happens to assign a variable named `token` is not a URL.
  return /[?&]token=/.test(squashed) && /['"`]token=/.test(text);
}

function namesSink(text) {
  return SINKS.some((sink) => sink.test(text));
}

// ── TypeScript units ────────────────────────────────────────────────────────────

/** A node that is judged on its own: the innermost such ancestor of an occurrence is its unit. */
function isUnit(node) {
  return (
    ts.isStatement(node) ||
    ts.isClassElement(node) ||
    ts.isTypeElement(node) ||
    ts.isDecorator(node) ||
    ts.isEnumMember(node) ||
    ts.isParameter(node)
  );
}

function isOpaqueProperty(node) {
  return (
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
    OPAQUE_PROPERTIES.has(node.name.text)
  );
}

/** The leaf tokens whose text can spell a credential identifier. */
function isLeafText(node) {
  return (
    ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isTemplateLiteralToken(node) ||
    ts.isRegularExpressionLiteral(node)
  );
}

function encloses(node, inner, sf) {
  return node.getStart(sf) <= inner.getStart(sf) && inner.getEnd() <= node.getEnd();
}

function unitOf(node, sf) {
  let unit = node.parent;
  while (unit && !isUnit(unit)) unit = unit.parent;
  return unit ?? sf;
}

/**
 * The text of `unit` that is relevant to `occurrence` (or to the unit itself when
 * `occurrence` is null): nested units, markup/styles properties and — for an occurrence —
 * callbacks that do not contain it are blanked, then comments are removed. Newlines are
 * kept so the result stays line-shaped for reporting.
 */
function relevantText(unit, occurrence, sf) {
  const start = unit.getStart(sf);
  const chars = Array.from(unit.getText(sf));
  const blank = (node) => {
    for (let i = node.getStart(sf) - start; i < node.getEnd() - start; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  const visit = (node) => {
    const detachedScope =
      occurrence !== null && ts.isFunctionLike(node) && !encloses(node, occurrence, sf);
    if (isUnit(node) || isOpaqueProperty(node) || detachedScope) {
      blank(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(unit, visit);
  return stripComments(chars.join(''));
}

function lineOf(position, sf) {
  return sf.getLineAndCharacterOfPosition(position).line + 1;
}

// ── Inline templates ────────────────────────────────────────────────────────────

/** HTML comments replaced by whitespace of the same shape, so positions are preserved. */
function blankHtmlComments(markup) {
  return markup.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Every start tag in `markup` — `<` to the `>` that closes it, honouring quoted
 * attribute values, however many lines it spans — with its offset.
 */
function tagUnits(markup) {
  const units = [];
  let i = 0;
  while (i < markup.length) {
    const open = markup.indexOf('<', i);
    if (open === -1) break;
    if (!/[A-Za-z/]/.test(markup[open + 1] ?? '')) {
      i = open + 1;
      continue;
    }
    let j = open + 1;
    let quote = null;
    while (j < markup.length) {
      const ch = markup[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    units.push({ start: open, text: markup.slice(open, j + 1) });
    i = j + 1;
  }
  return units;
}

// ── The scan ────────────────────────────────────────────────────────────────────

/** Return `[{line, rule, text}]` for every violation in `content` at `file`. */
export function findViolations(content, file = '') {
  const found = new Map();
  const lines = content.split('\n');
  const record = (line, rule) => {
    const key = `${line}:${rule}`;
    if (!found.has(key)) found.set(key, { line, rule, text: (lines[line - 1] ?? '').trim() });
  };

  const sf = ts.createSourceFile(file || 'source.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const visit = (node) => {
    if (isOpaqueProperty(node)) {
      const literal = node.initializer;
      if (node.name.text === 'template' && ts.isStringLiteralLike(literal)) {
        const markup = blankHtmlComments(literal.getText(sf).slice(1, -1));
        const base = literal.getStart(sf) + 1;
        for (const tag of tagUnits(markup)) {
          const line = lineOf(base + tag.start, sf);
          if (CREDENTIAL.test(tag.text) && namesSink(tag.text)) record(line, 'credential beside a sink');
          if (assemblesClaimUrl(tag.text)) record(line, 'claim URL fabricated');
        }
      }
      return;
    }
    if (isUnit(node) && assemblesClaimUrl(relevantText(node, null, sf))) {
      record(lineOf(node.getStart(sf), sf), 'claim URL fabricated');
    }
    if (isLeafText(node) && CREDENTIAL.test(node.getText(sf))) {
      const text = relevantText(unitOf(node, sf), node, sf);
      if (CREDENTIAL.test(text) && namesSink(text)) {
        record(lineOf(node.getStart(sf), sf), 'credential beside a sink');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Line-level, as before: prose in a template, and the file-specific rule 3.
  const fileRule = CREDENTIAL_FILE_RULES.find((rule) => file.endsWith(rule.file));
  codeLines(content).forEach((code, index) => {
    const line = index + 1;
    if (!code.trim()) return;
    if (CLAIM_URL.some((shape) => shape.test(code))) record(line, 'claim URL fabricated');
    if (CREDENTIAL.test(code) && fileRule && !fileRule.allowed(code)) {
      record(line, 'credential in the store or a canonical model');
    }
  });

  return [...found.values()].sort((a, b) => a.line - b.line);
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

/** A markup snippet as it would sit in a component, so the template scanner sees it. */
function component(markup) {
  return `@Component({ selector: 'x', template: \`${markup}\` })\nexport class X {}`;
}

function selfTest() {
  const cases = [
    // ── rule 1, on one line ─────────────────────────────────────────────────────
    ['a credential written to sessionStorage', "sessionStorage.setItem('claim', result.owner_invitation.claim_token);", 1],
    ['a credential logged', 'console.log(this.claimToken());', 1],
    ['a credential routed as a query param', "this.router.navigate(['/owner-claim'], { queryParams: { token: claimToken } });", 1],
    ['a credential put in navigation state', 'this.router.navigateByUrl(`/restaurants/${id}`, { state: { claimCode } });', 1],
    ['a credential handed to the notice channel', 'this.notices.record({ claimToken });', 1],
    ['a credential handed to the browser location', "window.location.assign('/claim/' + claimToken());", 1],
    // ── rule 1, across lines — the hole review found ─────────────────────────────
    ['a credential written to sessionStorage across several lines', "sessionStorage.setItem(\n  'claim',\n  result.owner_invitation.claim_token,\n);", 1],
    ['a credential logged, one argument per line', "console.log(\n  'issued',\n  claimCode,\n);", 1],
    ['a credential routed as a query param, one option per line', "this.router.navigate(\n  ['/restaurants', id],\n  {\n    queryParams: { code: this.claimToken() },\n  },\n);", 1],
    ['a credential inside an object handed to a sink', "sessionStorage.setItem(\n  'claim',\n  JSON.stringify({\n    token: this.claimToken(),\n  }),\n);", 1],
    ['a credential returned as router state', 'return {\n  queryParams: {\n    c: this.claimToken(),\n  },\n};', 1],
    ['a credential in a template binding beside routerLink, one attribute per line', component('<a\n  [routerLink]="[\'/restaurants\', id]"\n  [queryParams]="{ c: claimToken() }"\n>open</a>'), 1],
    ['a credential in an href', component("<a [href]=\"'/owner-claim/' + claimToken()\">open</a>"), 1],
    // ── rule 2 ──────────────────────────────────────────────────────────────────
    ['a claim URL assembled', 'const link = `${portal}/owner-claim?c=${claim_token}`;', 1],
    ['a claim URL with a path segment', 'const link = `${portal}/owner-claim/${code}`;', 1],
    ['a token query fragment', "const href = '/owner-claim' + '?token=' + code;", 1],
    ['a claim URL concatenated across lines', "const link =\n  portal +\n  '/owner-claim' +\n  '?' +\n  'token=' +\n  code;", 1],
    // ── rule 3 ──────────────────────────────────────────────────────────────────
    ['a credential in the store', 'readonly claimToken = signal<string | null>(null);', 1, 'core/restaurants/restaurant-workspace.store.ts'],
    ['a credential typed onto a canonical detail', 'readonly claim_token: string | null;', 1, 'core/restaurants/restaurant.model.ts'],
    ['the ONE wire field the model may declare', '  readonly claim_token: string;', 0, 'core/restaurants/restaurant.model.ts'],
    // ── what must NOT fire ──────────────────────────────────────────────────────
    ['a credential held in component state', 'this.claimToken.set(result.owner_invitation.claim_token);', 0],
    ['a credential rendered into a readonly field', component('<input\n  readonly\n  [value]="claimToken()"\n/>'), 0],
    ['a credential copied to the clipboard, the legitimate path', "navigator.clipboard.writeText(this.claimToken() ?? '');", 0],
    ['a sibling callback that reports defects is not the credential reaching them', 'this.api.reissueOwnerInvitation(id, request).subscribe({\n  next: (result) => this.claimToken.set(result.owner_invitation.claim_token),\n  error: (error) => this.defects.report(error),\n});', 0],
    ['a sink in the statement BEFORE the credential’s, not in it', "console.log('created');\nthis.claimToken.set(result.owner_invitation.claim_token);", 0],
    ['a sink and a credential in different members of one class', 'class X {\n  private readonly defects = inject(DefectService);\n  protected readonly claimToken = signal<string | null>(null);\n  report(error: unknown) {\n    this.defects.report(error);\n  }\n}', 0],
    ['a restaurant’s location beside a credential is not the browser location', "return {\n  restaurant: { name, location: input.restaurant.location.trim() },\n  owner_invitation: { ...issued, claim_token: mint() },\n};", 0],
    ['the rule described in a line comment', '// never sessionStorage.setItem(claimToken) — it is a bearer credential', 0],
    ['the rule described in a block comment', '/* the claimToken is never put in localStorage */', 0],
    ['the rule described in a template comment', component('<!-- the claimToken is never put in localStorage -->'), 0],
    ['a multi-line template comment', component('<!-- a raw claimToken\n     must never reach localStorage -->\n<input [value]="claimToken()" />'), 0],
    ['the portal screen NAMED in prose, not linked', component("<p>on the restaurant portal's Claim your restaurant screen (/owner-claim), verifies</p>"), 0],
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

// Run only as the entry point, so the exported matcher can be imported by a probe.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
