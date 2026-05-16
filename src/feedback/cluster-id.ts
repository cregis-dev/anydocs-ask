/**
 * Inbox file cluster_id generation — `<YYYY>-W<II>-<NNN>-<slug>`.
 *
 * ARCH §15.5.1 example: `2026-W18-001-jwt-auth.md`.
 *
 * 0.2 simplification: NNN = the feedback_id zero-padded to 3 digits. With
 * one inbox file per feedback row (no clustering yet), this is deterministic
 * and collision-free without needing per-week serial-number bookkeeping.
 * Filenames remain sortable as long as ids stay within 3 digits; past that
 * the prefix widens but ordering still works inside each width bucket.
 */

import { toIsoWeek } from '../runs/iso-week.ts';

const MAX_SLUG_LEN = 32;

export function clusterIdFor(args: {
  feedback_id: number;
  created_at_ms: number;
  question: string;
}): string {
  const week = toIsoWeek(new Date(args.created_at_ms));
  const nnn = String(args.feedback_id).padStart(3, '0');
  const slug = slugify(args.question);
  return `${week}-${nnn}-${slug}`;
}

/**
 * Slugify a question for use in a filename. ASCII alphanumerics + hyphen,
 * plus the BMP CJK range (U+4E00–U+9FFF) for Chinese questions — anydocs is
 * multilingual and forcing translit would lose semantic value in filenames.
 *
 * Empty result (e.g. all punctuation) → "query" so we never emit a trailing
 * hyphen as the slug part.
 */
export function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9一-鿿-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const truncated = cleaned.slice(0, MAX_SLUG_LEN).replace(/-+$/g, '');
  return truncated.length > 0 ? truncated : 'query';
}
