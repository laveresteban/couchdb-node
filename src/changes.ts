import { CouchDBError, NotFound } from "./errors";
import type { ChangesOptions } from "./database";
import type { Change, ChangesResult, Doc } from "./types";

/** The slice of Database that ChangesFeed needs (avoids a circular import). */
export interface ChangesSource {
  changes(opts?: any): Promise<ChangesResult>;
  /** Opens `feed=continuous` and returns the raw NDJSON body. */
  continuousChanges(opts: any, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
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
export type ChangesFeedOptions = Omit<ChangesOptions, "since" | "timeout" | "limit" | "feed" | "signal"> & {
  since?: string;
  checkpoint?: string;
  /**
   * `longpoll` (default) polls one batch at a time. `continuous` keeps one
   * streaming connection open and yields changes as CouchDB sends them.
   */
  feed?: "longpoll" | "continuous";
  /** Longpoll wait in ms. */
  timeout?: number;
  /** Rows per longpoll batch; in continuous mode, rows between checkpoint saves. */
  batchSize?: number;
  maxRetries?: number;
  maxBackoff?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Splits a byte stream into text lines. */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) yield buf;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Follow a database's changes forever, with retries and an optional `_local`
 * checkpoint (at-least-once delivery).
 *
 * Transient failures are retried with jittered exponential backoff, or after
 * the server's `Retry-After`, capped at `maxBackoff` seconds. `stop()` ends
 * iteration right away, aborting a pending longpoll or open stream.
 */
export class ChangesFeed implements AsyncIterable<Change> {
  since: string;
  private checkpoint?: string;
  private feed: "longpoll" | "continuous";
  private timeout: number;
  private batchSize: number;
  private maxRetries?: number;
  private maxBackoff: number;
  private sleep: (ms: number) => Promise<void>;
  private params: Record<string, any>;
  private stopped = false;
  private checkpointRev?: string;
  private controller?: AbortController;

  constructor(private db: ChangesSource, opts: ChangesFeedOptions = {}) {
    const { since = "0", checkpoint, feed = "longpoll", timeout = 60_000, batchSize = 500,
      maxRetries, maxBackoff = 30, sleep = realSleep, ...params } = opts;
    this.since = since;
    this.checkpoint = checkpoint;
    this.feed = feed;
    this.timeout = timeout;
    this.batchSize = batchSize;
    this.maxRetries = maxRetries;
    this.maxBackoff = maxBackoff;
    this.sleep = sleep;
    this.params = params;
  }

  /** Ends iteration now, aborting any request in flight. */
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }

  private signal(): AbortSignal {
    this.controller = new AbortController();
    return this.controller.signal;
  }

  private async backoff(attempt: number, err: unknown): Promise<void> {
    // jitter spreads out retries
    const delay = retryAfter(err) ?? (Math.random() * 0.5 + 0.5) * 2 ** attempt;
    await this.sleep(Math.min(this.maxBackoff, delay) * 1000);
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (this.stopped || !isTransient(err) || attempt === this.maxRetries) throw err;
        await this.backoff(attempt, err);
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
    this.stopped = false;
    if (this.checkpoint) await this.loadCheckpoint();
    try {
      if (this.feed === "continuous") {
        yield* this.stream();
        return;
      }
      while (!this.stopped) {
        let res: ChangesResult;
        try {
          res = await this.retry(() => this.db.changes({
            since: this.since, feed: "longpoll", timeout: this.timeout,
            limit: this.batchSize, ...this.params, signal: this.signal(),
          }));
        } catch (err) {
          if (this.stopped) return;
          throw err;
        }
        for (const change of res.results) {
          if (this.stopped) return;
          yield change;
        }
        if (res.lastSeq != null && res.lastSeq !== this.since) {
          this.since = res.lastSeq;
          if (this.checkpoint) await this.saveCheckpoint();
        }
      }
    } finally {
      this.controller?.abort();
    }
  }

  private async *stream(): AsyncGenerator<Change> {
    let pending = 0; // rows yielded since the last checkpoint save
    const flush = async () => {
      if (this.checkpoint && pending) {
        await this.saveCheckpoint();
        pending = 0;
      }
    };
    for (let attempt = 0; !this.stopped;) {
      try {
        const body = await this.db.continuousChanges(
          { since: this.since, heartbeat: 30_000, ...this.params }, this.signal());
        attempt = 0; // a good connection resets the backoff
        for await (const line of lines(body)) {
          if (!line.trim()) continue; // heartbeat
          const row = JSON.parse(line);
          if ("last_seq" in row) { // the server ended this stream
            if (row.last_seq != null) this.since = row.last_seq;
            break;
          }
          yield row as Change;
          if (row.seq != null) this.since = row.seq; // null with seqInterval
          pending++;
          if (this.stopped) break;
          if (pending >= this.batchSize) await flush();
        }
        await flush();
      } catch (err) {
        if (this.stopped) break;
        if (!isTransient(err) || attempt === this.maxRetries) throw err;
        await this.backoff(attempt, err);
        attempt++;
      }
    }
    await flush();
  }
}
