/**
 * A reader for the block-YAML subset GitHub workflow files in these repositories use —
 * so the wiring tests can inspect the REAL workflow files in a repository whose
 * dependency graph has no YAML library (Dinify-Admin), and so the code stays identical
 * across repositories. In Dinify-Frontend, which does have `yaml`, a test holds this
 * reader's output equal to the library's for every workflow file: it is checked against
 * an oracle, not trusted.
 *
 * Supported: block mappings and sequences, plain / single- / double-quoted scalars,
 * block scalars (`|`, `|-`, `>`, `>-`), flow sequences and simple flow mappings of
 * scalars, comments. Anything outside that throws rather than guessing.
 */

function stripComment(line) {
  let out = ''; let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === "'" && ch === "'" && line[i + 1] === "'") { out += "'"; i += 1; continue; }
      if (quote === '"' && ch === '\\') { out += line[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (out.trim() === '' || /[:\-[{,]\s*$/.test(out))) { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

function scalar(text) {
  const t = text.trim();
  if (t === '') return null;
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new Error(`unterminated string: ${t}`);
    return JSON.parse(t);
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new Error(`unterminated string: ${t}`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith('[')) return flowSeq(t);
  if (t.startsWith('{')) return flowMap(t);
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?(0|[1-9][0-9]*)$/.test(t)) return Number(t);
  if (/^-?[0-9]+\.[0-9]+$/.test(t)) return Number(t);
  return t;
}

function splitFlow(inner) {
  const parts = []; let depth = 0; let cur = ''; let quote = null;
  for (const ch of inner) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function flowSeq(t) {
  if (!t.endsWith(']')) throw new Error(`unterminated flow sequence: ${t}`);
  return splitFlow(t.slice(1, -1)).map((p) => scalar(p));
}

function flowMap(t) {
  if (!t.endsWith('}')) throw new Error(`unterminated flow mapping: ${t}`);
  const out = {};
  for (const part of splitFlow(t.slice(1, -1))) {
    const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(part);
    if (!m) throw new Error(`unsupported flow mapping entry: ${part}`);
    out[scalar(m[1])] = scalar(m[2]);
  }
  return out;
}

const KEY = /^((?:"[^"]*"|'[^']*'|[^\s"'#][^:#]*?))\s*:(?:\s+(.*)|)$/;

export function parseYaml(source) {
  const raw = source.replace(/\r\n/g, '\n').split('\n');
  const lines = raw.map((text, n) => ({ n, text, indent: text.length - text.trimStart().length }));
  let i = 0;

  const skipBlank = () => { while (i < lines.length && stripComment(lines[i].text).trim() === '') i += 1; };

  function blockScalar(header, parentIndent) {
    const folded = header.startsWith('>');
    const chomp = header.endsWith('-') ? 'strip' : header.endsWith('+') ? 'keep' : 'clip';
    const body = [];
    let indent = null;
    while (i < lines.length) {
      const { text } = lines[i];
      if (text.trim() === '') { body.push(''); i += 1; continue; }
      const ind = text.length - text.trimStart().length;
      if (ind <= parentIndent) break;
      if (indent === null) indent = ind;
      if (ind < indent) break;
      body.push(text.slice(indent));
      i += 1;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    let value;
    if (folded) {
      value = '';
      for (let k = 0; k < body.length; k += 1) {
        const line = body[k];
        if (k === 0) { value = line; continue; }
        const prev = body[k - 1];
        if (line === '') { value += '\n'; continue; }
        // Folding joins ordinary lines with a space; a MORE-INDENTED line keeps its breaks.
        if (prev === '') value += line;
        else if (/^\s/.test(line) || /^\s/.test(prev)) value += `\n${line}`;
        else value += ` ${line}`;
      }
    } else value = body.join('\n');
    return chomp === 'strip' ? value : `${value}\n`;
  }

  function node(indent) {
    skipBlank();
    if (i >= lines.length) return null;
    const first = stripComment(lines[i].text);
    const ind = lines[i].indent;
    if (ind < indent) return null;
    return first.trimStart().startsWith('- ') || first.trim() === '-' ? sequence(ind) : mapping(ind);
  }

  function valueAfter(rest, ownIndent) {
    if (rest === undefined || rest === '') { const child = node(ownIndent + 1); return child; }
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(rest, ownIndent);
    return scalar(rest);
  }

  function mapping(indent, seed) {
    const out = seed ?? {};
    for (;;) {
      skipBlank();
      if (i >= lines.length) return out;
      const line = lines[i];
      if (line.indent !== indent) {
        if (line.indent < indent) return out;
        throw new Error(`line ${line.n + 1}: unexpected indentation`);
      }
      const text = stripComment(line.text).trim();
      if (text.startsWith('- ')) return out;
      const m = KEY.exec(text);
      if (!m) throw new Error(`line ${line.n + 1}: not a mapping entry: ${text}`);
      const key = scalar(m[1]);
      i += 1;
      out[key] = valueAfter(m[2], indent);
    }
  }

  function sequence(indent) {
    const out = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length) return out;
      const line = lines[i];
      const text = stripComment(line.text);
      if (line.indent < indent || !text.trimStart().startsWith('-')) return out;
      if (line.indent > indent) throw new Error(`line ${line.n + 1}: unexpected indentation`);
      const after = text.trimStart().slice(1);
      const content = after.trimStart();
      const itemIndent = indent + 1 + (after.length - content.length);
      if (content === '') { i += 1; out.push(node(indent + 1)); continue; }
      const m = KEY.exec(content);
      if (m && !content.startsWith('"') && !content.startsWith("'")) {
        // `- key: value` opens a mapping whose further keys sit at the item's indent.
        i += 1;
        const first = {};
        first[scalar(m[1])] = valueAfter(m[2], itemIndent);
        out.push(mapping(itemIndent, first));
      } else {
        i += 1;
        out.push(scalar(content));
      }
    }
  }

  const doc = node(0);
  skipBlank();
  if (i < lines.length) throw new Error(`line ${lines[i].n + 1}: could not be read`);
  return doc;
}
