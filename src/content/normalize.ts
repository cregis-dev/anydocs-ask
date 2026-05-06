/**
 * Text normalization for content_hash, the cornerstone of PRD §4.6
 * "drag-zero-reembed". Algorithm is deliberately deterministic, cross-platform
 * and frozen for the v1 cycle — any change invalidates every embedding cache
 * entry.
 *
 * Algorithm (ARCH §7.1.2, locked 2026-05-04):
 *   1. NFKC unicode normalization (CJK fullwidth/halfwidth fold)
 *   2. Line ending unify: \r\n / \r -> \n
 *   3. Strip zero-width chars: U+200B U+200C U+200D U+FEFF
 *   4. Per-line collapse runs of spaces / tabs into a single space
 *   5. trimEnd each line; trim the whole string
 *   6. UTF-8 encode and SHA-256
 *
 * Explicit non-rules (also ARCH §7.1.2):
 *   - NO case folding (getUserById vs getuserbyid must stay distinct).
 *   - NO punctuation normalization (NFKC already collapses fullwidth/halfwidth).
 *   - Code blocks normalize the same way as prose.
 */

import { createHash } from 'node:crypto';

const ZERO_WIDTH = /[​‌‍﻿]/g;

export function normalizeText(input: string): string {
  // 1. Unicode NFKC
  let text = input.normalize('NFKC');

  // 2. Line ending unify (\r\n first to avoid double-conversion)
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 3. Zero-width chars
  text = text.replace(ZERO_WIDTH, '');

  // 4 + 5: per-line collapse + trimEnd
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/g, ''))
    .join('\n');

  // 5b: outer trim on the whole document
  text = text.trim();

  return text;
}

export function contentHash(text: string): string {
  const normalized = normalizeText(text);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * The version tag of this normalize algorithm. ARCH §7.1.2 mandates a sidecar
 * file (`normalize_version`) that, when out of sync, forces a cache wipe + full
 * rebuild. That guard is wired in stage 5; for now this constant is the source
 * of truth and `runMigrations` carries the matching SQL schema version.
 */
export const NORMALIZE_VERSION = 1;
