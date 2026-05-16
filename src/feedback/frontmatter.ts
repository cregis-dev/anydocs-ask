/**
 * A deliberately small YAML subset for inbox frontmatter.
 *
 * Supported (and only these):
 *   key: scalar              # string | number | boolean
 *   key: "quoted scalar"     # double or single quotes; supports \n, \t, \\, \"
 *   key: [a, b, "c, d"]      # inline arrays only — no block-form `- item`
 *   key:                     # empty string sugar (value omitted)
 *   # comment                # full-line comments, trimmed before parse
 *
 * Unsupported on purpose (the frontmatter is bounded by `types.ts`):
 *   - nested mappings (we flatten)
 *   - block arrays (`- item` form)
 *   - multi-line scalars (use the markdown body for free-form text)
 *   - anchors / aliases / tags
 *
 * This subset is round-trippable: the emitter only produces shapes the parser
 * accepts, and the parser never silently coerces — a malformed line throws.
 */

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];

export class FrontmatterParseError extends Error {
  readonly lineNumber: number;
  constructor(lineNumber: number, message: string) {
    super(`frontmatter line ${lineNumber}: ${message}`);
    this.lineNumber = lineNumber;
    this.name = 'FrontmatterParseError';
  }
}

export function parseFrontmatter(yaml: string): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const stripped = stripComment(rawLine).trim();
    if (stripped.length === 0) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(stripped);
    if (!m) {
      throw new FrontmatterParseError(i + 1, `expected 'key: value', got '${rawLine}'`);
    }
    const [, key, raw] = m;
    out[key!] = parseValue(raw!, i + 1);
  }
  return out;
}

export function emitFrontmatter(obj: Record<string, FrontmatterValue>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${emitValue(v)}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripComment(line: string): string {
  // Strip trailing `# ...` comments, but only when `#` is outside any quoted
  // string. Backslash escapes inside quotes (`\"`) don't terminate the quote.
  let inQ = false;
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === q) inQ = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inQ = true;
      q = c;
      continue;
    }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

function parseValue(raw: string, lineNumber: number): FrontmatterValue {
  const s = raw.trim();
  if (s.length === 0) return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) {
      throw new FrontmatterParseError(lineNumber, `unterminated inline array: '${raw}'`);
    }
    return parseInlineArray(s, lineNumber);
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.length < 2) throw new FrontmatterParseError(lineNumber, `bad quoted scalar: '${raw}'`);
    return unquote(s, lineNumber);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) {
    return Number(s);
  }
  return s;
}

function parseInlineArray(s: string, lineNumber: number): FrontmatterScalar[] {
  const inner = s.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const parts: string[] = [];
  let inQ = false;
  let q = '';
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (inQ) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === q) inQ = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inQ = true;
      q = c;
      continue;
    }
    if (c === ',') {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  const out: FrontmatterScalar[] = [];
  for (const p of parts) {
    const v = parseValue(p, lineNumber);
    if (Array.isArray(v)) {
      throw new FrontmatterParseError(lineNumber, 'nested arrays are not supported');
    }
    out.push(v);
  }
  return out;
}

function unquote(s: string, lineNumber: number): string {
  const inner = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      throw new FrontmatterParseError(lineNumber, 'dangling escape at end of string');
    }
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      default: out += next;
    }
    i++;
  }
  return out;
}

function emitValue(v: FrontmatterValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(emitScalar).join(', ')}]`;
  return emitScalar(v);
}

function emitScalar(v: FrontmatterScalar): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Quote when:
  //   - empty (so the parser doesn't read it as "no value")
  //   - contains structural chars (: # " ' [ ] , \)
  //   - leading/trailing whitespace
  //   - looks like another scalar type (number, bool, null)
  if (
    v === '' ||
    /[:#"'\[\],\\]/.test(v) ||
    /^\s|\s$/.test(v) ||
    /^(true|false|null|~|-?\d)/.test(v)
  ) {
    return JSON.stringify(v);
  }
  return v;
}
