import { describe, it, expect } from "vitest";
import { ResponseError, FetchError } from "../couchdb_client/src";
import {
  CouchDBError, Unauthorized, Forbidden, NotFound, Conflict, PreconditionFailed,
  fromResponse, translate,
} from "../src/errors";

const jsonRes = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: "e", reason: "why" }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("fromResponse", () => {
  const table: [number, Function][] = [
    [401, Unauthorized], [403, Forbidden], [404, NotFound], [409, Conflict], [412, PreconditionFailed],
  ];
  it.each(table)("maps %i to subclass", async (status, cls) => {
    const err = await fromResponse(jsonRes(status));
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(CouchDBError);
    expect(err).toMatchObject({ status, error: "e", reason: "why" });
    expect(err.message).toBe(`${status} e: why`);
  });

  it("maps 500 to base class", async () => {
    const err = await fromResponse(jsonRes(500));
    expect(err.constructor).toBe(CouchDBError);
    expect(err).toMatchObject({ status: 500, error: "e", reason: "why" });
  });

  it("keeps non-JSON body in reason", async () => {
    const err = await fromResponse(new Response("<html>oops</html>", { status: 500 }));
    expect(err.status).toBe(500);
    expect(err.reason).toContain("oops");
  });

  it("carries headers with lowercase keys", async () => {
    const err = await fromResponse(jsonRes(429, { "Retry-After": "3" }));
    expect(err.headers["retry-after"]).toBe("3");
  });
});

describe("translate", () => {
  it("returns the value on success", async () => {
    expect(await translate(async () => 7)).toBe(7);
  });

  it("converts ResponseError to typed error", async () => {
    const res = new Response(JSON.stringify({ error: "conflict", reason: "x" }), { status: 409 });
    await expect(translate(async () => { throw new ResponseError(res); })).rejects.toBeInstanceOf(Conflict);
  });

  it("converts FetchError to status 0", async () => {
    const p = translate(async () => { throw new FetchError(new Error("boom")); });
    await expect(p).rejects.toMatchObject({ status: 0, error: "fetch_error" });
    await expect(p).rejects.toBeInstanceOf(CouchDBError);
  });

  it("rethrows unrelated errors", async () => {
    const e = new RangeError("nope");
    await expect(translate(async () => { throw e; })).rejects.toBe(e);
  });
});
