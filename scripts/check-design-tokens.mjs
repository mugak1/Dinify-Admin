#!/usr/bin/env node
/**
 * Standing gate (ADMIN-TOKENS-00): nothing under `src/app` spells a design value.
 *
 * Modelled directly on Dinify-Frontend's `scripts/check-platform-roles.mjs`, including
 * its `--self-test` mode — a matcher that silently stopped matching would otherwise
 * pass everything forever, and "the tree happens to be clean today" is not evidence
 * that a gate works.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 *
 * Spec §16 keeps brand red `#FF2C32` under an explicit review trigger: it is the
 * interactive colour PENDING a look at real density. That review is only cheap if
 * retinting the entire interactive surface is a one-line change to `--admin-accent`
 * in `src/styles.css`. One `bg-[#FF2C32]` in a component and it stops being one line
 * — and nobody finds out until the review, when the change lands and half the buttons
 * do not move.
 *
 * The same argument applies to the type scale and the radii. Dinify-Frontend's own
 * config records how that goes wrong: its 14px root made rem-based sizes land ~12.5%
 * under nominal, which bred a crop of arbitrary `text-[18.5px]`-style values that
 * later had to be swept out by hand. A guard is cheaper than a sweep.
 *
 * Without this the tokens are a suggestion.
 *
 * ── THE FOUR RULES ────────────────────────────────────────────────────────────────
 *
 *   1. HEX COLOUR LITERAL      — `#fff`, `#FF2C32`, `#FF2C32AA`
 *   2. FUNCTIONAL COLOUR       — `rgb(`, `rgba(`, `hsl(`, `hsla(`
 *   3. ARBITRARY SIZE          — any `text-[...]` or `rounded-[...]` Tailwind value
 *   4. SECOND FONT FAMILY      — a `font-family` declaration, or any family utility
 *                                other than the single `font-sans` token
 *
 * ── SCOPE, AND WHAT IS DELIBERATELY OUTSIDE IT ────────────────────────────────────
 *
 * `src/app/**` only. `src/styles.css` (the token table) and `tailwind.config.js` (the
 * names) are where design values BELONG, so scanning them would be scanning the
 * answer. `src/index.html` is outside too — it carries no styling.
 *
 * ── WHAT IT DOES NOT GUARD ────────────────────────────────────────────────────────
 *
 * It is source text, not semantic analysis. A colour assembled at runtime
 * (`'#' + computed`), a value read from an API, or a class name built by string
 * concatenation from fragments that are individually innocent all pass. What it
 * proves is that no design value is WRITTEN in a component — which is the failure
 * mode that actually happens, because it is the convenient one.
 *
 * Usage (no build, no deps):
 *
 *     node scripts/check-design-tokens.mjs              # scan the tree
 *     node scripts/check-design-tokens.mjs --self-test  # prove the matcher fires
 *
 * Exit 0 if clean, 1 if any violation is found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = join(REPO_ROOT, 'src', 'app');

/** Extensions worth scanning. Component styles would be `.css` if any existed. */
const SCANNED_EXTENSIONS = ['.ts', '.html', '.css'];

const PRUNE_DIRS = new Set(['node_modules', 'dist', '.angular', 'coverage', 'out-tsc']);

/**
 * The one font-family utility a component may use. Everything else — including
 * Gabarito and Bricolage Grotesque, which carry the customer surfaces' identity — is
 * refused: §16 makes visual distinctness from the restaurant portal a SAFETY
 * requirement, and a second typeface is the fastest way to erode it.
 */
const ALLOWED_FONT_UTILITY = 'font-sans';

/**
 * Files entitled to spell the forbidden patterns.
 *
 * Only this script, which has to spell them in order to search for them. There is no
 * companion spec: unlike the sibling's platform-role ratchet — which has an object
 * graph (the route config) a Karma spec can assert — a token gate has nothing to
 * inspect at runtime, so `--self-test` IS the proof that the matcher fires, and CI
 * runs it before the real scan.
 */
const SELF_EXEMPT = new Set(['scripts/check-design-tokens.mjs']);

/**
 * Deliberate, reviewed exceptions: {'relative/path': ['RULE_ID', ...]}.
 *
 * EMPTY, AND MEANT TO STAY THAT WAY. If you are about to add an entry, the thing to
 * examine is whether the token system is missing a token — which is a real and
 * fixable answer — not whether this file should look the other way.
 */
export const ALLOWLIST = Object.create(null);

/**
 * Rule 1 — a hex colour: `#` plus exactly 3, 4, 6 or 8 hex digits, not part of a
 * longer word. Longest-first alternation so `#FF2C32AA` is not read as `#FF2` + junk.
 * Global so `hasHexColour` can examine each match in context.
 */
const HEX_COLOUR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;

