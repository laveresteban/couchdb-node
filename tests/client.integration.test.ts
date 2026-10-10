import { afterEach, describe, expect, it } from "vitest";
import { CouchDB } from "../src/client";
import { PreconditionFailed, Unauthorized } from "../src/errors";
import { PASSWORD, URL, USER, serverUp, uniqueName } from "./helpers";

const up = await serverUp();

describe.skipIf(!up)("CouchDB client", () => {
  const created: string[] = [];
  const admin = new CouchDB(URL, USER, PASSWORD);

  afterEach(async () => {
    for (const n of created.splice(0)) await admin.deleteDatabase(n).catch(() => {});
  });

  it("server info, up, uuids", async () => {
    expect((await admin.info()).couchdb).toBe("Welcome");
    expect(await admin.up()).toBe(true);
    expect(new Set(await admin.uuids(3)).size).toBe(3);
  });

  it("database lifecycle", async () => {
    const n = uniqueName();
    created.push(n);
    await admin.createDatabase(n);
    expect(await admin.allDbs()).toContain(n);
    await expect(admin.createDatabase(n)).rejects.toBeInstanceOf(PreconditionFailed);
    await admin.deleteDatabase(n);
    expect(await admin.allDbs()).not.toContain(n);
  });

  it("database() returns a working handle", async () => {
    const n = uniqueName();
    created.push(n);
    const db = await admin.createDatabase(n);
    await db.save({ _id: "a", v: 1 });
    expect((await admin.database(n).get("a")).v).toBe(1);
  });

  it("replicate resolves bare names", async () => {
    const a = uniqueName("src"), b = uniqueName("dst");
    created.push(a, b);
    const src = await admin.createDatabase(a);
    await admin.createDatabase(b);
    await src.save({ _id: "x" });
    const res = await admin.replicate(a, b);
    expect(res.ok).toBe(true);
    expect((await admin.database(b).get("x"))._id).toBe("x");
  });

  it("sessions: bad login keeps cookie unchanged; good login/logout", async () => {
    const c = new CouchDB(URL); // no basic auth: identity comes from the cookie only
    expect((await c.session()).userCtx.name).toBeNull();
    await expect(c.login(uniqueName("ghost"), "wrong-password")).rejects.toBeInstanceOf(Unauthorized);
    expect((await c.session()).userCtx.name).toBeNull();
    await c.login(USER, PASSWORD);
    expect((await c.session()).userCtx.name).toBe(USER);
    // failed re-login must not clobber the valid cookie
    await expect(c.login(uniqueName("ghost"), "wrong-password")).rejects.toBeInstanceOf(Unauthorized);
    expect((await c.session()).userCtx.name).toBe(USER);
    await c.logout();
    expect((await c.session()).userCtx.name).toBeNull();
    c.close();
  });

  it("logs in again when the cookie session expires", async () => {
    const n = uniqueName();
    created.push(n);
    const db = await admin.createDatabase(n);
    await db.setSecurity(undefined, { names: [USER], roles: [] });
    // Shorten the server's session timeout to 1 s for this test.
    const cfg = `${URL}/_node/_local/_config/chttpd_auth/timeout`;
    const auth = { Authorization: "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64") };
    const prev = await fetch(cfg, { headers: auth });
    const old = prev.ok ? await prev.json() : undefined;
    await fetch(cfg, { method: "PUT", headers: auth, body: '"1"' });
    try {
      const c = new CouchDB(URL);
      await c.login(USER, PASSWORD);
      await new Promise((r) => setTimeout(r, 2500));
      expect((await c.database(n).info()).db_name).toBe(n);
    } finally {
      if (old === undefined) await fetch(cfg, { method: "DELETE", headers: auth });
      else await fetch(cfg, { method: "PUT", headers: auth, body: JSON.stringify(old) });
    }
  }, 15_000);
});

