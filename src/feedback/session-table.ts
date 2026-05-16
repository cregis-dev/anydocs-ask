/**
 * In-memory session table for γ implicit signals — ARCH §15.2.2.
 *
 * Lifetime: a Reader client gets a `session_id` in the first `/v1/ask`
 * response, then echoes it back on subsequent asks. We hold its recent ask
 * vectors here (RAM only) so the next ask can do a similarity check against
 * the previous N for the "user re-asked within 5min" implicit negative
 * signal.
 *
 * Why RAM and not the DB:
 *   - Window is short (5min); restart-survival is not worth the schema cost
 *   - All work happens on the hot /v1/ask path; one allocation cheaper than
 *     a per-ask SELECT + INSERT
 *   - Loss on process restart is acceptable — γ is best-effort by design
 *     (see PRD §11.2 decision ②: β is the primary signal, γ is fallback)
 *
 * Bounds:
 *   - Per-session entry list capped at MAX_ENTRIES_PER_SESSION (oldest evicted)
 *   - Total session count soft-bounded by MAX_SESSIONS — past that we evict
 *     the LRU session before inserting a new one. 10k sessions * ~5 entries
 *     each * ~4KB (1024 floats) ≈ 200MB worst case; the soft cap pulls that
 *     down to a much smaller working set.
 */

import { randomUUID } from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30min (ARCH §15.2.2)
const DEFAULT_REASK_WINDOW_MS = 5 * 60 * 1000; //  5min (ARCH §15.2.2)
const MAX_ENTRIES_PER_SESSION = 8;
const MAX_SESSIONS = 10_000;

/** Single ask captured for similarity comparison against future asks. */
export type SessionEntry = {
  question: string;
  /** Already-normalized embedding from the embedder (bge-m3 emits L2=1). */
  embedding: Float32Array;
  /** answer_id of the ask this entry came from — used to point γ rows at the
   *  question whose answer was unsatisfying. null on clarify / error paths. */
  answer_id: string | null;
  /** chunk_ids that landed in the answer's citations. Empty on clarify/error.
   *  These become `bad_citation_ids` on the implicit negative row — the user
   *  re-asked, so the chunks that drove the previous answer get a demerit. */
  used_chunk_ids: number[];
  /** When the ask was recorded. Used for the 5min re-ask window cutoff. */
  asked_at: number;
};

type SessionRecord = {
  id: string;
  entries: SessionEntry[];
  /** ms-epoch when this whole session goes away (refreshed on each touch). */
  expires_at: number;
};

export type SessionTableOptions = {
  /** Override TTL — tests use small values for deterministic eviction. */
  sessionTtlMs?: number;
  /** Override the "this counts as a re-ask" window — tests use small values. */
  reaskWindowMs?: number;
  /** Inject Date.now() for deterministic tests. */
  now?: () => number;
};

export class SessionTable {
  private readonly map = new Map<string, SessionRecord>();
  private readonly sessionTtlMs: number;
  private readonly reaskWindowMs: number;
  private readonly now: () => number;

  constructor(opts: SessionTableOptions = {}) {
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.reaskWindowMs = opts.reaskWindowMs ?? DEFAULT_REASK_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Number of live sessions; for tests / observability. */
  get size(): number {
    return this.map.size;
  }

  get reaskWindow(): number {
    return this.reaskWindowMs;
  }

  /**
   * Return the existing session if `requested` was provided and still alive;
   * otherwise mint a new one. Always refreshes the TTL on success.
   *
   * Side effect: opportunistically evicts expired sessions encountered on
   * the way out (caps total work at a few per call).
   */
  getOrCreate(requested: string | null | undefined): string {
    const now = this.now();
    if (requested) {
      const existing = this.map.get(requested);
      if (existing && existing.expires_at > now) {
        existing.expires_at = now + this.sessionTtlMs;
        return existing.id;
      }
      // Expired or unknown — fall through and mint a new one. We don't reuse
      // the requested id verbatim: a client whose session expired should get
      // a fresh identity so server-side state remains internally consistent.
    }
    this.opportunisticCleanup();
    const id = mintSessionId();
    this.map.set(id, { id, entries: [], expires_at: now + this.sessionTtlMs });
    if (this.map.size > MAX_SESSIONS) {
      this.evictOldest();
    }
    return id;
  }

  /**
   * Return entries from this session that were asked within the re-ask window
   * and whose embedding is at least `threshold` cosine-similar to `vec`.
   * Sorted by descending similarity. Caller decides what to do with them
   * (typically: write an implicit-negative feedback row for each).
   *
   * Returns `[]` for unknown / expired sessions.
   */
  findSimilarRecent(args: {
    session_id: string;
    embedding: Float32Array;
    threshold: number;
  }): Array<{ entry: SessionEntry; similarity: number }> {
    const now = this.now();
    const rec = this.map.get(args.session_id);
    if (!rec || rec.expires_at <= now) return [];
    const windowStart = now - this.reaskWindowMs;
    const hits: Array<{ entry: SessionEntry; similarity: number }> = [];
    for (const entry of rec.entries) {
      if (entry.asked_at < windowStart) continue;
      const s = cosineSimilarity(args.embedding, entry.embedding);
      if (s >= args.threshold) hits.push({ entry, similarity: s });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits;
  }

  /**
   * Append a new entry. Evicts the oldest if the per-session cap is hit, and
   * refreshes the session TTL. Silently no-ops on unknown session ids — the
   * server should always have called `getOrCreate` first, so an unknown id
   * here means a race we'd rather drop than crash on.
   */
  record(args: { session_id: string; entry: SessionEntry }): void {
    const rec = this.map.get(args.session_id);
    if (!rec) return;
    rec.entries.push(args.entry);
    if (rec.entries.length > MAX_ENTRIES_PER_SESSION) {
      rec.entries.shift();
    }
    rec.expires_at = this.now() + this.sessionTtlMs;
  }

  /** Force-drop expired records — exposed mainly for tests. Returns count. */
  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, rec] of this.map) {
      if (rec.expires_at <= now) {
        this.map.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private opportunisticCleanup(): void {
    // Sample first N entries; cheap probabilistic GC instead of a full walk.
    // The full walk is available via cleanup() for tests / health checks.
    let scanned = 0;
    const now = this.now();
    for (const [id, rec] of this.map) {
      if (rec.expires_at <= now) this.map.delete(id);
      scanned += 1;
      if (scanned >= 16) break;
    }
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestExp = Infinity;
    for (const [id, rec] of this.map) {
      if (rec.expires_at < oldestExp) {
        oldestExp = rec.expires_at;
        oldestId = id;
      }
    }
    if (oldestId !== null) this.map.delete(oldestId);
  }
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/**
 * Cosine similarity for the embedder's output vectors. bge-m3 emits already-
 * L2-normalized vectors so a plain dot product gives cosine — but we keep
 * the division anyway, defensively, so a swap to a non-normalized model
 * doesn't silently break similarity thresholds.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function mintSessionId(): string {
  return `s_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