/**
 * Angular template reference variables collide with short hex colours, and the
 * self-test found it before the tree did: `<input #fed />` is a perfectly ordinary
 * template ref whose name happens to be three hex digits. So is `#cab`, `#dad`,
 * `#face`, `#beef`.
 *
 * The discriminator is CONTEXT, and it only has to cover the 3- and 4-digit forms —
 * a six-character all-hex identifier is not a name anybody writes.
 *
 * A template ref is preceded by whitespace or `<`, and followed by whitespace, `>`,
 * `/` or `=`. A colour in either of those positions is followed by something else
 * entirely: `;`, `"`, `'`, `]`, `)`, or the end of the line. So:
 *
 *   <input #fed />              preceded by ' ', followed by ' '  → a template ref
 *   border: 1px solid #fed;     preceded by ' ', followed by ';'  → a colour
 *   <div style="color:#fed">    preceded by ':'                   → a colour
 *   const c = '#fed';           preceded by "'"                   → a colour
 *
 * Erring toward FLAGGING is deliberate: a false positive is a build failure somebody
 * investigates, a false negative is a hardcoded colour nobody ever finds.
 */
function hasHexColour(line) {
  HEX_COLOUR.lastIndex = 0;
  let match;
  while ((match = HEX_COLOUR.exec(line)) !== null) {
    const digits = match[0].length - 1;
    if (digits > 4) return true; // 6 or 8 digits is always a colour.

    const before = match.index > 0 ? line[match.index - 1] : '';
    const after = line[match.index + match[0].length] ?? '';
    const looksLikeTemplateRef =
      (before === '' || before === '<' || /\s/.test(before)) && /[\s>/=]/.test(after);

    if (!looksLikeTemplateRef) return true;
  }
  return false;
}

/** Rule 2 — a functional colour notation of any kind. */
const FUNCTIONAL_COLOUR = /\b(?:rgba?|hsla?)\s*\(/;

/**
 * Rule 3 — an arbitrary Tailwind value on the two families §B pins. ALL arbitrary
 * values are refused, not only px ones: `text-[13px]`, `text-[0.8rem]` and
 * `text-[#fff]` are the same mistake wearing three hats.
 */
const ARBITRARY_TEXT = /\btext-\[[^\]]*\]/;
const ARBITRARY_ROUNDED = /\brounded(?:-[a-z]+)?-\[[^\]]*\]/;

/** Rule 4a — a raw CSS/inline font-family declaration. */
const FONT_FAMILY_DECLARATION = /font-family\s*:/;

/**
 * Rule 4b — a Tailwind font FAMILY utility that is not the allowed one.
 *
 * Deliberately a closed list plus the arbitrary form, NOT `font-<anything>`: the
 * weight utilities (`font-semibold`, `font-bold`, `font-medium`) and the numeric
 * variants share the prefix and are perfectly fine. A closed list is the only way to
 * separate "family" from "weight" without parsing Tailwind's theme.
 */
const FONT_FAMILY_UTILITY =
  /\bfont-(?:serif|mono|display|gabarito|bricolage|jakarta|\[[^\]]*\])(?![0-9a-zA-Z_-])/;

const RULES = [
  {
    id: 'hex-colour',
    test: (line) => hasHexColour(line),
    reason:
      'spells a hex colour; every colour lives in src/styles.css so the §16 brand-red ' +
      'review stays a one-line change',
  },
  {
    id: 'functional-colour',
    test: (line) => FUNCTIONAL_COLOUR.test(line),
    reason:
      'spells an rgb()/hsl() colour; use a Tailwind token class, which already carries ' +
      'the alpha modifier (bg-admin-accent/10)',
  },
  {
    id: 'arbitrary-size',
    test: (line) => ARBITRARY_TEXT.test(line) || ARBITRARY_ROUNDED.test(line),
    reason:
      'uses an arbitrary text-[..] or rounded-[..] value; pick a semantic size token, ' +
      'or add one deliberately to tailwind.config.js',
  },
  {
    id: 'font-family',
    test: (line) => FONT_FAMILY_DECLARATION.test(line) || FONT_FAMILY_UTILITY.test(line),
    reason: `declares a font family other than ${ALLOWED_FONT_UTILITY}; this application has ` +
      'ONE typeface, and a second is how it stops being distinguishable from the ' +
      'restaurant portal at a glance',
  },
];

/** Return `[{line, rule, reason}]` for one file's source. */
export function findViolationsInSource(source, relativePath) {
  const allowed = new Set(ALLOWLIST[relativePath] ?? []);
  const violations = [];

  source.split('\n').forEach((text, index) => {
    for (const rule of RULES) {
      if (allowed.has(rule.id)) continue;
      if (rule.test(text)) {
        violations.push({ line: index + 1, rule: rule.id, reason: rule.reason });
      }
    }
  });

  return violations;
}

/** Yield every scannable file under `root`, as repo-relative POSIX paths. */
export function* iterScannedFiles(root = APP_ROOT) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir).sort()) {
      if (PRUNE_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
      const rel = relative(REPO_ROOT, full).split(sep).join('/');
      if (SELF_EXEMPT.has(rel)) continue;
      yield rel;
    }
  }
}

/** Return `[{file, line, rule, reason}]` across the whole application source tree. */
export function findViolations() {
  const found = [];
  for (const rel of iterScannedFiles()) {
    const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const violation of findViolationsInSource(source, rel)) {
      found.push({ file: rel, ...violation });
    }
  }
  return found;
}

