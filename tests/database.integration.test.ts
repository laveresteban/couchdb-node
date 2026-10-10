import { afterAll, describe, expect, it } from "vitest";
import { DatabasesApi } from "../couchdb_client/src";
import { Database } from "../src/database";
import { Conflict, NotFound } from "../src/errors";
import { makeConfig, serverUp, uniqueName } from "./helpers";

const up = await serverUp();
const created: string[] = [];

async function mkdb(partitioned = false): Promise<Database> {
  const name = uniqueName("nodesdk");
  await new DatabasesApi(makeConfig()).putDatabase({ db: name, partitioned });
  created.push(name);
  return new Database(makeConfig(), name);
}

describe.skipIf(!up)("Database (live CouchDB)", () => {
  afterAll(async () => {
    const api = new DatabasesApi(makeConfig());
    for (const db of created) await api.deleteDatabase({ db }).catch(() => {});
  });

  it("save tracks revisions, get/remove/has", async () => {
    const db = await mkdb();
    const doc = await db.save({ _id: "a", n: 1 });
    expect(doc._rev).toMatch(/^1-/);
    doc.n = 2;
    expect((await db.save(doc))._rev).toMatch(/^2-/);
    expect((await db.get("a")).n).toBe(2);
    expect(await db.has("a")).toBe(true);
    await db.remove("a");
    expect(await db.has("a")).toBe(false);
    expect(await db.exists()).toBe(true);
  });

  it("writes the user doc verbatim (no alias pollution/clobbering)", async () => {
    const db = await mkdb();
    await db.save({ _id: "x", id: "mine", rev: "r", n: 1 });
    const got = await db.get("x");
    expect(got.id).toBe("mine");
    expect(got.rev).toBe("r");
    expect(got.n).toBe(1);
    await db.save({ _id: "y" });
    expect(await db.get("y")).not.toHaveProperty("id");
    await db.bulkSave([{ _id: "z", id: "b" }]);
    expect((await db.get("z")).id).toBe("b");
  });

  it("stale-rev save rejects with Conflict", async () => {
    const db = await mkdb();
    const doc = await db.save({ _id: "a", n: 1 });
    const stale = { ...doc };
    await db.save({ ...doc, n: 2 });
    await expect(db.save(stale)).rejects.toBeInstanceOf(Conflict);
  });

  it("create without id, bulkSave, allDocs, update", async () => {
    const db = await mkdb();
    const d = await db.save({ x: 1 });
    expect(d._id).toBeTruthy();
    expect((await db.get(d._id)).x).toBe(1);
    const res = await db.bulkSave([{ _id: "b1" }, { _id: "b2" }]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await db.allDocs()).toHaveLength(3);
    const u = await db.update("b1", (x) => ({ ...x, v: 9 }));
    expect(u.v).toBe(9);
  });

  it("find with $gt, sort desc, index, bookmark pagination", async () => {
    const db = await mkdb();
    await db.bulkSave(Array.from({ length: 6 }, (_, i) => ({ _id: `d${i}`, n: i })));
    await db.createIndex(["n"], "n-idx");
    expect((await db.indexes()).some((i) => i.name === "n-idx")).toBe(true);
    const r = await db.find({ n: { $gt: 2 } }, { sort: [{ n: "desc" }], fields: ["n"] });
    expect(r.docs.map((d) => d.n)).toEqual([5, 4, 3]);
    const p1 = await db.find({ n: { $gte: 0 } }, { limit: 4 });
    const p2 = await db.find({ n: { $gte: 0 } }, { limit: 4, bookmark: p1.bookmark });
    expect(p1.docs).toHaveLength(4);
    expect(p2.docs).toHaveLength(2);
  });

  it("design views map+reduce, delete design", async () => {
    const db = await mkdb();
    await db.bulkSave([{ _id: "a", n: 1 }, { _id: "b", n: 2 }]);
    await db.saveDesign("d", { sum: { map: "function(d){emit(d._id, d.n)}", reduce: "_sum" } });
    expect((await db.view("d", "sum", { reduce: false })).map((r) => r.value)).toEqual([1, 2]);
    expect((await db.view("d", "sum"))[0].value).toBe(3);
    await db.saveDesign("d", { sum: { map: "function(d){emit(d._id, d.n)}" } }); // update existing
    await db.deleteDesign("d");
    await expect(db.design("d")).rejects.toBeInstanceOf(NotFound);
  });

  it("attachments: text, binary byte-identical, listed, delete", async () => {
    const db = await mkdb();
    await db.putAttachment("doc", "t.txt", new TextEncoder().encode("héllo"), "text/plain");
    expect(new TextDecoder().decode(await db.getAttachment("doc", "t.txt"))).toBe("héllo");
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await db.putAttachment("doc", "b", bytes, "application/octet-stream");
    const got = await db.getAttachment("doc", "b");
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got)).toEqual([0, 1, 2, 255]);
    const att = (await db.get("doc"))._attachments;
    expect(Object.keys(att).sort()).toEqual(["b", "t.txt"]);
    expect(att["t.txt"].content_type).toBe("text/plain");
    await db.deleteAttachment("doc", "b");
    expect(Object.keys((await db.get("doc"))._attachments)).toEqual(["t.txt"]);
  });

  it("security and local docs", async () => {
    const db = await mkdb();
    await db.setSecurity(undefined, { names: ["alice"], roles: [] });
    expect((await db.security()).members.names).toEqual(["alice"]);
    const l = await db.putLocal("cp", { seq: "5" });
    expect(l._rev).toMatch(/^0-/);
    expect((await db.getLocal("cp")).seq).toBe("5");
  });

  it("changes: GET, doc_ids POST, selector POST", async () => {
    const db = await mkdb();
    await db.bulkSave([{ _id: "a", t: 1 }, { _id: "b", t: 2 }, { _id: "c", t: 1 }]);
    const all = await db.changes();
    expect(all.results).toHaveLength(3);
    expect(all.lastSeq).toBeTruthy();
    expect((await db.changes({ docIds: ["a", "c"] })).results.map((c) => c.id).sort()).toEqual(["a", "c"]);
    expect((await db.changes({ selector: { t: 2 } })).results.map((c) => c.id)).toEqual(["b"]);
  });

  it("partition allDocs + find", async () => {
    const db = await mkdb(true);
    await db.bulkSave([{ _id: "p1:a", v: 1 }, { _id: "p1:b", v: 2 }, { _id: "p2:c", v: 3 }]);
    const part = db.partition("p1");
    expect((await part.allDocs()).map((r) => r.id)).toEqual(["p1:a", "p1:b"]);
    expect((await part.find({ v: { $gt: 1 } })).docs.map((d) => d._id)).toEqual(["p1:b"]);
  });

  it("follow() yields changes", async () => {
    const db = await mkdb();
    await db.save({ _id: "a" });
    const feed = db.follow({ timeout: 1000 });
    for await (const c of feed) {
      expect(c.id).toBe("a");
      feed.stop();
    }
  });

  it("bulkSave sets revisions on the docs it saved", async () => {
    const db = await mkdb();
    const docs: any[] = [{ _id: "a" }, { v: 1 }];
    await db.bulkSave(docs);
    expect(docs.every((d) => d._rev.startsWith("1-"))).toBe(true);
    await db.bulkSave(docs); // same list again is an update, not a conflict
    expect(docs.every((d) => d._rev.startsWith("2-"))).toBe(true);
  });

  it("replication primitives", async () => {
    const db = await mkdb();
    await db.save({ _id: "a", v: 1 });
    const { _rev } = await db.update("a", (d) => ({ ...d, v: 2 }));
    expect((await db.revsDiff({ a: [_rev, "9-x"] })).a.missing).toEqual(["9-x"]);

    const res = await db.bulkGet([{ id: "a" }, { id: "zz" }], { revs: true });
    expect(res[0].docs[0].ok.v).toBe(2);
    expect(res[0].docs[0].ok._revisions.ids).toHaveLength(2);
    expect(res[1].docs[0].error.error).toBe("not_found");

    await db.bulkSave([{ _id: "x", _rev: "1-aaa", v: 1 }], { newEdits: false });
    expect((await db.get("x"))._rev).toBe("1-aaa");
    expect((await db.get("x", { revs: true }))._revisions.ids).toEqual(["aaa"]);

    await db.putLocal("cp", { seq: "1" });
    await db.deleteLocal("cp");
    await expect(db.getLocal("cp")).rejects.toBeInstanceOf(NotFound);
  });

  it("find accepts CouchDB's snake_case options", async () => {
    const db = await mkdb();
    await db.bulkSave([{ v: 1 }, { v: 2 }]);
    await db.createIndex(["v"], "v-idx", { ddoc: "idx" });
    const res = await db.find({ v: { $gt: 0 } }, { use_index: ["idx", "v-idx"], sort: [{ v: "desc" }] });
    expect(res.docs.map((d) => d.v)).toEqual([2, 1]);
    expect(res.warning).toBeUndefined();
  });

  it("follow({ feed: 'continuous' }) streams live writes, filtered by selector", async () => {
    const db = await mkdb();
    const feed = db.follow({ feed: "continuous", selector: { t: 2 }, heartbeat: 1000 });
    const it = feed[Symbol.asyncIterator]();
    const next = it.next();
    await db.bulkSave([{ _id: "a", t: 1 }, { _id: "b", t: 2 }]);
    expect((await next).value.id).toBe("b");
    feed.stop();
    expect((await it.next()).done).toBe(true);
  });

  it("stop() ends a pending longpoll right away", async () => {
    const db = await mkdb();
    const feed = db.follow({ since: "now", timeout: 60_000 });
    const started = Date.now();
    const done = (async () => { for await (const _ of feed) { /* none */ } })();
    await new Promise((r) => setTimeout(r, 200));
    feed.stop();
    await done;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("head and conditional get", async () => {
    const db = await mkdb();
    const { _rev } = await db.save({ _id: "a", v: 1 });
    expect(await db.head("a")).toBe(_rev);
    expect(await db.head("missing")).toBeNull();
    expect(await db.getIfChanged("a", _rev)).toBeNull();
    await db.update("a", (d) => ({ ...d, v: 2 }));
    expect((await db.getIfChanged("a", _rev))?.v).toBe(2);
  });

  it("listings, explain and key ranges", async () => {
    const db = await mkdb();
    await db.saveDesign("stats", { by_v: { map: "function(d){ emit(d.v, 1); }" } });
    await db.putLocal("cp", { seq: "1" });
    expect((await db.designDocs()).map((r) => r.id)).toEqual(["_design/stats"]);
    expect((await db.localDocs()).map((r) => r.id)).toEqual(["_local/cp"]);
    await db.bulkSave([{ v: 0 }, { v: 1 }, { v: 2 }]);
    await db.createIndex(["v"], "v-idx");
    expect((await db.explain({ v: { $gt: 0 } })).index.name).toBe("v-idx");
    expect(await db.view("stats", "by_v", { startKey: 1 })).toHaveLength(2);
  });

  it("purge, compact and view cleanup", async () => {
    const db = await mkdb();
    const { _rev } = await db.save({ _id: "a" });
    expect(await db.purge({ a: [_rev] })).toEqual({ a: [_rev] });
    expect(await db.has("a")).toBe(false);
    await db.compact();
    await db.viewCleanup();
  });
});

