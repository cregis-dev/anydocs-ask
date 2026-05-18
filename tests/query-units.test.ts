/**
 * Unit tests for the pure-function modules of the query pipeline:
 * lang detection, FTS5 sanitization, rerank, aggregate, postprocess.
 *
 * Each module is exercised standalone — no DB and no LLM — so the e2e
 * suite (tests/ask.test.ts) can stay focused on PRD §8 acceptance #11/#12/#13.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLangFromText, langFromScopeId } from '../src/query/lang.ts';
import { sanitizeFtsQuery } from '../src/query/sanitize.ts';
import { rerank } from '../src/query/rerank.ts';
import { aggregate } from '../src/query/aggregate.ts';
import { postprocess } from '../src/query/postprocess.ts';
import { detectFormatHint } from '../src/query/prompt.ts';
import type { RerankedChunk } from '../src/query/rerank.ts';
import type { RetrievedChunk } from '../src/query/retrieval.ts';

// ---------------------------------------------------------------------------
// lang.ts
// ---------------------------------------------------------------------------

test('detectLangFromText: pure CJK -> zh', () => {
  assert.equal(detectLangFromText('如何鉴权？'), 'zh');
});

test('detectLangFromText: pure ASCII -> en', () => {
  assert.equal(detectLangFromText('how do I authenticate?'), 'en');
});

test('detectLangFromText: mixed but ≥30% CJK -> zh', () => {
  // Token "API 鉴权方法" — 1/8 chars are ASCII; well over 30% CJK.
  assert.equal(detectLangFromText('API 鉴权方法 setUp'), 'zh');
});

test('detectLangFromText: mostly English with a couple of zh chars stays en', () => {
  // 2/30 chars are CJK ≈ 6.7%, below 30% threshold.
  assert.equal(detectLangFromText('how do I configure the 设置 endpoint properly'), 'en');
});

test('detectLangFromText: empty string -> en (benign default)', () => {
  assert.equal(detectLangFromText(''), 'en');
  assert.equal(detectLangFromText('   '), 'en');
});

test('langFromScopeId: nav:zh.json:... -> zh', () => {
  assert.equal(langFromScopeId('nav:zh.json:0'), 'zh');
});

test('langFromScopeId: nav:en.json:... -> en', () => {
  assert.equal(langFromScopeId('nav:en.json:1.2'), 'en');
});

test('langFromScopeId: page-id form returns null', () => {
  assert.equal(langFromScopeId('p_frontend_auth'), null);
});

test('langFromScopeId: unsupported lang prefix returns null', () => {
  assert.equal(langFromScopeId('nav:fr.json:0'), null);
});

// ---------------------------------------------------------------------------
// sanitize.ts
// ---------------------------------------------------------------------------

test('sanitizeFtsQuery: plain words wrapped as quoted tokens joined by OR', () => {
  assert.equal(sanitizeFtsQuery('how do I login'), '"how" OR "do" OR "I" OR "login"');
});

test('sanitizeFtsQuery: strips MATCH operators', () => {
  // ", *, -, +, :, (, ), ^ are reserved; they get dropped before tokenization.
  assert.equal(sanitizeFtsQuery('foo*  +bar  -baz "qux"'), '"foo" OR "bar" OR "baz" OR "qux"');
});

test('sanitizeFtsQuery: drops AND/OR/NOT keywords (case-insensitive)', () => {
  assert.equal(sanitizeFtsQuery('foo AND bar or NOT baz'), '"foo" OR "bar" OR "baz"');
});

test('sanitizeFtsQuery: chinese punctuation acts as token boundary', () => {
  assert.equal(sanitizeFtsQuery('鉴权？怎么做'), '"鉴权" OR "怎么做"');
});

test('sanitizeFtsQuery: returns null when nothing useful survives', () => {
  assert.equal(sanitizeFtsQuery('   '), null);
  assert.equal(sanitizeFtsQuery('?!'), null);
  assert.equal(sanitizeFtsQuery('AND OR'), null);
});

// ---------------------------------------------------------------------------
// prompt.detectFormatHint
// ---------------------------------------------------------------------------

test('detectFormatHint: zh comparison -> table', () => {
  assert.equal(detectFormatHint('A 和 B 的对比'), 'table');
  assert.equal(detectFormatHint('A vs B'), 'table');
});

test('detectFormatHint: zh how-to -> list', () => {
  assert.equal(detectFormatHint('如何鉴权？'), 'list');
  assert.equal(detectFormatHint('how do I do X'), 'list');
});

test('detectFormatHint: en concept -> concept', () => {
  assert.equal(detectFormatHint('what is JWT?'), 'concept');
  assert.equal(detectFormatHint('什么是 JWT'), 'concept');
});

test('detectFormatHint: default paragraph', () => {
  assert.equal(detectFormatHint('JWT 鉴权的常见错误码'), 'paragraph');
});

// ---------------------------------------------------------------------------
// rerank.ts
// ---------------------------------------------------------------------------

function fakeRetrieved(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    page_id: 'p',
    lang: 'zh',
    in_page_path: 'h2/p[1]',
    text: 'body',
    is_code: 0,
    page_title: 'P',
    page_url: '/p',
    subtree_root: 'sub',
    nav_index: 0,
    breadcrumb: [{ id: 'sub', title: 'Sub', type: 'section' }],
    rrf_score: 0.1,
    ...over,
  };
}

test('rerank: lang_boost +0.30 applied when chunk.lang == query_lang', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, lang: 'zh', rrf_score: 0.1, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, lang: 'en', rrf_score: 0.1, nav_index: 1000 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: null },
  );
  // Find both by id; zh should score higher than en.
  const zh = out.find((c) => c.chunk_id === 1)!;
  const en = out.find((c) => c.chunk_id === 2)!;
  assert.ok(zh.final_score > en.final_score, 'zh chunk must beat en chunk under same RRF');
  assert.ok(zh.final_score >= 0.1 * (1 + 0.3), 'lang boost adds at least +0.30 multiplicatively');
});

test('rerank: same_subtree_boost +0.20 when current subtree matches', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, subtree_root: 'A', nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, subtree_root: 'B', nav_index: 1000 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: 'A' },
  );
  const a = out.find((c) => c.chunk_id === 1)!;
  const b = out.find((c) => c.chunk_id === 2)!;
  assert.ok(a.final_score > b.final_score);
});

test('rerank: nav_index_boost decays with depth', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, nav_index: 0 }),
      fakeRetrieved({ chunk_id: 2, nav_index: 100 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: null },
  );
  const shallow = out.find((c) => c.chunk_id === 1)!;
  const deep = out.find((c) => c.chunk_id === 2)!;
  assert.ok(shallow.final_score > deep.final_score, 'lower nav_index ranks higher');
});

test('rerank: title_match_boost +0.30 when query contains page_title (word-aligned)', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'home-assistant', page_title: 'Home Assistant', rrf_score: 0.04, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'mattermost', page_title: 'Mattermost', rrf_score: 0.045, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'How do I integrate Home Assistant?' },
  );
  const ha = out.find((c) => c.chunk_id === 1)!;
  const mm = out.find((c) => c.chunk_id === 2)!;
  // ha: 0.04 × (1+0.3 lang+0.3 title+~0 nav) = 0.064
  // mm: 0.045 × (1+0.3 lang) = 0.0585  → ha wins
  assert.ok(ha.final_score > mm.final_score, 'title-matched chunk wins despite lower rrf');
});

test('rerank: title_match_boost suppressed when longer matched title contains shorter', () => {
  // Both "Installation" and "Installation on Termux" appear in query;
  // only the longer-titled page should keep the boost.
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'install', page_title: 'Installation', rrf_score: 0.10, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'install-termux', page_title: 'Installation on Termux', rrf_score: 0.10, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'tell me about Installation on Termux please' },
  );
  const generic = out.find((c) => c.chunk_id === 1)!;
  const specific = out.find((c) => c.chunk_id === 2)!;
  assert.ok(specific.final_score > generic.final_score, 'specific (longer) title wins, generic suppressed');
});

test('rerank: title_match_boost skipped for titles below min length', () => {
  // Title "TTS" (3 chars) is below TITLE_MATCH_MIN_LEN; no boost even on exact match.
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'tts', page_title: 'TTS', rrf_score: 0.05, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'voice', page_title: 'Voice', rrf_score: 0.05, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'how does TTS work' },
  );
  const tts = out.find((c) => c.chunk_id === 1)!;
  const voice = out.find((c) => c.chunk_id === 2)!;
  // No title-match boost on either; final_scores tie or differ only on lang_boost.
  assert.equal(tts.final_score, voice.final_score, 'short titles get no title boost');
});

test('rerank: sorted descending by final_score', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, rrf_score: 0.05 }),
      fakeRetrieved({ chunk_id: 2, rrf_score: 0.20 }),
      fakeRetrieved({ chunk_id: 3, rrf_score: 0.10 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: null, query: '' },
  );
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1]!.final_score >= out[i]!.final_score);
  }
});

// ---------------------------------------------------------------------------
// aggregate.ts
// ---------------------------------------------------------------------------

function fakeReranked(over: Partial<RerankedChunk> = {}): RerankedChunk {
  return { ...fakeRetrieved(), final_score: 0.1, ...over };
}

test('aggregate: empty input -> translate-fallback (no signal)', () => {
  const out = aggregate([], { queryLang: 'zh' });
  assert.equal(out.kind, 'translate-fallback');
});

test('aggregate: same-lang dominant subtree (≥0.55 share) -> answer-same-lang', () => {
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 2, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 3, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 4, lang: 'zh', subtree_root: 'B', rrf_score: 0.1, final_score: 0.5 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'answer-same-lang');
  if (out.kind === 'answer-same-lang') {
    assert.equal(out.dominantSubtree, 'A');
    // pick = sameLang (all same-lang chunks from top-K, across all subtrees).
    assert.equal(out.pick.length, 4);
  }
});

test('aggregate: same-lang split with Δ<0.25 -> clarify', () => {
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 2, lang: 'zh', subtree_root: 'B', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 3, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 0.5 }),
      fakeReranked({ chunk_id: 4, lang: 'zh', subtree_root: 'B', rrf_score: 0.1, final_score: 0.5 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'clarify');
  if (out.kind === 'clarify') {
    assert.equal(out.topSubtrees.length, 2);
  }
});

test('aggregate: same-lang max RRF below floor -> translate-fallback', () => {
  // sameLang non-empty, but maxRrf 0.005 < SAME_LANG_FLOOR_RRF (0.01).
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'zh', rrf_score: 0.005 }),
      fakeReranked({ chunk_id: 2, lang: 'en', rrf_score: 0.5 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'translate-fallback');
});

test('aggregate: only en chunks for a zh query -> translate-fallback (PRD §8 #11)', () => {
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'en', rrf_score: 0.2 }),
      fakeReranked({ chunk_id: 2, lang: 'en', rrf_score: 0.15 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'translate-fallback');
});

// ---------------------------------------------------------------------------
// postprocess.ts
// ---------------------------------------------------------------------------

test('postprocess: legal citation markers survive; illegal ones stripped', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'JWT auth detail', page_title: 'Auth', breadcrumb: [{ id: 'p', title: 'Auth', type: 'page' }] })],
  ]);
  const out = postprocess({
    answerLang: 'zh',
    rawAnswer: '使用 JWT 鉴权 [cit_1] 而不是 [cit_99].',
    chunkById,
  });
  assert.match(out.answer_md, /\[cit_1\]/);
  assert.doesNotMatch(out.answer_md, /\[cit_99\]/);
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0]!.citation_id, 'cit_1');
  assert.equal(out.used_chunks, 1);
});

test('postprocess: source_lang filled only when chunk.lang != answer_lang', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ lang: 'zh' })],
    ['cit_2', fakeReranked({ chunk_id: 2, lang: 'en' })],
  ]);
  const out = postprocess({
    answerLang: 'zh',
    rawAnswer: 'A [cit_1] B [cit_2]',
    chunkById,
  });
  const c1 = out.citations.find((c) => c.citation_id === 'cit_1')!;
  const c2 = out.citations.find((c) => c.citation_id === 'cit_2')!;
  assert.equal(c1.source_lang, null);
  assert.equal(c2.source_lang, 'en');
});

test('postprocess: hallucinated inline-code identifier marked with ⚠', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'real identifier: getUser' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Use `getUser` and `madeUpFn` [cit_1]',
    chunkById,
  });
  assert.match(out.answer_md, /`getUser`/);            // present in context — kept clean
  assert.match(out.answer_md, /`madeUpFn⚠`/);          // not in context — flagged
});

// Regression for codex eval round-2 false-positives. The hallucination filter
// used to ⚠ legitimate technical identifiers (file paths, JSON file names,
// deeply-dotted config keys) when the chunk mentioned them with different
// separators or in surrounding prose. The softened-match exemption now
// recognises them as legitimate.
test('postprocess: file paths / JSON file names not ⚠ when chunk references them with prose separators', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      // Chunk talks about the same identifiers but with different separators
      // / surrounding prose — exactly the case where the old filter misfired.
      fakeReranked({
        text:
          'The openapi index lives at openapi index.json. Manifest is in imports manifest.json. ' +
          'The branding is configured via site theme branding key. Tools register in mcp pages.json. ' +
          'Search uses the search index.json file in the build output.',
      }),
    ],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'See `openapi/index.json`, `imports/manifest.json`, `site.theme.branding`, ' +
      '`mcp/pages.json`, and `search-index.json` [cit_1]',
    chunkById,
  });
  // None of these should carry the ⚠ marker — they're shaped like paths or
  // deeply-dotted config keys and the softened haystack contains them.
  assert.doesNotMatch(out.answer_md, /⚠/, `unexpected ⚠ in: ${out.answer_md}`);
});

// Counterpart guard: dotted config-key shapes that don't appear in either
// chunks or question (even after softening) must still get ⚠'d. Without this,
// the exemption would defeat the filter entirely for config keys.
//
// Note on scope of the guard: tokens that look like file names with a known
// extension (e.g. `totally/made-up/config.json`) are EXEMPT by design — see
// `isClearlyTechnicalIdentifier`. The eval round-3 feedback showed that
// requiring haystack proof for every file name produced too many false
// positives on legitimate identifiers; we accept letting an occasional
// fabricated file name through as the tradeoff. The check that remains
// teeth-bearing is on dotted keys without an extension.
test('postprocess: dotted config-key absent from haystack still ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated content about authentication' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Set `fake.nested.key` to true [cit_1]',
    chunkById,
  });
  assert.match(out.answer_md, /`fake\.nested\.key⚠`/);
});

// Regression from local dogfood (codex round-3 follow-up): when the user
// asks "what's in `imports/manifest.json`?" and the docs DON'T mention that
// file, the LLM commonly replies "the context does not describe
// `imports/manifest.json`". The identifier is technically absent from any
// chunk, but it came verbatim from the user's question — flagging it as a
// hallucination misleads the user into thinking the answer itself is broken.
// Solution: the question is a trusted source alongside chunk text.
test('postprocess: identifier repeated from the user question is not ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'docs about anydocs.config.json and other unrelated topics' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    question: 'What is in imports/manifest.json? Is it required for the build?',
    rawAnswer:
      'The provided context does not describe `imports/manifest.json` at all [cit_1].',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Counter-test for the question-as-trusted-source rule: an identifier that
// appears NEITHER in chunks NOR in the question, AND is shaped as a generic
// code identifier (not a file extension / URL / loopback), must still be ⚠'d.
test('postprocess: generic identifier absent from both chunks and question still ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated content' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    question: 'How do I configure the system?',
    rawAnswer: 'You can call `definitelyHallucinatedFunction` to do it [cit_1].',
    chunkById,
  });
  assert.match(out.answer_md, /`definitelyHallucinatedFunction⚠`/);
});

// Regression for codex round-3 follow-up: `anydocs.config.json` and similar
// file-extensioned identifiers are now direct-allow (no haystack required).
// Previously chunks had to reference the literal filename verbatim, which
// failed often enough that legitimate config-file mentions polluted answers.
test('postprocess: filename-with-extension is exempt from ⚠ regardless of haystack', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'this chunk does not mention the file' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'See `anydocs.config.json`, `package.json`, `Dockerfile`, and `.env` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// 2-segment dotted config keys (`build.outputDir`, `site.theme.id`) — previous
// rule required ≥3 segments, leaving these polluted. Now allowed as long as
// the softened form shows up somewhere in the haystack.
test('postprocess: 2-segment dotted config key passes when softened-match hits', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      fakeReranked({
        text: 'the build output directory is set via build outputDir in the config',
      }),
    ],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Configure `build.outputDir` to change the destination [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// New whitelist class: URLs / loopback endpoints are direct-allow regardless
// of haystack. Codex eval round-3 explicitly called out the need so that
// `localhost:3100`, `https://example.com`, etc. are never ⚠'d.
test('postprocess: URLs and loopback endpoints are exempt from ⚠', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'configuration documentation' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Run on `localhost:3100` and `127.0.0.1:8080`; the docs live at `https://example.com/docs` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

test('postprocess: citation URL appends heading anchor when in_page_path encodes one', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      fakeReranked({
        in_page_path: 'bearer-token/p[1]',
        page_url: '/frontend/auth',
      }),
    ],
  ]);
  const out = postprocess({ answerLang: 'zh', rawAnswer: '... [cit_1]', chunkById });
  assert.equal(out.citations[0]!.url, '/frontend/auth#bearer-token');
});

test('postprocess: cit_N markers renumbered to 1..K matching citations[] order', () => {
  // Prompt put 5 chunks in chunkById; LLM cited cit_4, cit_5, cit_4 (out of order
  // and with a duplicate). Output must have cit_1, cit_2 and citations[0/1].
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ chunk_id: 11 })],
    ['cit_2', fakeReranked({ chunk_id: 22 })],
    ['cit_3', fakeReranked({ chunk_id: 33 })],
    ['cit_4', fakeReranked({ chunk_id: 44 })],
    ['cit_5', fakeReranked({ chunk_id: 55 })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'See [cit_4] and [cit_5] but not [cit_4] again.',
    chunkById,
  });
  assert.match(out.answer_md, /\[cit_1\]/);
  assert.match(out.answer_md, /\[cit_2\]/);
  assert.doesNotMatch(out.answer_md, /\[cit_4\]/);
  assert.doesNotMatch(out.answer_md, /\[cit_5\]/);
  assert.equal(out.citations.length, 2);
  assert.equal(out.citations[0]!.citation_id, 'cit_1');
  assert.equal(out.citations[0]!.chunk_id, 44);
  assert.equal(out.citations[1]!.citation_id, 'cit_2');
  assert.equal(out.citations[1]!.chunk_id, 55);
});

test('postprocess: chunk_id propagates from RerankedChunk into Citation', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ chunk_id: 7 })],
  ]);
  const out = postprocess({ answerLang: 'zh', rawAnswer: 'X [cit_1]', chunkById });
  assert.equal(out.citations[0]!.chunk_id, 7);
});

test('postprocess: truncation appends locale-specific notice', () => {
  const long = 'X'.repeat(5000);
  const out = postprocess({
    answerLang: 'zh',
    rawAnswer: `${long} [cit_1]`,
    chunkById: new Map([['cit_1', fakeReranked()]]),
  });
  assert.ok(out.answer_md.length <= 4000);
  assert.match(out.answer_md, /答案过长已截断/);
});
