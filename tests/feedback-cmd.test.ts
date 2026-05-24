/**
 * Integration tests for the `feedback export / import / status` commands.
 *
 * Spins up a real SQLite DB on disk under a tmp stateRoot (so the commands
 * exercise their actual openDatabase path), seeds it with feedback rows, and
 * drives the CLI entrypoints in-process. Stdout/stderr captured to assert
 * user-visible behavior, not just side-effects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.ts';
import {
  runFeedbackDiagnose,
  runFeedbackExport,
  runFeedbackImport,
  runFeedbackStatus,
} from '../src/commands/feedback.ts';
import { parseInbox } from '../src/feedback/markdown.ts';

type ScenarioPaths = {
  projectRoot: string;
  stateRoot: string;
  cleanup: () => Promise<void>;
};

async function makeScenario(opts: { feedbackEnabled: boolean }): Promise<ScenarioPaths> {
  const projectRoot = await fs.mkdtemp(join(tmpdir(), 'fb-cmd-proj-'));
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'fb-cmd-state-'));
  // Minimum-valid anydocs project skeleton; commands only call loadConfig and
  // touch index.db, so we don't need real pages/navigation here.
  await fs.mkdir(join(projectRoot, 'pages'), { recursive: true });
  await fs.mkdir(join(projectRoot, 'navigation'), { recursive: true });
  await fs.writeFile(
    join(projectRoot, 'anydocs.ask.json'),
    JSON.stringify({ feedback: { enabled: opts.feedbackEnabled } }),
  );
  // openDatabase under stateRoot runs migrations through 002.
  const db = openDatabase({ stateRoot });
  db.close();
  return {
    projectRoot,
    stateRoot,
    cleanup: async () => {
      await fs.rm(projectRoot, { recursive: true, force: true });
      await fs.rm(stateRoot, { recursive: true, force: true });
    },
  };
}

function seedFeedback(
  stateRoot: string,
  rows: Array<{
    answer_id: string;
    question: string;
    generated: string;
    rating: number;
    signal_source?: string;
    bad_citation_ids?: string[];
  }>,
): number[] {
  const db = openDatabase({ stateRoot, skipMigrations: true });
  const stmt = db.prepare(
    `INSERT INTO feedback
       (answer_id, question, generated, rating, bad_citation_ids,
        signal_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids: number[] = [];
  const now = Date.UTC(2026, 4, 16);
  try {
    for (const r of rows) {
      const info = stmt.run(
        r.answer_id,
        r.question,
        r.generated,
        r.rating,
        JSON.stringify(r.bad_citation_ids ?? []),
        r.signal_source ?? 'explicit',
        now,
      );
      ids.push(
        typeof info.lastInsertRowid === 'bigint'
          ? Number(info.lastInsertRowid)
          : info.lastInsertRowid,
      );
    }
  } finally {
    db.close();
  }
  return ids;
}

function captureStd(): { stdoutChunks: string[]; stderrChunks: string[]; restore: () => void } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  return {
    stdoutChunks,
    stderrChunks,
    restore: () => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    },
  };
}

// ---------------------------------------------------------------------------
// Guard: feedback.enabled = false (default)
// ---------------------------------------------------------------------------

test('export refuses when feedback.enabled=false (config guard)', async () => {
  const s = await makeScenario({ feedbackEnabled: false });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q1', generated: 'g1', rating: -1 },
    ]);
    const cap = captureStd();
    try {
      const code = await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 2, 'should exit non-zero');
    } finally {
      cap.restore();
    }
    assert.match(cap.stderrChunks.join(''), /feedback\.enabled is false/);
    // Default-disabled boot must not create the dir tree.
    assert.equal(existsSync(join(s.stateRoot, 'feedback')), false);
  } finally {
    await s.cleanup();
  }
});

test('import refuses when feedback.enabled=false', async () => {
  const s = await makeScenario({ feedbackEnabled: false });
  try {
    const cap = captureStd();
    try {
      const code = await runFeedbackImport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 2);
    } finally {
      cap.restore();
    }
    assert.match(cap.stderrChunks.join(''), /feedback\.enabled is false/);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// `feedback export`
// ---------------------------------------------------------------------------

test('export writes one inbox/*.md per reviewable feedback row', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'how to authenticate', generated: 'use JWT', rating: -1 },
      { answer_id: 'a2', question: 'where are the docs', generated: 'see /docs', rating: 0 },
      // positive-rated row: not reviewable
      { answer_id: 'a3', question: 'thanks', generated: 'np', rating: 1 },
    ]);
    const cap = captureStd();
    try {
      const code = await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    const inbox = join(s.stateRoot, 'feedback', 'inbox');
    const files = readdirSync(inbox).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 2, 'two reviewable rows → two inbox files');
    assert.match(cap.stdoutChunks.join(''), /wrote 2 file\(s\)/);

    // Parse the first file and check structure.
    const md = readFileSync(join(inbox, files[0]!), 'utf8');
    const parsed = parseInbox(md);
    assert.equal(parsed.frontmatter.decision, 'pending');
    assert.equal(parsed.frontmatter.queries.length, 1);
    assert.equal(parsed.frontmatter.signal_source, 'explicit');
  } finally {
    await s.cleanup();
  }
});

test('export is idempotent: second run skips existing files', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q', generated: 'g', rating: -1 },
    ]);
    let cap = captureStd();
    try {
      await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
    } finally {
      cap.restore();
    }
    cap = captureStd();
    try {
      await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
    } finally {
      cap.restore();
    }
    assert.match(cap.stdoutChunks.join(''), /skipped 1 existing/);
  } finally {
    await s.cleanup();
  }
});

test('export excludes already-reviewed rows', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    const [id] = seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q', generated: 'g', rating: -1 },
    ]);
    // Mark it reviewed directly.
    const db = openDatabase({ stateRoot: s.stateRoot, skipMigrations: true });
    db.prepare(`UPDATE feedback SET reviewed_at = ?, review_decision = 'rejected' WHERE feedback_id = ?`).run(1, id);
    db.close();
    const cap = captureStd();
    try {
      const code = await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    assert.match(cap.stdoutChunks.join(''), /no reviewable rows/);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// `feedback import`
// ---------------------------------------------------------------------------

test('import applies approved decision → curated row inserted + source marked', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    const [id] = seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q', generated: 'g', rating: -1 },
    ]);
    await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });

    const inbox = join(s.stateRoot, 'feedback', 'inbox');
    const file = readdirSync(inbox)[0]!;
    const path = join(inbox, file);
    // Author flips decision + writes a correction.
    const md = readFileSync(path, 'utf8')
      .replace('decision: pending', 'decision: approved')
      .replace('## Corrected answer\n\n', '## Corrected answer\n\nUse a session cookie, not JWT.\n');
    writeFileSync(path, md, 'utf8');

    const cap = captureStd();
    try {
      const code = await runFeedbackImport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    assert.match(cap.stdoutChunks.join(''), /1 approved/);

    // Source row marked.
    const db = openDatabase({ stateRoot: s.stateRoot, skipMigrations: true });
    const src = db.prepare(`SELECT review_decision, cluster_id FROM feedback WHERE feedback_id = ?`).get(id) as {
      review_decision: string;
      cluster_id: string;
    };
    assert.equal(src.review_decision, 'approved');
    assert.match(src.cluster_id, /^2026-W20-/);

    // Curated row inserted.
    const curated = db
      .prepare(`SELECT * FROM feedback WHERE signal_source = 'curated' AND cluster_id = ?`)
      .get(src.cluster_id) as {
      correction: string;
      rating: number;
      review_decision: string;
    };
    assert.ok(curated, 'curated row should exist');
    assert.match(curated.correction, /session cookie/);
    assert.equal(curated.rating, 1);
    assert.equal(curated.review_decision, 'approved');
    db.close();

    // Inbox file deleted.
    assert.equal(existsSync(path), false);

    // Archive jsonl appended.
    const archive = readdirSync(join(s.stateRoot, 'feedback', 'approved'));
    assert.equal(archive.length, 1);
    assert.match(archive[0]!, /\.jsonl$/);
  } finally {
    await s.cleanup();
  }
});

test('import applies rejected decision → no curated row, archive line written', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    const [id] = seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q', generated: 'g', rating: -1 },
    ]);
    await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });

    const inbox = join(s.stateRoot, 'feedback', 'inbox');
    const file = readdirSync(inbox)[0]!;
    const path = join(inbox, file);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('decision: pending', 'decision: rejected'),
      'utf8',
    );

    const cap = captureStd();
    try {
      await runFeedbackImport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
    } finally {
      cap.restore();
    }

    const db = openDatabase({ stateRoot: s.stateRoot, skipMigrations: true });
    const src = db.prepare(`SELECT review_decision FROM feedback WHERE feedback_id = ?`).get(id) as {
      review_decision: string;
    };
    assert.equal(src.review_decision, 'rejected');
    const curated = db.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE signal_source = 'curated'`).get() as { n: number };
    assert.equal(curated.n, 0, 'rejected import must NOT create a curated row');
    db.close();
  } finally {
    await s.cleanup();
  }
});

test('import leaves pending files in place', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q', generated: 'g', rating: -1 },
    ]);
    await runFeedbackExport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });

    const inbox = join(s.stateRoot, 'feedback', 'inbox');
    const filesBefore = readdirSync(inbox);
    const cap = captureStd();
    try {
      await runFeedbackImport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
    } finally {
      cap.restore();
    }
    const filesAfter = readdirSync(inbox);
    assert.deepEqual(filesAfter, filesBefore, 'pending files must survive import');
    assert.match(cap.stdoutChunks.join(''), /1 pending/);
  } finally {
    await s.cleanup();
  }
});

test('import skips malformed inbox file with explanatory stderr', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    const inbox = join(s.stateRoot, 'feedback', 'inbox');
    await fs.mkdir(inbox, { recursive: true });
    writeFileSync(join(inbox, 'broken.md'), 'not actually a frontmatter file', 'utf8');
    const cap = captureStd();
    try {
      const code = await runFeedbackImport({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 1, 'malformed file → non-zero exit');
    } finally {
      cap.restore();
    }
    assert.match(cap.stderrChunks.join(''), /broken\.md/);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// `feedback status`
// ---------------------------------------------------------------------------

test('status reports counts and current config flag', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q1', generated: 'g', rating: -1 },
      { answer_id: 'a2', question: 'q2', generated: 'g', rating: -1 },
    ]);
    const cap = captureStd();
    try {
      const code = await runFeedbackStatus({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    const out = cap.stdoutChunks.join('');
    assert.match(out, /enabled:\s+true/);
    assert.match(out, /reviewable rows:\s+2/);
    assert.match(out, /run 'feedback export'/);
  } finally {
    await s.cleanup();
  }
});

test('status works when feedback.enabled=false (read-only, no guard)', async () => {
  // Status is the one command that must remain useful even with the loop
  // disabled — operators need to see "yes, you have rows you could be
  // reviewing" before flipping the switch.
  const s = await makeScenario({ feedbackEnabled: false });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q1', generated: 'g', rating: -1 },
    ]);
    const cap = captureStd();
    try {
      const code = await runFeedbackStatus({ projectRoot: s.projectRoot, stateRoot: s.stateRoot });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    assert.match(cap.stdoutChunks.join(''), /enabled:\s+false/);
    assert.match(cap.stdoutChunks.join(''), /reviewable rows:\s+1/);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// `feedback diagnose` (RFC 0006 alpha.2 real pipeline)
// ---------------------------------------------------------------------------

import { MockLLM } from '../src/llm/mock.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';

function mockSuggestLLM(): MockLLM {
  return new MockLLM({
    model: 'mock-diagnose-llm',
    responder: (input) => {
      // Pull center_question out of the user prompt for stable inline test.
      let center = 'unknown';
      try {
        const parsed = JSON.parse(input.userPrompt) as { center_question?: string };
        if (typeof parsed.center_question === 'string') center = parsed.center_question;
      } catch {
        /* ignore */
      }
      return [
        `# 建议：在 (未指定) 下新增 "${center}" 章节`,
        `## 当前用户的痛点（脱敏抽样）`,
        `- ${center}`,
        `## 建议覆盖的事实点`,
        `- (mock 建议生成 — 见 cluster JSON trace)`,
        `## 建议挂载位置`,
        `(determine mount point manually)`,
      ].join('\n');
    },
  });
}

