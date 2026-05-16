/**
 * Inbox markdown round-trip — frontmatter + body sections.
 *
 * File shape (ARCH §15.5.2, lightly adapted for our flat frontmatter):
 *
 *   ---
 *   cluster_id: ...
 *   queries: [...]
 *   decision: pending
 *   ...
 *   ---
 *
 *   ## System answer
 *
 *   <generated answer; read-only reference for the reviewer>
 *
 *   ## Retrieved chunks
 *
 *   - **<breadcrumb>** — <snippet>
 *
 *   ## Corrected answer
 *
 *   <author's correction goes here when decision: approved with a rewrite>
 *
 * Read order from the parser's POV: the frontmatter is the source of truth
 * for structured fields, the body sections are display + (only "Corrected
 * answer") authoring surface. We round-trip Corrected answer back through
 * the file so successive export/import cycles don't lose author edits.
 */

import {
  emitFrontmatter,
  parseFrontmatter,
  FrontmatterParseError,
  type FrontmatterValue,
} from './frontmatter.ts';
import type {
  InboxBody,
  InboxDecision,
  InboxFile,
  InboxFrontmatter,
  ReviewableRetrievedChunk,
} from './types.ts';

const FENCE = '---';
const H2_SYSTEM = '## System answer';
const H2_RETRIEVED = '## Retrieved chunks';
const H2_CORRECTED = '## Corrected answer';

export class InboxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxParseError';
  }
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

export function emitInbox(file: InboxFile): string {
  const fm = frontmatterToRecord(file.frontmatter);
  const body = emitBody(file.body);
  return `${FENCE}\n${emitFrontmatter(fm)}\n${FENCE}\n\n${body}`;
}

function frontmatterToRecord(fm: InboxFrontmatter): Record<string, FrontmatterValue> {
  return {
    cluster_id: fm.cluster_id,
    created_at_iso: fm.created_at_iso,
    queries: fm.queries,
    sample_answer_id: fm.sample_answer_id,
    current_page_id: fm.current_page_id,
    signal_source: fm.signal_source,
    explicit_negative: fm.explicit_negative,
    implicit_negative: fm.implicit_negative,
    bad_citation_ids: fm.bad_citation_ids,
    decision: fm.decision,
    notes: fm.notes,
  };
}

function emitBody(body: InboxBody): string {
  const chunks =
    body.retrievedChunks.length === 0
      ? '_(no retrieved chunks captured)_'
      : body.retrievedChunks
          .map((c) => {
            const head = c.breadcrumb ?? `chunk_id ${c.chunk_id}`;
            const snippet = c.snippet ?? '';
            return snippet.length > 0 ? `- **${head}**\n\n  ${snippet}` : `- **${head}**`;
          })
          .join('\n\n');

  return [
    `${H2_SYSTEM}`,
    '',
    body.systemAnswer.length > 0 ? body.systemAnswer : '_(empty answer)_',
    '',
    `${H2_RETRIEVED}`,
    '',
    chunks,
    '',
    `${H2_CORRECTED}`,
    '',
    body.correctedAnswer,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseInbox(content: string): InboxFile {
  const { frontmatterRaw, body } = splitFences(content);
  let fmRecord: Record<string, FrontmatterValue>;
  try {
    fmRecord = parseFrontmatter(frontmatterRaw);
  } catch (err) {
    if (err instanceof FrontmatterParseError) {
      throw new InboxParseError(err.message);
    }
    throw err;
  }
  const frontmatter = recordToFrontmatter(fmRecord);
  const sections = splitBodySections(body);
  return {
    frontmatter,
    body: {
      systemAnswer: sections.systemAnswer,
      // Retrieved chunks: we don't try to reconstruct the structured form
      // from the rendered markdown (lossy, and we don't need it for import).
      // The retrievedChunks list comes back empty on parse — only the
      // free-form `correctedAnswer` round-trips end-to-end.
      retrievedChunks: [] as ReviewableRetrievedChunk[],
      correctedAnswer: sections.correctedAnswer,
    },
  };
}

function splitFences(content: string): { frontmatterRaw: string; body: string } {
  const trimmed = content.replace(/^﻿/, '');
  if (!trimmed.startsWith(`${FENCE}\n`) && !trimmed.startsWith(`${FENCE}\r\n`)) {
    throw new InboxParseError(`expected leading '${FENCE}' fence`);
  }
  const afterFirst = trimmed.slice(FENCE.length).replace(/^\r?\n/, '');
  const closeIdx = afterFirst.search(/\r?\n---\s*(?:\r?\n|$)/);
  if (closeIdx === -1) {
    throw new InboxParseError(`unterminated frontmatter (no closing '${FENCE}')`);
  }
  const frontmatterRaw = afterFirst.slice(0, closeIdx);
  // Skip the newline + closing fence + trailing newline (if any).
  const rest = afterFirst.slice(closeIdx).replace(/^\r?\n---\s*\r?\n?/, '');
  return { frontmatterRaw, body: rest };
}

function splitBodySections(body: string): { systemAnswer: string; correctedAnswer: string } {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let currentTitle: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (currentTitle !== null) {
      sections.set(currentTitle, buf.join('\n').trim());
    }
    buf = [];
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      currentTitle = line.slice(3).trim();
    } else if (currentTitle !== null) {
      buf.push(line);
    }
  }
  flush();
  return {
    systemAnswer: sections.get(H2_SYSTEM.slice(3)) ?? '',
    correctedAnswer: sections.get(H2_CORRECTED.slice(3)) ?? '',
  };
}

