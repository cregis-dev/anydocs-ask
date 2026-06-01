/**
 * RFC 0006 A5 alpha.2 — generateSuggestion unit tests with MockLLM.
 * Asserts prompt shape + frontmatter contents + failure-mode silence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLM } from '../src/llm/mock.ts';
import {
  generateSuggestion,
  type GenerateSuggestionInput,
} from '../src/feedback/diagnose-suggest.ts';
import type { FeedbackCluster } from '../src/feedback/diagnose-cluster.ts';

function mkCluster(overrides: Partial<FeedbackCluster> = {}): FeedbackCluster {
  return {
    cluster_id: 'c_test01',
    members: [1, 2, 3],
    member_questions: ['hermes 配置 model', 'hermes model 怎么设', 'model provider 怎么选'],
    center_question: 'hermes 配置 model',
    center_feedback_id: 1,
    size: 3,
    density: 0.78,
    ...overrides,
  };
}

test('generateSuggestion: happy path returns markdown + frontmatter + model + latency', async () => {
  const llm = new MockLLM({
    model: 'mock-diag',
    responder: () =>
      [
        '# 建议：在 Quickstart 下新增 "模型配置" 章节',
        '## 当前用户的痛点',
        '- hermes 配置 model',
        '## 建议覆盖的事实点',
        '- 如何运行 `hermes model`',
        '## 建议挂载位置',
        'Quickstart > Setup',
      ].join('\n'),
  });
  const cluster = mkCluster();
  const out = await generateSuggestion({
    llm,
    cluster,
    now: () => new Date('2026-05-24T12:00:00Z'),
  });
  assert.ok(out);
  assert.match(out!.markdown, /^---\n/);
  assert.match(out!.markdown, /cluster_id: c_test01/);
  assert.match(out!.markdown, /center_question: "hermes 配置 model"/);
  assert.match(out!.markdown, /member_count: 3/);
  assert.match(out!.markdown, /density: 0\.7800/);
  assert.match(out!.markdown, /model: mock-diag/);
  assert.match(out!.markdown, /generated_at: 2026-05-24T12:00:00\.000Z/);
  assert.match(out!.markdown, /shadow: false/);
  assert.match(out!.markdown, /---\n# 建议：在 Quickstart/);
  assert.equal(out!.model, 'mock-diag');
  assert.ok(out!.latencyMs >= 0);
});

test('generateSuggestion: shadow=true marks frontmatter accordingly', async () => {
  const llm = new MockLLM({ model: 'm', responder: () => '# Body' });
  const out = await generateSuggestion({
    llm,
    cluster: mkCluster(),
    shadow: true,
    now: () => new Date('2026-05-24T12:00:00Z'),
  });
  assert.ok(out);
  assert.match(out!.markdown, /shadow: true/);
});

test('generateSuggestion: LLM throws → returns null (silent per RFC §4.8)', async () => {
  const llm = new MockLLM({
    responder: () => {
      throw new Error('upstream 503');
    },
  });
  const out = await generateSuggestion({ llm, cluster: mkCluster() });
  assert.equal(out, null);
});

test('generateSuggestion: empty body → returns null', async () => {
  const llm = new MockLLM({ responder: () => '   \n\n' });
  const out = await generateSuggestion({ llm, cluster: mkCluster() });
  assert.equal(out, null);
});

test('generateSuggestion: ```markdown fence stripped from response', async () => {
  const llm = new MockLLM({
    responder: () => '```markdown\n# Body\nText\n```',
  });
  const out = await generateSuggestion({ llm, cluster: mkCluster() });
  assert.ok(out);
  assert.match(out!.markdown, /# Body/);
  assert.doesNotMatch(out!.markdown, /```markdown/);
});

test('generateSuggestion: user prompt carries cluster fields + per-member context', async () => {
  let capturedPrompt: string | null = null;
  const llm = new MockLLM({
    responder: (input) => {
      capturedPrompt = input.userPrompt;
      return '# Body';
    },
  });
  await generateSuggestion({
    llm,
    cluster: mkCluster(),
    contextRows: [
      { answer_md: 'first answer (truncated)' },
      { answer_md: 'second answer body' },
      { answer_md: '' },
    ],
    navHints: ['Quickstart > Setup', 'Reference > Providers'],
  });
  assert.ok(capturedPrompt);
  const parsed = JSON.parse(capturedPrompt!) as {
    cluster_id: string;
    center_question: string;
    member_count: number;
    nav_hints: string[];
    members: Array<{ question: string; answer_md: string }>;
  };
  assert.equal(parsed.cluster_id, 'c_test01');
  assert.equal(parsed.center_question, 'hermes 配置 model');
  assert.equal(parsed.member_count, 3);
  assert.deepEqual(parsed.nav_hints, ['Quickstart > Setup', 'Reference > Providers']);
  assert.equal(parsed.members.length, 3);
  assert.equal(parsed.members[0]!.answer_md, 'first answer (truncated)');
});

test('generateSuggestion: huge LLM output capped at 2000 chars + ellipsis', async () => {
  const longBody = '# Body\n' + 'x'.repeat(3000);
  const llm = new MockLLM({ responder: () => longBody });
  const out = await generateSuggestion({ llm, cluster: mkCluster() });
  assert.ok(out);
  // Frontmatter + body together; the body part is capped at 2000.
  // Frontmatter has 8 lines + 2 dashes ≈ ~150-180 chars.
  const body = out!.markdown.replace(/^---[\s\S]*?---\n/, '');
  assert.ok(body.length <= 2001, `body length ${body.length} exceeds cap`);
  assert.ok(body.endsWith('…\n') || body.endsWith('…'));
});

test('generateSuggestion: system prompt contains hard constraints (RFC §4.4)', async () => {
  let systemPrompt: string | null = null;
  const llm = new MockLLM({
    responder: (input) => {
      systemPrompt = input.systemPrompt;
      return '# Body';
    },
  });
  await generateSuggestion({ llm, cluster: mkCluster() });
  assert.ok(systemPrompt);
  assert.match(systemPrompt!, /硬约束/);
  assert.match(systemPrompt!, /不引入外部知识/);
  assert.match(systemPrompt!, /不自动写文档/);
});

// Reference unused import so TS strict mode in tests doesn't warn (mirrors
// how other test files anchor type imports).
void ({} as GenerateSuggestionInput | null);