test('diagnose: aplus disabled + no rows → "feature off" message, exit 0', async () => {
  const s = await makeScenario({ feedbackEnabled: false });
  try {
    const cap = captureStd();
    try {
      const code = await runFeedbackDiagnose({
        projectRoot: s.projectRoot,
        stateRoot: s.stateRoot,
        llm: mockSuggestLLM(),
        embedder: new MockEmbedder(),
      });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    const out = cap.stdoutChunks.join('');
    assert.match(out, /aplus\.enabled:\s+false/);
    assert.match(out, /threshold:\s+50/);
    assert.match(out, /observation window:\s+28d/);
    assert.match(out, /aplus\.enabled is false/);
  } finally {
    await s.cleanup();
  }
});

test('diagnose: data insufficient (< threshold) → guided message + exit 0', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q1', generated: 'g', rating: -1 },
      { answer_id: 'a2', question: 'q2', generated: 'g', rating: -1 },
      { answer_id: 'a3', question: 'q3', generated: 'g', rating: -1 },
      { answer_id: 'a4', question: 'q4', generated: 'g', rating: -1 },
      { answer_id: 'a5', question: 'q5', generated: 'g', rating: -1 },
    ]);
    await fs.writeFile(
      join(s.projectRoot, 'anydocs.ask.json'),
      JSON.stringify({ feedback: { enabled: true }, aplus: { enabled: true } }),
    );
    const cap = captureStd();
    try {
      const code = await runFeedbackDiagnose({
        projectRoot: s.projectRoot,
        stateRoot: s.stateRoot,
        llm: mockSuggestLLM(),
        embedder: new MockEmbedder(),
      });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    const out = cap.stdoutChunks.join('');
    assert.match(out, /candidate β feedback rows:\s+5/);
    assert.match(out, /data insufficient: 5 of 50/);
  } finally {
    await s.cleanup();
  }
});