/** Human-readable report lines (empty when clean). */
export function formatViolations(violations) {
  if (!violations.length) return [];
  const lines = ['Design-token gate: FAIL — a design value is spelled in a component:', ''];
  for (const { file, line, rule, reason } of violations) {
    lines.push(`  ${file}:${line}: ${rule} — ${reason}`);
  }
  lines.push(
    '',
    `${violations.length} violation(s). Tokens live in src/styles.css and tailwind.config.js; ` +
      'components name them and never restate them.',
  );
  return lines;
}

/**
 * Prove the matcher fires, on synthetic source, without touching the tree.
 *
 * Every case below is either a violation this gate exists to catch, or a NEAR MISS it
 * must not catch — and the near misses are the important half. A false positive here
 * is a broken build for legitimate code, which is how a gate gets allowlisted into
 * uselessness.
 */
function selfTest() {
  const cases = [
    // --- Rule 1: hex colours -------------------------------------------------------
    ['six-digit hex in a class', "class=\"bg-[#FF2C32]\"", 1],
    ['three-digit hex', 'const c = \'#fff\';', 1],
    ['eight-digit hex with alpha', 'border: 1px solid #FF2C32AA;', 1],
    ['four-digit hex', 'const c = \'#fffa\';', 1],
    ['hex inside a style binding', '[style.color]="\'#16181D\'"', 1],

    // --- Rule 2: functional colours ------------------------------------------------
    ['rgb()', 'box-shadow: 0 1px 2px rgb(0 0 0 / 0.1);', 1],
    ['rgba()', 'const shadow = \'rgba(0,0,0,.12)\';', 1],
    ['hsl() in a component', 'color: hsl(var(--admin-accent));', 1],

    // --- Rule 3: arbitrary sizes ---------------------------------------------------
    ['arbitrary text px', 'class="text-[13px] text-ink"', 1],
    ['arbitrary text rem', 'class="text-[0.8125rem]"', 1],
    ['arbitrary rounded', 'class="rounded-[20px]"', 1],
    ['arbitrary rounded with a step', 'class="rounded-tl-[3px]"', 1],

    // --- Rule 4: font families -----------------------------------------------------
    ['css font-family', 'font-family: Gabarito, sans-serif;', 1],
    ['font-display utility', 'class="font-display text-ink"', 1],
    ['font-mono utility', 'class="font-mono"', 1],
    ['arbitrary font utility', 'class="font-[\'Gabarito\']"', 1],

    // --- Near misses that MUST NOT fire --------------------------------------------
    ['a token colour class', 'class="bg-admin-accent text-admin-accent-fg"', 0],
    ['a semantic size token', 'class="text-admin-body text-ink-muted"', 0],
    ['a scale radius', 'class="rounded-lg ring-1 ring-line"', 0],
    ['the allowed font utility', 'class="font-sans antialiased"', 0],
    ['a font WEIGHT utility', 'class="font-semibold text-admin-section"', 0],
    ['another weight utility', 'class="font-medium"', 0],
    ['a spacing token that looks arbitrary', 'class="h-row w-sidebar top-topbar"', 0],
    ['an Angular template reference', '<input #code name="code" />', 0],
    ['a template ref whose name is hex-ish', '<input #fed />', 0],
    ['a fragment link', "routerLink=\"/support\" fragment=\"abc\"", 0],
    ['a template ref whose name is hex-ish', '<input #fed />', 0],
    ['a self-closing template ref', '<div #cab/>', 0],
    ['a template ref with an exportAs', '<input #beef="ngModel" />', 0],
    ['a short hex in a CSS declaration', 'border: 1px solid #fed;', 1],
    ['a short hex in a style attribute', '<div style="color:#fed">', 1],
    ['a short hex at end of line', 'const c = \'#fed\';', 1],
    ['an id selector in prose', '// see the #dialog element above', 0],
    ['an opacity modifier on a token', 'class="ring-admin-accent/20"', 0],
    ['a CSS variable reference by name', "const token = 'var(--admin-accent)';", 0],
    ['a numeric literal that is not a colour', 'const MAX = 0xff2c32;', 0],
  ];

  let failures = 0;
  for (const [label, source, expected] of cases) {
    const got = findViolationsInSource(source, 'synthetic.ts').length;
    const ok = expected === 0 ? got === 0 : got >= 1;
    if (!ok) {
      failures += 1;
      console.error(
        `  self-test FAIL: ${label} — expected ${expected === 0 ? 'no' : 'a'} violation, got ${got}`,
      );
    }
  }

  if (failures) {
    console.error(`\nDesign-token gate self-test: ${failures} case(s) failed.`);
    return 1;
  }
  console.log(`Design-token gate self-test: OK — ${cases.length} cases, matcher fires.`);
  return 0;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const violations = findViolations();
  if (violations.length) {
    for (const line of formatViolations(violations)) console.log(line);
    return 1;
  }
  const scanned = [...iterScannedFiles()].length;
  console.log(
    `Design-token gate: OK — scanned ${scanned} source file(s), no design values in components.`,
  );
  return 0;
}

process.exit(main());
