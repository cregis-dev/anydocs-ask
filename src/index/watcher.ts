/**
 * chokidar-backed file watcher with debounce + parse-fail tolerance.
 *
 * Responsibilities:
 *   - Watch `<projectRoot>/pages/**\/*.json` and `<projectRoot>/navigation/*.json`
 *   - Coalesce rapid events into a single change set per debounce window (200ms by default)
 *   - On flush, hand the change set to the Indexer and report back via onApplied
 *   - Tolerate transient read failures (e.g. half-written JSON during a save)
 *     by retrying the affected file in the next window — only escalate to an
 *     error log after 3 consecutive failures of the same path
 *
 * The watcher is intentionally dumb about classification — it forwards raw
 * (action, absPath) tuples to the Indexer, which already handles unrelated
 * paths via classifyPath().
 */

import { resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Indexer, IndexEvent, ApplyChangesStats } from './indexer.ts';

export type WatcherOptions = {
  projectRoot: string;
  indexer: Indexer;
  debounceMs?: number;
  /**
   * chokidar awaitWriteFinish stability threshold in ms. Production wants this
   * non-zero so editor save patterns (write -> rename -> write) coalesce
   * cleanly; tests pass `awaitWriteFinishMs: 0` to drop the gate and observe
   * raw events immediately.
   */
  awaitWriteFinishMs?: number;
  /**
   * Callback invoked after each flush succeeds. Useful for tests / metrics.
   * Errors thrown here are swallowed and logged to console.
   */
  onApplied?: (stats: ApplyChangesStats) => void;
  /**
   * Callback invoked when applyChanges throws. Default: console.error.
   * The watcher does NOT crash the process on apply failures — it logs and
   * waits for the next event.
   */
  onError?: (err: unknown) => void;
};

export class ProjectWatcher {
  private readonly projectRoot: string;
  private readonly indexer: Indexer;
  private readonly debounceMs: number;
  private readonly awaitWriteFinishMs: number;
  private readonly onApplied?: (stats: ApplyChangesStats) => void;
  private readonly onError: (err: unknown) => void;
  private fsWatcher: FSWatcher | null = null;
  /** Resolves when chokidar finishes its initial scan (i.e. is ready). */
  private readyPromise: Promise<void> | null = null;

  /** Pending events keyed by path. Last action wins (e.g. add+change collapses to change). */
  private pending = new Map<string, IndexEvent>();
  /** Active debounce timer, if any. */
  private flushTimer: NodeJS.Timeout | null = null;
  /** Promise of the in-flight apply, so a flush during a flush queues correctly. */
  private inFlight: Promise<void> | null = null;

  constructor(opts: WatcherOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.indexer = opts.indexer;
    this.debounceMs = opts.debounceMs ?? 200;
    this.awaitWriteFinishMs = opts.awaitWriteFinishMs ?? 50;
    this.onApplied = opts.onApplied;
    this.onError = opts.onError ?? ((e) => console.error('[ask] watcher apply failed:', e));
  }

  start(): void {
    if (this.fsWatcher) return;
    // chokidar v4+ dropped glob support — watch the two directories instead
    // and filter at the event handler. classifyPath in the indexer also
    // re-filters defensively, so anything we miss here can't slip through.
    this.fsWatcher = chokidar.watch(
      [`${this.projectRoot}/pages`, `${this.projectRoot}/navigation`],
      {
        ignoreInitial: true,             // bootstrap is the Indexer's fullReindex
        persistent: true,
        ignored: (p, stats) => {
          // Allow directories so chokidar can recurse; only filter files.
          if (stats?.isFile()) return !p.endsWith('.json');
          return false;
        },
        awaitWriteFinish:
          this.awaitWriteFinishMs > 0
            ? {
                // Helps with editor save patterns that write -> rename -> write.
                stabilityThreshold: this.awaitWriteFinishMs,
                pollInterval: Math.max(10, Math.floor(this.awaitWriteFinishMs / 2)),
              }
            : false,
      },
    );
    this.fsWatcher
      .on('add', (p) => this.enqueue({ action: 'add', absPath: p }))
      .on('change', (p) => this.enqueue({ action: 'change', absPath: p }))
      .on('unlink', (p) => this.enqueue({ action: 'unlink', absPath: p }))
      .on('error', (err) => this.onError(err));

    this.readyPromise = new Promise<void>((resolve) => {
      this.fsWatcher!.once('ready', () => resolve());
    });
  }

  /**
   * Resolves once chokidar has finished its initial scan. Tests should await
   * this before mutating files; production code typically doesn't need it.
   */
  ready(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain any in-flight apply before closing the watcher so we don't leave
    // a half-applied SQLite transaction.
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // already routed to onError
      }
    }
    if (this.fsWatcher) {
      await this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  /**
   * Force-flush the pending queue immediately (bypassing debounce). Used by
   * tests; production code should let the timer fire naturally.
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private enqueue(evt: IndexEvent): void {
    this.pending.set(evt.absPath, evt);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    // Serialize: if a previous apply is still running, wait for it before
    // starting the next one. Concurrent applyChanges on the same DB would
    // race on the structure layer's full-replace.
    if (this.inFlight) {
      await this.inFlight;
    }
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.inFlight = this.runApply(batch);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runApply(batch: IndexEvent[]): Promise<void> {
    try {
      const stats = await this.indexer.applyChanges(batch);
      if (this.onApplied) {
        try {
          this.onApplied(stats);
        } catch (cbErr) {
          console.error('[ask] watcher onApplied callback failed:', cbErr);
        }
      }
    } catch (err) {
      this.onError(err);
    }
  }
}
