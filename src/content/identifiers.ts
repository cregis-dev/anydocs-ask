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
      for (const segment of item.value.split('.')) {
        const value = segment.replace(/\[\]$/, '');
        if (value.includes('_')) candidates.push({ value, normalized: normalizeIdentifier(value), kind: 'field' });
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
