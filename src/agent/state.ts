import type { AgentConfig } from '../config.ts';
import type { EvidenceRecord } from './evidence.ts';

export type AgentToolKind = 'discovery' | 'read' | 'supplemental';

export class AgentBudget {
  private discoveryCalls = 0;
  private readCalls = 0;
  private supplementalCalls = 0;

  constructor(privateConfig: AgentConfig) {
    this.config = privateConfig;
  }

  private readonly config: AgentConfig;

  consume(kind: AgentToolKind): void {
    const used = this.used(kind);
    const limit = this.limit(kind);
    if (used >= limit) {
      throw new AgentBudgetExceededError(kind, limit);
    }
    if (kind === 'discovery') this.discoveryCalls++;
    else if (kind === 'read') this.readCalls++;
    else this.supplementalCalls++;
  }

  canUse(kind: AgentToolKind): boolean {
    return this.used(kind) < this.limit(kind);
  }

  snapshot(): AgentBudgetSnapshot {
    return {
      discovery: { used: this.discoveryCalls, limit: this.config.maxDiscoveryCalls },
      read: { used: this.readCalls, limit: this.config.maxReadCalls },
      supplemental: {
        used: this.supplementalCalls,
        limit: this.config.maxSupplementalSearchCalls,
      },
    };
  }

  private used(kind: AgentToolKind): number {
    if (kind === 'discovery') return this.discoveryCalls;
    if (kind === 'read') return this.readCalls;
    return this.supplementalCalls;
  }

  private limit(kind: AgentToolKind): number {
    if (kind === 'discovery') return this.config.maxDiscoveryCalls;
    if (kind === 'read') return this.config.maxReadCalls;
    return this.config.maxSupplementalSearchCalls;
  }
}

export type AgentBudgetSnapshot = {
  discovery: { used: number; limit: number };
  read: { used: number; limit: number };
  supplemental: { used: number; limit: number };
};

export class EvidenceLedger {
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly contentKeys = new Map<string, string>();

  add(record: EvidenceRecord): EvidenceRecord {
    const contentKey = `${record.pageId}\0${record.lang}\0${record.contentHash}`;
    const existingId = this.contentKeys.get(contentKey);
    if (existingId) return this.records.get(existingId)!;
    this.records.set(record.evidenceId, record);
    this.contentKeys.set(contentKey, record.evidenceId);
    return record;
  }

  all(): EvidenceRecord[] {
    return [...this.records.values()];
  }

  get size(): number {
    return this.records.size;
  }

  resolveCitations(text: string): {
    answer: string;
    records: EvidenceRecord[];
    unknownIds: string[];
  } {
    const ids: string[] = [];
    const unknownIds: string[] = [];
    for (const match of text.matchAll(/\[(ev_[a-f0-9]{20})\]/g)) {
      const id = match[1]!;
      if (!this.records.has(id)) {
        if (!unknownIds.includes(id)) unknownIds.push(id);
      } else if (!ids.includes(id)) {
        ids.push(id);
      }
    }
    const numbering = new Map(ids.map((id, index) => [id, `cit_${index + 1}`]));
    return {
      answer: text.replace(/\[(ev_[a-f0-9]{20})\]/g, (_whole, id: string) => {
        const citation = numbering.get(id);
        return citation ? `[${citation}]` : '';
      }),
      records: ids.map((id) => this.records.get(id)!),
      unknownIds,
    };
  }
}

export class AgentBudgetExceededError extends Error {
  readonly kind: AgentToolKind;
  readonly limit: number;

  constructor(kind: AgentToolKind, limit: number) {
    super(`${kind} tool budget exceeded (${limit})`);
    this.name = 'AgentBudgetExceededError';
    this.kind = kind;
    this.limit = limit;
  }
}