test('diagnose: --threshold + --shadow → writes suggestions/.shadow/cluster_*.{md,json}', async () => {
  // Real pipeline: 2 β rows with identical-ish text → MockEmbedder gives
  // deterministic vectors per text, so they'll cluster (or not) based on
  // the mock vectors. We pin threshold low (2) and use a tiny similarity
  // override via config write to ensure cluster forms.
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'hermes 怎么配置 model provider？', generated: 'g', rating: -1 },
      { answer_id: 'a2', question: 'hermes 配置 model provider', generated: 'g', rating: -1 },
    ]);
    await fs.writeFile(
      join(s.projectRoot, 'anydocs.ask.json'),
      JSON.stringify({
        feedback: { enabled: true },
        // Pin similarity threshold low so MockEmbedder's hash-based vectors
        // get unioned even though the two strings differ. The real bge-m3
        // would group them at the default 0.65.
        aplus: { enabled: true, embedSimilarityThreshold: 0.001 },
      }),
    );
    const cap = captureStd();
    try {
      const code = await runFeedbackDiagnose({
        projectRoot: s.projectRoot,
        stateRoot: s.stateRoot,
        threshold: 2,
        shadow: true,
        llm: mockSuggestLLM(),
        embedder: new MockEmbedder(),
      });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    const out = cap.stdoutChunks.join('');
    assert.match(out, /candidate β feedback rows:\s+2/);
    assert.match(out, /clusters formed:\s+1/);
    assert.match(out, /suggestions written:\s+1/);
    assert.match(out, /shadow/, 'output should mention shadow output dir');
    // Files actually landed under .shadow/.
    const shadowDir = join(s.stateRoot, 'feedback', 'suggestions', '.shadow');
    const files = readdirSync(shadowDir);
    const mdFile = files.find((f) => f.endsWith('.md'));
    const jsonFile = files.find((f) => f.endsWith('.json'));
    assert.ok(mdFile, `expected a cluster_*.md under ${shadowDir}; got ${files.join(', ')}`);
    assert.ok(jsonFile, `expected a cluster_*.json under ${shadowDir}`);
    const md = readFileSync(join(shadowDir, mdFile!), 'utf8');
    assert.match(md, /cluster_id: c_/);
    assert.match(md, /model: mock-diagnose-llm/);
    assert.match(md, /shadow: true/);
    assert.match(md, /建议：/);
    const trace = JSON.parse(readFileSync(join(shadowDir, jsonFile!), 'utf8')) as {
      cluster_id: string;
      size: number;
      suggestion: { model: string };
    };
    assert.equal(trace.size, 2);
    assert.equal(trace.suggestion.model, 'mock-diagnose-llm');
  } finally {
    await s.cleanup();
  }
});

