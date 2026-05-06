import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMarkdownSections,
  splitChunkText,
  stripMarkdown,
} from '../src/content/sections.ts';

test('stripMarkdown preserves fenced code body (the divergence)', () => {
  const md = 'before\n```ts\nconst x = 1;\n```\nafter';
  // anydocs upstream replaces ```...``` with ' '; we keep the body so RAG
  // retrieval can hit the code identifier.
  assert.match(stripMarkdown(md), /const x = 1;/);
});

test('stripMarkdown preserves inline code identifier', () => {
  assert.match(stripMarkdown('Use the `getUserById` API'), /getUserById/);
});

test('stripMarkdown drops link URLs but keeps link text', () => {
  assert.equal(
    stripMarkdown('See [auth docs](https://example.com/auth) for more'),
    'See auth docs for more',
  );
});

test('extractMarkdownSections strips the leading H1 page title', () => {
  const md = '# Welcome\n\n## First section\n\nbody text';
  const sections = extractMarkdownSections(md, 'Welcome');
  assert.equal(sections.length, 1, 'only the H2 section should remain');
  assert.deepEqual(sections[0]!.headingPath, ['First section']);
  assert.equal(sections[0]!.headingId, 'first-section');
  assert.match(sections[0]!.text, /body text/);
});

test('extractMarkdownSections nests heading paths', () => {
  const md = `## Frontend

prose

### Auth

token info

### Session

session info

## Backend

backend prose`;
  const sections = extractMarkdownSections(md, 'Doc');
  assert.equal(sections.length, 4);
  assert.deepEqual(sections.map((s) => s.headingPath), [
    ['Frontend'],
    ['Frontend', 'Auth'],
    ['Frontend', 'Session'],
    ['Backend'],
  ]);
});

test('extractMarkdownSections preserves code blocks inside section text', () => {
  const md = `## Snippets

\`\`\`ts
const client = new SDK();
\`\`\``;
  const sections = extractMarkdownSections(md, 'Doc');
  assert.equal(sections.length, 1);
  assert.match(sections[0]!.text, /const client = new SDK\(\)/);
});

test('extractMarkdownSections produces stable, unique heading IDs for duplicates', () => {
  const md = '## Setup\n\na\n\n## Setup\n\nb';
  const sections = extractMarkdownSections(md, 'Doc');
  assert.equal(sections.length, 2);
  assert.equal(sections[0]!.headingId, 'setup');
  assert.equal(sections[1]!.headingId, 'setup-2');
});

test('splitChunkText returns a single chunk for short text', () => {
  const out = splitChunkText('a short string', 100, 10);
  assert.deepEqual(out, ['a short string']);
});

test('splitChunkText splits long text with overlap', () => {
  const text = 'word '.repeat(500); // 2500 chars
  const out = splitChunkText(text, 1000, 100);
  assert.ok(out.length >= 3, `expected at least 3 chunks, got ${out.length}`);
  for (const c of out) assert.ok(c.length <= 1000);
});

test('splitChunkText prefers a whitespace boundary over a hard cut', () => {
  const head = 'A'.repeat(700);
  const tail = ' some trailing text that should not split mid-word';
  const out = splitChunkText(head + tail, 800, 50);
  assert.ok(out.length >= 1);
  // First chunk should end on a whitespace cut, not mid-A-run.
  assert.ok(!out[0]!.endsWith('A'), `first chunk ends with: ${JSON.stringify(out[0]!.slice(-10))}`);
});

test('splitChunkText returns empty for blank input', () => {
  assert.deepEqual(splitChunkText('   \n\n   '), []);
});
