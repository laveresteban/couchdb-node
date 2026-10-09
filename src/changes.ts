import { CouchDBError, NotFound } from "./errors";
import type { ChangesOptions } from "./database";
import type { Change, ChangesResult, Doc } from "./types";

/** The slice of Database that ChangesFeed needs (avoids a circular import). */
export interface ChangesSource {
  changes(opts?: any): Promise<ChangesResult>;
  getLocal(id: string): Promise<Doc>;
  putLocal(id: string, doc: Doc): Promise<Doc>;
}

/** Network errors, 429 and 5xx are worth retrying; other errors are not. */
export function isTransient(err: unknown): boolean {
  if (err instanceof CouchDBError) return err.status === 0 || err.status === 429 || err.status >= 500;
  return (err as any)?.name === "FetchError";
}

/** Seconds from a `Retry-After` header, if the server sent one. */
export function retryAfter(err: unknown): number | undefined {
  const v = parseFloat((err as any)?.headers?.["retry-after"]);
  return Number.isFinite(v) ? v : undefined;
}

/** Changes query params (camelCase, e.g. `includeDocs`) plus feed-control fields. */
export type ChangesFeedOptions = Omit<ChangesOptions, "since" | "timeout" | "limit" | "feed"> & {
  since?: string;
  checkpoint?: string;
  timeout?: number;
  batchSize?: number;
  maxRetries?: number;
  maxBackoff?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Follow a database's changes via longpoll, with retries and optional `_local` checkpoint (at-least-once). */
export class ChangesFeed implements AsyncIterable<Change> {
  since: string;
  private checkpoint?: string;
  private timeout: number;
  private batchSize: number;
  private maxRetries?: number;
  private maxBackoff: number;
  private sleep: (ms: number) => Promise<void>;
  private params: Record<string, any>;
  private stopped = false;
  private checkpointRev?: string;

  constructor(private db: ChangesSource, opts: ChangesFeedOptions = {}) {
    const { since = "0", checkpoint, timeout = 60_000, batchSize = 500, maxRetries,
      maxBackoff = 30, sleep = realSleep, ...params } = opts;
    this.since = since;
    this.checkpoint = checkpoint;
    this.timeout = timeout;
    this.batchSize = batchSize;
    this.maxRetries = maxRetries;
    this.maxBackoff = maxBackoff;
    this.sleep = sleep;
    this.params = params;
  }

  stop(): void {
    this.stopped = true;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransient(err) || attempt === this.maxRetries) throw err;
        // jitter spreads out retries
        const delay = retryAfter(err) ?? (Math.random() * 0.5 + 0.5) * 2 ** attempt;
        await this.sleep(Math.min(this.maxBackoff, delay) * 1000);
      }
    }
  }

  private async loadCheckpoint(): Promise<void> {
    try {
      const doc = await this.retry(() => this.db.getLocal(this.checkpoint!));
      this.since = doc.since;
      this.checkpointRev = doc._rev;
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
    }
  }

  private async saveCheckpoint(): Promise<void> {
    const doc: Doc = { since: this.since };
    if (this.checkpointRev) doc._rev = this.checkpointRev;
    const res = await this.retry(() => this.db.putLocal(this.checkpoint!, doc));
    this.checkpointRev = res._rev;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Change> {
    if (this.checkpoint) await this.loadCheckpoint();
    while (!this.stopped) {
      const res = await this.retry(() => this.db.changes({
        since: this.since, feed: "longpoll", timeout: this.timeout,
        limit: this.batchSize, ...this.params,
      }));
      for (const change of res.results) {
        if (this.stopped) return;
        yield change;
      }
      if (res.lastSeq != null && res.lastSeq !== this.since) {
        this.since = res.lastSeq;
        if (this.checkpoint) await this.saveCheckpoint();
      }
    }
  }
}
