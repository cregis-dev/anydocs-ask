export type IndexedIdentifier = {
  value: string;
  normalized: string;
  kind: 'api-path' | 'address' | 'hash' | 'error-code' | 'field' | 'header' | 'operation-id';
};

const PATTERNS: Array<{ kind: IndexedIdentifier['kind']; pattern: RegExp }> = [
  { kind: 'hash', pattern: /\b0x[a-fA-F0-9]{64}\b/g },
  { kind: 'hash', pattern: /\b[a-fA-F0-9]{64}\b/g },
  { kind: 'address', pattern: /\b0x[a-fA-F0-9]{40}\b/g },
  { kind: 'address', pattern: /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g },
  { kind: 'error-code', pattern: /\b[A-Z]\d{4}\b/g },
  { kind: 'api-path', pattern: /\/(?:openapi|api)\/v\d+(?:\/[A-Za-z0-9_.{}:-]+)+/gi },
  { kind: 'operation-id', pattern: /(?<=Operation ID:\s)[A-Za-z][A-Za-z0-9_]*/g },
  { kind: 'operation-id', pattern: /\b[a-z]+(?:[A-Z][A-Za-z0-9]+){2,}\b/g },
  { kind: 'header', pattern: /\bAccess-(?:Key|Timestamp|Nonce|Signature)\b/gi },
  { kind: 'field', pattern: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?:\[\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)*\b/g },
  { kind: 'field', pattern: /\b(?:data|request|response)(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)+\b/gi },
  { kind: 'address', pattern: /\b(?=[1-9A-HJ-NP-Za-km-z]{32,50}\b)(?=[1-9A-HJ-NP-Za-km-z]*\d)[1-9A-HJ-NP-Za-km-z]{32,50}\b/g },
];

/** Extract stable technical identifiers for exact, indexed lookup. */
export function extractIndexedIdentifiers(text: string): IndexedIdentifier[] {
  const found: Array<IndexedIdentifier & { index: number }> = [];
  for (const { kind, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = trim(match[0]);
      if (!value) continue;
      found.push({ value, normalized: normalizeIdentifier(value), kind, index: match.index ?? 0 });
    }
  }

  found.sort((a, b) => a.index - b.index || b.value.length - a.value.length);
  const seen = new Set<string>();
  const out: IndexedIdentifier[] = [];
  for (const item of found) {
    const candidates: IndexedIdentifier[] = [item];
    if (item.kind === 'field' && item.value.includes('.')) {
      const segments = item.value.split('.');
      for (const segment of segments) {
        const value = segment.replace(/\[\]$/, '');
        if (value.includes('_')) candidates.push({ value, normalized: normalizeIdentifier(value), kind: 'field' });
      }
      // OpenAPI renders complete paths such as `data.rows[].fee`. Index the
      // leaf as well so a natural query that names only `fee` can take the
      // exact-match path. Restrict this to the terminal segment: indexing
      // generic containers such as `data` and `rows` would add broad noise.
      const leaf = segments.at(-1)?.replace(/\[\]$/, '');
      if (leaf && /^[A-Za-z][A-Za-z0-9]{2,}$/.test(leaf)) {
        candidates.push({ value: leaf, normalized: normalizeIdentifier(leaf), kind: 'field' });
      }
    }
    for (const candidate of candidates) {
      if (seen.has(candidate.normalized)) continue;
      seen.add(candidate.normalized);
      out.push({ value: candidate.value, normalized: candidate.normalized, kind: candidate.kind });
    }
  }
  return out;
}

export function normalizeIdentifier(value: string): string {
  return trim(value).toLowerCase();
}

function trim(value: string): string {
  return value.replace(/^[`'"(\[]+|[`'"),.;:!?，。；：！？\]]+$/gu, '');
}