test('diagnose: --dry-run with threshold met → no files written but output paths reported', async () => {
  const s = await makeScenario({ feedbackEnabled: true });
  try {
    seedFeedback(s.stateRoot, [
      { answer_id: 'a1', question: 'q-alpha', generated: 'g', rating: -1 },
      { answer_id: 'a2', question: 'q-alpha', generated: 'g', rating: -1 },
    ]);
    await fs.writeFile(
      join(s.projectRoot, 'anydocs.ask.json'),
      JSON.stringify({
        feedback: { enabled: true },
        aplus: { enabled: true, embedSimilarityThreshold: 0.001 },
      }),
    );
    const cap = captureStd();
    try {
      const code = await runFeedbackDiagnose({
        projectRoot: s.projectRoot,
        stateRoot: s.stateRoot,
        threshold: 2,
        dryRun: true,
        llm: mockSuggestLLM(),
        embedder: new MockEmbedder(),
      });
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    // No actual files (dry-run).
    const outDir = join(s.stateRoot, 'feedback', 'suggestions');
    assert.equal(
      existsSync(join(outDir, 'cluster_dummy.md')),
      false,
      'sanity: no leftover cluster files',
    );
  } finally {
    await s.cleanup();
  }
});

test('diagnose: invalid observation window → 2', async () => {
  const s = await makeScenario({ feedbackEnabled: false });
  try {
    const cap = captureStd();
    let code: number;
    try {
      code = await runFeedbackDiagnose({
        projectRoot: s.projectRoot,
        stateRoot: s.stateRoot,
        observationWindow: 'four-weeks',
        llm: mockSuggestLLM(),
        embedder: new MockEmbedder(),
      });
    } finally {
      cap.restore();
    }
    assert.equal(code, 2);
    assert.match(cap.stderrChunks.join(''), /invalid observationWindow/);
  } finally {
    await s.cleanup();
  }
});