function recordToFrontmatter(r: Record<string, FrontmatterValue>): InboxFrontmatter {
  return {
    cluster_id: requireString(r, 'cluster_id'),
    created_at_iso: requireString(r, 'created_at_iso'),
    queries: requireStringArray(r, 'queries'),
    sample_answer_id: requireString(r, 'sample_answer_id'),
    current_page_id: optionalString(r, 'current_page_id'),
    signal_source: requireSignalSource(r),
    explicit_negative: requireNumber(r, 'explicit_negative'),
    implicit_negative: requireNumber(r, 'implicit_negative'),
    bad_citation_ids: requireStringArray(r, 'bad_citation_ids'),
    decision: requireDecision(r),
    notes: optionalString(r, 'notes') ?? '',
  };
}

function requireString(r: Record<string, FrontmatterValue>, key: string): string {
  const v = r[key];
  if (typeof v !== 'string') {
    throw new InboxParseError(`frontmatter: ${key} must be a string (got ${formatType(v)})`);
  }
  return v;
}

function optionalString(r: Record<string, FrontmatterValue>, key: string): string | null {
  const v = r[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    throw new InboxParseError(`frontmatter: ${key} must be a string or null (got ${formatType(v)})`);
  }
  return v;
}

function requireNumber(r: Record<string, FrontmatterValue>, key: string): number {
  const v = r[key];
  if (typeof v !== 'number') {
    throw new InboxParseError(`frontmatter: ${key} must be a number (got ${formatType(v)})`);
  }
  return v;
}

function requireStringArray(r: Record<string, FrontmatterValue>, key: string): string[] {
  const v = r[key];
  if (!Array.isArray(v)) {
    throw new InboxParseError(`frontmatter: ${key} must be an array (got ${formatType(v)})`);
  }
  return v.map((x, i) => {
    if (typeof x !== 'string') {
      throw new InboxParseError(`frontmatter: ${key}[${i}] must be a string (got ${formatType(x)})`);
    }
    return x;
  });
}

function requireDecision(r: Record<string, FrontmatterValue>): InboxDecision {
  const v = r['decision'];
  if (v !== 'pending' && v !== 'approved' && v !== 'rejected') {
    throw new InboxParseError(
      `frontmatter: decision must be 'pending' | 'approved' | 'rejected' (got ${JSON.stringify(v)})`,
    );
  }
  return v;
}

function requireSignalSource(r: Record<string, FrontmatterValue>): InboxFrontmatter['signal_source'] {
  const v = r['signal_source'];
  if (v !== 'explicit' && v !== 'implicit' && v !== 'curated') {
    throw new InboxParseError(
      `frontmatter: signal_source must be 'explicit' | 'implicit' | 'curated' (got ${JSON.stringify(v)})`,
    );
  }
  return v;
}

function formatType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
