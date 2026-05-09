/**
 * Query clustering for analyze D1.
 *
 * ARCH §16.6 calls for MinHash clustering. v1 traffic is in the dozens of
 * runs per week, so MinHash's sublinear matching buys us nothing. We do the
 * obvious thing instead:
 *
 *   1. Normalize: lowercase, NFKC, strip ASCII punctuation, collapse
 *      whitespace. CJK is left intact (no word boundaries to enforce).
 *   2. Bucket by exact normalized string — handles the dominant "asked the
 *      same thing twice" case for free.
 *   3. Pass 2 union-find over bucket reps: merge two buckets if their reps'
 *      Levenshtein distance ≤ EDIT_DISTANCE_MAX. Caps the second pass at
 *      O(N²) over distinct reps; with N < 200 this is microseconds.
 *
 * Output shape preserves first-seen order so the report is stable across
 * runs given the same input.
 *
 * Bumping to MinHash is a v1.5 question once we see real run volumes ≥ 1k/wk.
 */

const EDIT_DISTANCE_MAX = 5;

export type Cluster<T> = {
  /** Stable cluster id; integer assigned in first-seen order. */
  id: number;
  /** Display rep — the first item to land in the cluster, normalized form. */
  rep: string;
  /** Original-form representatives (deduped, in first-seen order). */
  variants: string[];
  /** Items grouped here. */
  items: T[];
};

export type ClusterInput<T> = {
  /** The raw query string for an item; passed through normalize(). */
  queryOf: (item: T) => string;
};

export function clusterByQuery<T>(items: T[], opts: ClusterInput<T>): Cluster<T>[] {
  // Pass 1: exact-normalized buckets, preserving first-seen order.
  const exactBuckets = new Map<string, { rep: string; variants: string[]; items: T[] }>();
  for (const item of items) {
    const raw = opts.queryOf(item);
    const norm = normalize(raw);
    const existing = exactBuckets.get(norm);
    if (existing) {
      if (!existing.variants.includes(raw)) existing.variants.push(raw);
      existing.items.push(item);
    } else {
      exactBuckets.set(norm, { rep: norm, variants: [raw], items: [item] });
    }
  }

  // Pass 2: union-find merge of near-duplicate buckets by Levenshtein on reps.
  const reps = Array.from(exactBuckets.keys());
  const parent = reps.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x]! !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      // Cheap length-prune; further than EDIT_DISTANCE_MAX in length means
      // the distance is also at least that much.
      if (Math.abs(reps[i]!.length - reps[j]!.length) > EDIT_DISTANCE_MAX) continue;
      if (levenshteinAtMost(reps[i]!, reps[j]!, EDIT_DISTANCE_MAX) <= EDIT_DISTANCE_MAX) {
        union(i, j);
      }
    }
  }

  // Materialize merged clusters in first-seen order.
  const merged = new Map<number, Cluster<T>>();
  let nextId = 0;
  reps.forEach((rep, idx) => {
    const root = find(idx);
    const bucket = exactBuckets.get(rep)!;
    const existing = merged.get(root);
    if (existing) {
      for (const v of bucket.variants) if (!existing.variants.includes(v)) existing.variants.push(v);
      existing.items.push(...bucket.items);
    } else {
      merged.set(root, {
        id: nextId++,
        rep: bucket.rep,
        variants: [...bucket.variants],
        items: [...bucket.items],
      });
    }
  });

  return [...merged.values()].sort((a, b) => b.items.length - a.items.length || a.id - b.id);
}

const PUNCT_RE = /[!-/:-@[-`{-~]/g;

export function normalize(query: string): string {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein with an early-exit max threshold. Returns the true distance if
 * ≤ max, otherwise returns max+1 (meaning "exceeded threshold").
 *
 * Implementation: classic two-row DP, but we bail out when the row's minimum
 * exceeds max. For our sizes (queries ≤ ~120 chars) the early exit is the
 * difference between us looking at every pair O(N²) and walking off into
 * the weeds.
 */
export function levenshteinAtMost(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] as number;
}
