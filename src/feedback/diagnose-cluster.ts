/**
 * RFC 0006 A3 alpha.1 — A+ 失败查询诊断 / 聚类 pure 模块。
 *
 * Threshold-based union-find on bge-m3 cosine similarity. 选型论证见
 * `docs/rfcs/0006-failure-query-diagnostic-aplus.md` §4.2 表（HDBSCAN /
 * k-means / LLM-as-judge 均否决）。
 *
 * 输入：一批已经从 `feedback` 表筛过的候选行（仅 β 显式负反馈；γ 隐式按
 * PRD §11.4 红线不进 A+）+ 每行预先备好的嵌入向量。
 *
 * 输出：聚类列表，每簇含 cluster_id（基于 center query 的 hash，跨次
 * diagnose 稳定）+ 成员 feedback_ids + 中心 query + 密度评分。
 *
 * 算法复杂度 O(n²)：n ≤ 1000 时 ≤ 1M pair 计算，在 Node 上几十 ms。更大
 * 规模（10k+）走 alpha.3+ HNSW 加速；目前 A+ 设计样本量 50-200，O(n²)
 * 足够。
 *
 * 纯函数：不读 DB / 不调 LLM / 不写 disk。CLI alpha.2 才把 cluster 喂给
 * 建议生成。
 */

import { createHash } from 'node:crypto';

export type FeedbackClusterInput = {
  /** SQLite `feedback.feedback_id`。后续 join 用。 */
  feedback_id: number;
  /** SQLite `feedback.answer_id`。给建议生成 (alpha.2) 兜底取 answer_md。 */
  answer_id: string;
  /** 用户原始 query。center query 选取的就是它。 */
  question: string;
  /** 已 L2-normalized 的嵌入向量（bge-m3 输出默认归一化，cosine = dot）。
   *  非归一化向量也能工作，但要把内积当 cosine 的等价物会差 norm 比例 —
   *  调用方负责一致性。 */
  embedding: Float32Array;
};

export type FeedbackCluster = {
  /** Stable id 跨次 diagnose 不变。Derived from center question SHA-256
   *  前 12 hex chars。重命名 center 后 id 会变（这是设计意图：cluster
   *  的"身份"绑在主代表 query 上）。 */
  cluster_id: string;
  /** 包含的 feedback_id（输入顺序）。size ≥ minClusterSize。 */
  members: readonly number[];
  /** 同 members，但是 question 文本。方便后续 prompt 注入。 */
  member_questions: readonly string[];
  /** 与簇内所有其他 query 平均 cosine 最高的那条 = "最有代表性"。 */
  center_question: string;
  /** 中心 query 的 feedback_id（便于 trace 单条数据）。 */
  center_feedback_id: number;
  /** 簇大小 = members.length。 */
  size: number;
  /** 簇内所有 pair 的平均 cosine（去掉自身对自身的 1）。越高越紧密。
   *  实践阈值：< 0.5 是松散簇（操作员看到可能想 split） */
  density: number;
};

export type ClusterFeedbackOptions = {
  /** Edge 阈值。pair cosine ≥ threshold → union。默认 0.65（RFC §4.2）。
   *  调小（0.5）→ 更大更松散的簇；调大（0.75）→ 更多更小的簇。 */
  threshold?: number;
  /** size 低于此值的簇视为噪声 / 单例，从输出过滤。默认 2。 */
  minClusterSize?: number;
};

const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_MIN_CLUSTER_SIZE = 2;

/**
 * Main entry. Returns clusters ordered by size DESC (largest first), then
 * by density DESC as tiebreaker. Stable.
 *
 * Empty input → empty array.
 * Single input → empty array (size < minClusterSize).
 */
export function clusterFeedback(
  rows: readonly FeedbackClusterInput[],
  options: ClusterFeedbackOptions = {},
): FeedbackCluster[] {
  const n = rows.length;
  if (n === 0) return [];
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minSize = Math.max(1, options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);

  // Pairwise cosine. O(n²). For n ≤ 1000 this is 1M scalar products which
  // is fine; tighten with HNSW only when n grows past that bound.
  // Also keep the matrix for density computation.
  const sim = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    sim[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(rows[i]!.embedding, rows[j]!.embedding);
      sim[i * n + j] = s;
      sim[j * n + i] = s;
    }
  }

  // Union-find on edges where sim ≥ threshold.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sim[i * n + j]! >= threshold) {
        union(parent, i, j);
      }
    }
  }

  // Group indices by root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(parent, i);
    let list = groups.get(r);
    if (!list) {
      list = [];
      groups.set(r, list);
    }
    list.push(i);
  }

  // Build clusters; drop those below minSize.
  const out: FeedbackCluster[] = [];
  for (const memberIdx of groups.values()) {
    if (memberIdx.length < minSize) continue;

    // Center = argmax of avg sim to other members.
    let bestIdx = memberIdx[0]!;
    let bestAvg = -Infinity;
    let totalPairSim = 0;
    let totalPairCount = 0;
    for (const i of memberIdx) {
      let sum = 0;
      let cnt = 0;
      for (const j of memberIdx) {
        if (i === j) continue;
        sum += sim[i * n + j]!;
        cnt++;
      }
      const avg = cnt > 0 ? sum / cnt : 0;
      if (avg > bestAvg) {
        bestAvg = avg;
        bestIdx = i;
      }
    }
    // Density = average pairwise sim across all unordered pairs in the cluster.
    for (let i = 0; i < memberIdx.length; i++) {
      for (let j = i + 1; j < memberIdx.length; j++) {
        totalPairSim += sim[memberIdx[i]! * n + memberIdx[j]!]!;
        totalPairCount++;
      }
    }
    const density = totalPairCount > 0 ? totalPairSim / totalPairCount : 1;

    const centerRow = rows[bestIdx]!;
    const members = memberIdx.map((i) => rows[i]!.feedback_id);
    const member_questions = memberIdx.map((i) => rows[i]!.question);
    out.push({
      cluster_id: hashClusterId(centerRow.question),
      members,
      member_questions,
      center_question: centerRow.question,
      center_feedback_id: centerRow.feedback_id,
      size: memberIdx.length,
      density,
    });
  }

  // Stable sort: size DESC, density DESC.
  out.sort((a, b) => (b.size - a.size) || (b.density - a.density));
  return out;
}

/**
 * Cosine similarity for two equal-length Float32Arrays. Returns dot product
 * normalized by L2 magnitudes; safe on un-normalized inputs (only marginally
 * slower than `dot` because bge-m3 outputs ARE normalized).
 *
 * Throws on length mismatch — caller must ensure consistent embedding dim
 * (1024 for bge-m3).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function find(parent: Int32Array, i: number): number {
  let cur = i;
  while (parent[cur] !== cur) cur = parent[cur]!;
  // Path compression for free amortized cost.
  let walk = i;
  while (parent[walk] !== cur) {
    const next = parent[walk]!;
    parent[walk] = cur;
    walk = next;
  }
  return cur;
}

function union(parent: Int32Array, i: number, j: number): void {
  const ri = find(parent, i);
  const rj = find(parent, j);
  if (ri !== rj) parent[ri] = rj;
}

function hashClusterId(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return 'c_' + h.slice(0, 12);
}
