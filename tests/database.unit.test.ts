import { describe, it, expect, vi } from "vitest";
import { Configuration } from "../couchdb_client/src";
import { Database } from "../src/database";
import { Conflict } from "../src/errors";

const conflict = () => new Conflict(409, "conflict", "x");

function mkDb() {
  return new Database(new Configuration({ basePath: "http://unused" }), "d");
}

describe("Database.update", () => {
  it("retries on Conflict then saves the incremented doc", async () => {
    const db = mkDb();
    vi.spyOn(db, "get").mockImplementation(async () => ({ _id: "a", _rev: "1-x", n: 1 }));
    const save = vi.spyOn(db, "save")
      .mockRejectedValueOnce(conflict())
      .mockImplementation(async (d) => d);
    const out = await db.update("a", (d) => ({ ...d, n: d.n + 1 }));
    expect(out.n).toBe(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("gives up after retries", async () => {
    const db = mkDb();
    vi.spyOn(db, "get").mockResolvedValue({ _id: "a", _rev: "1-x" });
    const save = vi.spyOn(db, "save").mockRejectedValue(conflict());
    await expect(db.update("a", (d) => d, 3)).rejects.toBeInstanceOf(Conflict);
    expect(save).toHaveBeenCalledTimes(3);
  });
});
