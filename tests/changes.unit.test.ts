import { describe, it, expect, vi } from "vitest";
import { ChangesFeed } from "../src/changes";
import { CouchDBError, NotFound } from "../src/errors";

const batch = (id: string, seq: string) => ({ results: [{ id, seq }], lastSeq: seq });

function mkDb(changes = vi.fn(), continuousChanges = vi.fn()) {
  return { changes, continuousChanges, getLocal: vi.fn(), putLocal: vi.fn() };
}

/** A byte stream that sends each chunk, then ends (or errors, for an Error item). */
function stream(...chunks: (string | Error)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const queue = [...chunks];
  return new ReadableStream({
    pull(c) {
      const x = queue.shift();
      if (x === undefined) c.close();
      else if (x instanceof Error) c.error(x);
      else c.enqueue(enc.encode(x));
    },
  });
}

async function drain(feed: ChangesFeed) {
  const out: any[] = [];
  for await (const c of feed) out.push(c);
  return out;
}

describe("ChangesFeed", () => {
  it("retries transient 503, yields rows, then rejects on fatal NotFound", async () => {
    const changes = vi.fn()
      .mockRejectedValueOnce(new CouchDBError(503, "unavailable", "x"))
      .mockResolvedValueOnce(batch("a", "1"))
      .mockRejectedValueOnce(new NotFound(404, "not_found", "gone"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const feed = new ChangesFeed(mkDb(changes), { sleep });
    const got: any[] = [];
    await expect((async () => { for await (const c of feed) got.push(c); })()).rejects.toBeInstanceOf(NotFound);
    expect(got).toEqual([{ id: "a", seq: "1" }]);
    expect(feed.since).toBe("1");
    expect(sleep).toHaveBeenCalledTimes(1);
    const ms = sleep.mock.calls[0][0];
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThanOrEqual(1000);
  });

  it("gives up after maxRetries", async () => {
    const changes = vi.fn().mockRejectedValue(new CouchDBError(500, "e", "x"));
    const feed = new ChangesFeed(mkDb(changes), { maxRetries: 2, sleep: vi.fn().mockResolvedValue(undefined) });
    await expect(drain(feed)).rejects.toBeInstanceOf(CouchDBError);
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After", async () => {
    const changes = vi.fn()
      .mockRejectedValueOnce(new CouchDBError(429, "too_many", "x", { "retry-after": "7" }))
      .mockRejectedValueOnce(new NotFound(404, "not_found", "x"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(drain(new ChangesFeed(mkDb(changes), { sleep }))).rejects.toBeInstanceOf(NotFound);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("treats status-0 network errors as transient", async () => {
    const changes = vi.fn()
      .mockRejectedValueOnce(new CouchDBError(0, "fetch_error", "x"))
      .mockResolvedValueOnce(batch("a", "1"));
    const feed = new ChangesFeed(mkDb(changes), { sleep: vi.fn().mockResolvedValue(undefined) });
    const it = feed[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ id: "a", seq: "1" });
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("treats a FetchError as transient", async () => {
    const changes = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { name: "FetchError" }))
      .mockResolvedValueOnce(batch("a", "1"));
    const feed = new ChangesFeed(mkDb(changes), { sleep: vi.fn().mockResolvedValue(undefined) });
    expect((await feed[Symbol.asyncIterator]().next()).value).toEqual({ id: "a", seq: "1" });
  });

  it("does not retry a bare TypeError", async () => {
    const changes = vi.fn().mockRejectedValue(new TypeError("bug"));
    await expect(drain(new ChangesFeed(mkDb(changes)))).rejects.toBeInstanceOf(TypeError);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("passes poll params and extra options through", async () => {
    const changes = vi.fn().mockRejectedValueOnce(new NotFound(404, "n", "x"));
    await expect(drain(new ChangesFeed(mkDb(changes), { since: "5", batchSize: 10, timeout: 1000, includeDocs: true })))
      .rejects.toBeInstanceOf(NotFound);
    expect(changes).toHaveBeenCalledWith({
      since: "5", feed: "longpoll", timeout: 1000, limit: 10, includeDocs: true, signal: expect.any(AbortSignal) });
  });

  it("stop() ends iteration after the current batch", async () => {
    const changes = vi.fn().mockResolvedValue({ results: [{ id: "a", seq: "1" }, { id: "b", seq: "2" }], lastSeq: "2" });
    const feed = new ChangesFeed(mkDb(changes));
    const got: any[] = [];
    for await (const c of feed) { got.push(c); feed.stop(); }
    expect(got).toEqual([{ id: "a", seq: "1" }]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("loads and saves checkpoint, keeping _rev", async () => {
    const changes = vi.fn()
      .mockResolvedValueOnce(batch("a", "4"))
      .mockResolvedValueOnce(batch("b", "5"))
      .mockRejectedValueOnce(new NotFound(404, "n", "x"));
    const db = mkDb(changes);
    db.getLocal.mockResolvedValue({ since: "3", _rev: "0-1" });
    db.putLocal.mockResolvedValueOnce({ _rev: "0-2" }).mockResolvedValueOnce({ _rev: "0-3" });
    await expect(drain(new ChangesFeed(db, { checkpoint: "cp" }))).rejects.toBeInstanceOf(NotFound);
    expect(changes.mock.calls[0][0].since).toBe("3");
    expect(db.putLocal).toHaveBeenNthCalledWith(1, "cp", { since: "4", _rev: "0-1" });
    expect(db.putLocal).toHaveBeenNthCalledWith(2, "cp", { since: "5", _rev: "0-2" });
  });

  it("ignores a missing checkpoint", async () => {
    const db = mkDb(vi.fn().mockRejectedValueOnce(new NotFound(404, "n", "x")));
    db.getLocal.mockRejectedValue(new NotFound(404, "not_found", "missing"));
    await expect(drain(new ChangesFeed(db, { checkpoint: "cp" }))).rejects.toBeInstanceOf(NotFound);
    expect(db.changes.mock.calls[0][0].since).toBe("0");
  });

  it("stop() aborts a pending longpoll", async () => {
    let signal: AbortSignal | undefined;
    const changes = vi.fn((opts: any) => {
      signal = opts.signal;
      return new Promise((_, reject) => opts.signal.addEventListener("abort", () =>
        reject(new CouchDBError(0, "fetch_error", "aborted"))));
    });
    const feed = new ChangesFeed(mkDb(changes));
    const done = drain(feed);
    await vi.waitFor(() => expect(changes).toHaveBeenCalled());
    feed.stop();
    await expect(done).resolves.toEqual([]);
    expect(signal?.aborted).toBe(true);
  });

  it("continuous: yields rows split across chunks, skips heartbeats, keeps seq on null", async () => {
    const cont = vi.fn().mockResolvedValueOnce(stream(
      '{"seq":"1","id":"a"}\n\n{"seq":nu', 'll,"id":"b"}\n{"seq":"3","id":"c"}\n'));
    const feed = new ChangesFeed(mkDb(vi.fn(), cont), { feed: "continuous" });
    const got: string[] = [];
    for await (const c of feed) {
      got.push(c.id);
      if (c.id === "b") expect(feed.since).toBe("1");
      if (got.length === 3) feed.stop();
    }
    expect(got).toEqual(["a", "b", "c"]);
    expect(feed.since).toBe("3");
  });

  it("continuous: reconnects from the last seq after a dropped connection", async () => {
    const cont = vi.fn()
      .mockResolvedValueOnce(stream('{"seq":"1","id":"a"}\n', new CouchDBError(0, "fetch_error", "reset")))
      .mockResolvedValueOnce(stream('{"seq":"2","id":"b"}\n'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const feed = new ChangesFeed(mkDb(vi.fn(), cont), { feed: "continuous", sleep });
    const got: string[] = [];
    for await (const c of feed) {
      got.push(c.id);
      if (got.length === 2) feed.stop();
    }
    expect(got).toEqual(["a", "b"]);
    expect(cont.mock.calls[1][0].since).toBe("1");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("continuous: saves the checkpoint on stop", async () => {
    const db = mkDb(vi.fn(), vi.fn().mockResolvedValue(stream('{"seq":"7","id":"a"}\n')));
    db.getLocal.mockRejectedValue(new NotFound(404, "not_found", "missing"));
    db.putLocal.mockResolvedValue({ _rev: "0-1" });
    const feed = new ChangesFeed(db, { feed: "continuous", checkpoint: "cp" });
    for await (const _ of feed) feed.stop();
    expect(db.putLocal).toHaveBeenCalledWith("cp", { since: "7" });
  });
});
