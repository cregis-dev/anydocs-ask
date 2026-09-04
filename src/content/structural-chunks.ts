import { lexer, type Token, type Tokens } from 'marked';

import { createHeadingIdGenerator } from './heading-ids.ts';
import { splitChunkText, stripMarkdown } from './sections.ts';

export type StructuralChunkPiece = {
  headingId: string;
  headingPath: string[];
  text: string;
  isCode: boolean;
};

type TextAtom = {
  text: string;
  isCode: boolean;
  splittable: boolean;
};

/**
 * Build deterministic, structure-aware chunks from rendered Markdown.
 * Markdown is the common input for authored pages and generated OpenAPI pages.
 */
export function chunkMarkdownStructure(
  markdown: string,
  pageTitle: string,
  maxChars: number,
): StructuralChunkPiece[] {
  const tokens = lexer(markdown, { gfm: true });
  const nextHeadingId = createHeadingIdGenerator();
  const headingStack: Array<{ depth: number; title: string }> = [];
  const pieces: StructuralChunkPiece[] = [];
  let headingId = '';
  let pending: TextAtom[] = [];
  let sawContent = false;

  const headingPath = () => headingStack.map((entry) => entry.title);
  const prefix = () => contextPrefix(pageTitle, headingPath());

  const emit = (text: string, isCode = false): void => {
    const value = text.trim();
    if (!value) return;
    pieces.push({
      headingId,
      headingPath: headingPath(),
      text: value,
      isCode,
    });
  };

  const flushPending = (): void => {
    if (pending.length === 0) return;
    const currentPrefix = prefix();
    let packed: TextAtom[] = [];

    const flushPacked = () => {
      if (packed.length === 0) return;
      emit(
        `${currentPrefix}\n${packed.map((atom) => atom.text).join('\n\n')}`,
        packed.some((atom) => atom.isCode),
      );
      packed = [];
    };

    for (const atom of pending) {
      const candidate = `${currentPrefix}\n${[...packed, atom]
        .map((entry) => entry.text)
        .join('\n\n')}`;
      if (candidate.length <= maxChars || packed.length === 0 && !atom.splittable) {
        packed.push(atom);
        continue;
      }

      flushPacked();
      const available = Math.max(200, maxChars - currentPrefix.length - 1);
      if (atom.splittable && atom.text.length > available) {
        for (const part of splitChunkText(atom.text, available, 0)) {
          emit(`${currentPrefix}\n${part}`, atom.isCode);
        }
      } else {
        packed.push(atom);
      }
    }
    flushPacked();
    pending = [];
  };

  for (const token of tokens as Token[]) {
    if (token.type === 'space' || token.type === 'hr' || token.type === 'def') continue;

    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      const title = stripMarkdown(heading.text);
      if (!sawContent && heading.depth === 1 && title === pageTitle.trim()) {
        sawContent = true;
        continue;
      }
      flushPending();
      while (
        headingStack.length > 0
        && headingStack[headingStack.length - 1]!.depth >= heading.depth
      ) {
        headingStack.pop();
      }
      headingStack.push({ depth: heading.depth, title });
      headingId = nextHeadingId(title);
      sawContent = true;
      continue;
    }

    sawContent = true;
    if (token.type === 'table') {
      flushPending();
      for (const tablePiece of chunkTable(token as Tokens.Table, prefix(), maxChars)) {
        emit(tablePiece);
      }
      continue;
    }

    if (token.type === 'code') {
      const code = token as Tokens.Code;
      const label = code.lang?.trim() ? `Code (${code.lang.trim()}):` : 'Code:';
      const atom = { text: `${label}\n${code.text.trim()}`, isCode: true, splittable: false };
      const candidate = `${prefix()}\n${[...pending, atom].map((entry) => entry.text).join('\n\n')}`;
      if (pending.length > 0 && candidate.length > maxChars) flushPending();
      pending.push(atom);
      flushPending();
      continue;
    }

    if (token.type === 'list') {
      const list = token as Tokens.List;
      for (const item of list.items) {
        const text = stripMarkdown(item.text);
        if (text) pending.push({ text: `- ${text}`, isCode: false, splittable: false });
      }
      continue;
    }

    const text = textForToken(token);
    if (text) pending.push({ text, isCode: false, splittable: true });
  }

  flushPending();
  return pieces;
}

function chunkTable(token: Tokens.Table, prefix: string, maxChars: number): string[] {
  const headers = token.header.map((cell, index) => cleanCell(cell.text) || `column_${index + 1}`);
  const columnsLine = `Columns: ${headers.join(' | ')}`;
  const base = `${prefix}\n${columnsLine}`;
  if (token.rows.length === 0) return [base];

  const groups: Array<{ key: string; rows: string[] }> = [];
  for (const row of token.rows) {
    const values = row.map((cell) => cleanCell(cell.text));
    const key = values[0] ?? '';
    const rendered = values
      .map((value, index) => `${headers[index] ?? `column_${index + 1}`}: ${value}`)
      .join(' | ');
    const previous = groups[groups.length - 1];
    if (previous && previous.key === key) previous.rows.push(`- ${rendered}`);
    else groups.push({ key, rows: [`- ${rendered}`] });
  }

  const out: string[] = [];
  let packedRows: string[] = [];
  const flushPackedRows = () => {
    if (packedRows.length === 0) return;
    out.push(`${base}\n${packedRows.join('\n')}`);
    packedRows = [];
  };

  for (const group of groups) {
    const withGroup = `${base}\n${[...packedRows, ...group.rows].join('\n')}`;
    if (withGroup.length <= maxChars) {
      packedRows.push(...group.rows);
      continue;
    }

    flushPackedRows();
    const groupText = `${base}\n${group.rows.join('\n')}`;
    if (groupText.length <= maxChars) {
      packedRows.push(...group.rows);
      continue;
    }

    // A repeated first-column entity can span several rows. Keep it whole
    // whenever possible; if the group itself is oversized, split only at a
    // row boundary and repeat the table context on every continuation.
    for (const row of group.rows) {
      const candidate = `${base}\n${[...packedRows, row].join('\n')}`;
      if (packedRows.length > 0 && candidate.length > maxChars) {
        flushPackedRows();
      }
      packedRows.push(row);
    }
    flushPackedRows();
  }
  flushPackedRows();
  return out;
}

function contextPrefix(pageTitle: string, headingPath: string[]): string {
  const lines = [`Page: ${pageTitle.trim()}`];
  if (headingPath.length > 0) lines.push(`Section: ${headingPath.join(' > ')}`);
  return lines.join('\n');
}

function textForToken(token: Token): string {
  if (
    token.type === 'paragraph'
    || token.type === 'blockquote'
    || token.type === 'text'
    || token.type === 'html'
  ) {
    return stripMarkdown(token.raw);
  }
  return '';
}

function cleanCell(value: string): string {
  return stripMarkdown(value).replace(/\s+/g, ' ').trim();
}
