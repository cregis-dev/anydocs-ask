/**
 * Markdown section splitter — vendored + adapted from
 * `@anydocs/core` 1.3.5 (`packages/core/src/publishing/build-artifacts.ts`).
 *
 * Two intentional divergences from upstream:
 *
 *   1. `stripMarkdown` keeps fenced code blocks (and inline code) instead of
 *      replacing them with whitespace. Reason: anydocs uses this code path
 *      for search snippets where code is noise; we use it for RAG retrieval
 *      where API names / shell commands / config samples are exactly what
 *      users ask about. Aligned with ARCH §7.1 (revised 2026-05-06):
 *      "code blocks ride along with their section, not atomized."
 *
 *   2. The chunk size constants are exported as defaults but the public
 *      `splitChunkText` lets callers override per-call (no more, no less
 *      than what anydocs build does today, but explicit so stage 5/6 has a
 *      knob without copy-pasting the function).
 *
 * Source pin: anydocs 1.3.5. When upgrading, diff `extractMarkdownSections`,
 * `stripMarkdown`, `splitChunkText`, and the fence helpers against upstream.
 */

import { createHeadingIdGenerator } from './heading-ids.ts';

export const CHUNK_MAX_CHARS_DEFAULT = 2000;
export const CHUNK_OVERLAP_CHARS_DEFAULT = 200;

export type SearchSection = {
  /** Heading titles from h1 down to current section's heading. Empty for prose
   *  before any heading. */
  headingPath: string[];
  /** Stable slug of the deepest heading; empty when there's no heading above. */
  headingId: string;
  /** Plain-ish text body of the section. Code blocks preserved (per the
   *  divergence above); markdown emphasis / link / heading marks stripped. */
  text: string;
};

/**
 * Strip markdown to plain-ish text. Diverges from anydocs by preserving the
 * insides of fenced + inline code blocks.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    // Fenced code: keep the inner code, drop the fence + language tag.
    // Match either ``` or ~~~, optional language, body, then matching close.
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/~~~[a-zA-Z0-9_-]*\n?([\s\S]*?)~~~/g, '$1')
    // Inline code: keep code text.
    .replace(/`([^`]*)`/g, '$1')
    // Images: keep alt text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links: keep link text.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // HTML tags: drop entirely.
    .replace(/<\/?[^>]+>/g, ' ')
    // Markdown emphasis / blockquote marks. Note: heading marks (#) are also
    // stripped here, but extractMarkdownSections has already pulled headings
    // out into section boundaries, so what hits this regex is body text only.
    .replace(/[*#>~]/g, ' ')
    // Whitespace collapse.
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHeadingPlainText(source: string): string {
  return stripMarkdown(source)
    .replace(/_/g, ' ')
    .replace(/\\([\\`*_[\]{}()#+.!-])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function getFenceDelimiter(line: string): string | null {
  const trimmed = line.trim();
  const match = /^(```+|~~~+)/.exec(trimmed);
  return match?.[1] ?? null;
}

function closesFence(line: string, delimiter: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith(delimiter[0] ?? '')) return false;
  const match = /^(```+|~~~+)/.exec(trimmed);
  return Boolean(match && match[1] && match[1][0] === delimiter[0] && match[1].length >= delimiter.length);
}

function stripLeadingTitleHeading(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  let index = 0;
  while (index < lines.length && lines[index]?.trim() === '') index += 1;
  const firstLine = lines[index]?.trim();
  if (!firstLine) return markdown;
  const expectedHeading = `# ${title.trim()}`;
  if (firstLine !== expectedHeading) return markdown;
  index += 1;
  while (index < lines.length && lines[index]?.trim() === '') index += 1;
  return lines.slice(index).join('\n');
}

/**
 * Split markdown into sections at h1..h6 boundaries. The page title's leading
 * h1 is dropped so the first body section doesn't carry it (anydocs renders
 * the title separately at the page level).
 *
 * Returns one section per heading-bounded region, plus an optional leading
 * "preface" section (empty headingPath) for prose that sits before any heading.
 */
export function extractMarkdownSections(markdown: string, title: string): SearchSection[] {
  const normalized = stripLeadingTitleHeading(markdown, title).replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const sections: SearchSection[] = [];
  const headingStack: Array<{ depth: number; title: string }> = [];
  const nextHeadingId = createHeadingIdGenerator();
  const lines = normalized.split('\n');

  let currentHeadingPath: string[] = [];
  let currentHeadingId = '';
  let currentLines: string[] = [];
  let activeFenceDelimiter: string | null = null;

  const flushCurrent = (): void => {
    const text = stripMarkdown(currentLines.join('\n'));
    if (!text) return;
    sections.push({
      headingPath: [...currentHeadingPath],
      headingId: currentHeadingId,
      text,
    });
  };

  for (const line of lines) {
    const fenceDelimiter = getFenceDelimiter(line);
    if (activeFenceDelimiter) {
      currentLines.push(line);
      if (fenceDelimiter && closesFence(line, activeFenceDelimiter)) {
        activeFenceDelimiter = null;
      }
      continue;
    }
    if (fenceDelimiter) {
      activeFenceDelimiter = fenceDelimiter;
      currentLines.push(line);
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!headingMatch) {
      currentLines.push(line);
      continue;
    }

    flushCurrent();
    currentLines = [];

    const depth = headingMatch[1]!.length;
    const headingTitle = extractHeadingPlainText(headingMatch[2]!);
    if (!headingTitle) {
      currentLines.push(line);
      continue;
    }
    const headingId = nextHeadingId(headingTitle);
    while (
      headingStack.length > 0 &&
      headingStack[headingStack.length - 1]!.depth >= depth
    ) {
      headingStack.pop();
    }
    headingStack.push({ depth, title: headingTitle });
    currentHeadingPath = headingStack.map((entry) => entry.title);
    currentHeadingId = headingId;
  }

  flushCurrent();
  return sections;
}

/**
 * Slice a section's text into chunk-sized pieces. Short sections pass through
 * as a single chunk (preserves block-level completeness — the user's
 * principle); long sections are split at the last whitespace inside the cap
 * with a small overlap to keep ideas across boundaries.
 */
export function splitChunkText(
  text: string,
  maxChars: number = CHUNK_MAX_CHARS_DEFAULT,
  overlapChars: number = CHUNK_OVERLAP_CHARS_DEFAULT,
): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);
    if (end < normalized.length) {
      const lastSpace = normalized.lastIndexOf(' ', end);
      if (lastSpace > start + Math.floor(maxChars * 0.6)) {
        end = lastSpace;
      }
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}
