/**
 * TypeScript implementation of the shared CouchDB SDK conformance steps.
 * Step text lives in couchdb-sdk-generator/conformance/specs; this binds it to the SDK.
 */
import { randomBytes } from "crypto";
import { AfterScenario, Step } from "gauge-ts";
import { CouchDB, CouchDBError, Database, NotFound } from "../../src";

const URL = process.env.COUCHDB_URL ?? "http://localhost:5984";
const USER = process.env.COUCHDB_USER ?? "admin";
const PASSWORD = process.env.COUCHDB_PASSWORD ?? "password";

// Per-scenario state, reset in afterScenario.
const s: { couch?: CouchDB; db?: Database; cleanup: string[]; [k: string]: any } = { cleanup: [] };

const couch = () => s.couch!;
const db = () => s.db!;
const ints = (csv: string) => csv.split(",").filter(Boolean).map(Number);
const eq = (a: unknown, b: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};
const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const sorted = (a: any[]) => [...a].sort();

function newName(): string {
  const name = `conformance_${randomBytes(6).toString("hex")}`;
  s.cleanup.push(name);
  return name;
}

async function assertStatus(status: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof CouchDBError)) throw err;
    ok(err.status === Number(status), `expected ${status}, got ${err.status} (${err.message})`);
    return;
  }
  throw new Error(`expected HTTP ${status}, but the call succeeded`);
}

export default class Steps {
  @AfterScenario()
  async cleanup() {
    const admin = new CouchDB(URL, USER, PASSWORD);
    try {
      for (const name of s.cleanup) {
        if (await admin.database(name).exists()) await admin.deleteDatabase(name);
      }
    } finally {
      for (const k of Object.keys(s)) delete s[k];
      s.cleanup = [];
    }
  }

  // -- connections
  @Step("Connect anonymously")
  async connectAnonymously() { s.couch = new CouchDB(URL); }

  @Step("Connect as admin")
  async connectAsAdmin() { s.couch = new CouchDB(URL, USER, PASSWORD); }

  // -- server
  @Step("Server information reports <welcome>")
  async serverInfo(welcome: string) { eq((await couch().info()).couchdb, welcome); }

  @Step("Server is up")
  async serverUp() { ok(await couch().up(), "server not up"); }

  @Step("Request <count> UUIDs and receive <unique> unique values")
  async uuids(count: string, unique: string) {
    eq(new Set(await couch().uuids(Number(count))).size, Number(unique));
  }

  // -- authentication
  @Step("Log in with the admin credentials")
  async logIn() { await couch().login(USER, PASSWORD); }

  @Step("The session user is the admin user")
  async sessionAdmin() { eq((await couch().session()).userCtx.name, USER); }

  @Step("Log out")
  async logOut() { await couch().logout(); }

  @Step("The session user is anonymous")
  async sessionAnonymous() { eq((await couch().session()).userCtx.name, null); }

  @Step("Logging in with password <password> fails with status <status>")
  async loginFails(password: string, status: string) {
    await assertStatus(status, () => couch().login(USER, password));
  }

  // -- databases
  @Step("Create a fresh database")
  async createDatabase() { s.db = await couch().createDatabase(newName()); }

  @Step("Create a fresh partitioned database")
  async createPartitioned() { s.db = await couch().createDatabase(newName(), true); }

  @Step("The database exists")
  async dbExists() { ok(await db().exists(), "database missing"); }

  @Step("The database does not exist")
  async dbMissing() { ok(!(await db().exists()), "database exists"); }

  @Step("The database is listed among all databases")
  async dbListed() { ok((await couch().allDbs()).includes(db().name), "database not listed"); }

  @Step("The database has <count> documents")
  async dbDocCount(count: string) { eq((await db().info()).doc_count, Number(count)); }

  @Step("Delete the database")
  async deleteDatabase() { await couch().deleteDatabase(db().name); }

  @Step("Creating the same database again fails with status <status>")
  async createAgainFails(status: string) {
    await assertStatus(status, () => couch().createDatabase(db().name));
  }

  // -- documents
  @Step("Save document <docid> with field <field> = <value>")
  async saveDocument(docid: string, field: string, value: string) {
    await db().save({ _id: docid, [field]: value });
  }

  @Step("Document <docid> has field <field> = <value>")
  async documentHasField(docid: string, field: string, value: string) {
    eq((await db().get(docid))[field], value);
  }

  @Step("Update document <docid> setting field <field> = <value>")
  async updateDocument(docid: string, field: string, value: string) {
    await db().update(docid, (d) => ({ ...d, [field]: value }));
  }

  @Step("Document <docid> has a revision starting with <prefix>")
  async revisionPrefix(docid: string, prefix: string) {
    const rev = (await db().get(docid))._rev as string;
    ok(rev.startsWith(prefix), `revision ${rev} does not start with ${prefix}`);
  }

  @Step("Delete document <docid>")
  async deleteDocument(docid: string) { await db().remove(docid); }

  @Step("Document <docid> does not exist")
  async documentMissing(docid: string) { ok(!(await db().has(docid)), `document ${docid} exists`); }

  @Step("Remember the revision of document <docid>")
  async rememberRevision(docid: string) { s.rev = (await db().get(docid))._rev; }

  @Step("Saving document <docid> with the remembered revision fails with status <status>")
  async staleSaveFails(docid: string, status: string) {
    await assertStatus(status, () => db().save({ _id: docid, _rev: s.rev }));
  }

  @Step("Create a document without an id with field <field> = <value>")
  async createWithoutId(field: string, value: string) {
    s.created = (await db().save({ [field]: value }))._id;
  }

  @Step("The created document can be read back with field <field> = <value>")
  async readCreated(field: string, value: string) {
    eq((await db().get(s.created))[field], value);
  }

  @Step("Bulk save <count> documents with field <field> = <value>")
  async bulkSave(count: string, field: string, value: string) {
    const docs = Array.from({ length: Number(count) }, () => ({ [field]: value }));
    const results = await db().bulkSave(docs);
    ok(results.every((r) => r.ok), JSON.stringify(results));
  }

  @Step("All documents lists <count> rows")
  async allDocsRows(count: string) { eq((await db().allDocs()).length, Number(count)); }

  // -- Mango queries
  @Step("Bulk save documents with ages <ages>")
  async bulkSaveAges(ages: string) { await db().bulkSave(ints(ages).map((age) => ({ age }))); }

  @Step("Finding documents with age greater than <age> returns ages <ages>")
  async findAges(age: string, ages: string) {
    const res = await db().find({ age: { $gt: Number(age) } });
    eq(res.docs.map((d) => d.age).sort((a, b) => a - b), ints(ages).sort((a, b) => a - b));
  }

  @Step("Create a json index on field <field> named <name>")
  async createIndex(field: string, name: string) { await db().createIndex([field], name); }

  @Step("The index <name> is listed")
  async indexListed(name: string) {
    ok((await db().indexes()).some((i) => i.name === name), `index ${name} not listed`);
  }

  @Step("Finding documents with age greater than <age> sorted descending returns ages <ages>")
  async findSorted(age: string, ages: string) {
    const res = await db().find({ age: { $gt: Number(age) } }, { sort: [{ age: "desc" }] as any });
    eq(res.docs.map((d) => d.age), ints(ages));
  }

  @Step("Finding documents with age greater than <age> with limit <limit> returns <count> documents and a bookmark")
  async findPage(age: string, limit: string, count: string) {
    s.pageQuery = [{ age: { $gt: Number(age) } }, Number(limit)];
    const res = await db().find(s.pageQuery[0], { limit: Number(limit) });
    ok(res.docs.length === Number(count) && !!res.bookmark, `got ${res.docs.length} docs, bookmark ${res.bookmark}`);
    s.bookmark = res.bookmark;
    s.seen = new Set(res.docs.map((d) => d._id));
  }

  @Step("Continuing from the bookmark returns <count> more documents")
  async findNextPage(count: string) {
    const [selector, limit] = s.pageQuery;
    const res = await db().find(selector, { limit, bookmark: s.bookmark });
    const ids = new Set(res.docs.map((d) => d._id));
    ok(ids.size === Number(count) && ![...ids].some((i) => s.seen.has(i)), `got ${[...ids]}`);
  }

  // -- design documents and views
  @Step("Save design document <ddoc> with view <view> emitting age and reducing with <reduce>")
  async saveDesign(ddoc: string, view: string, reduce: string) {
    await db().saveDesign(ddoc, { [view]: { map: "function (doc) { emit(doc.age, doc.age); }", reduce } });
  }

  @Step("Design document <ddoc> has view <view>")
  async designHasView(ddoc: string, view: string) {
    ok(view in (await db().design(ddoc)).views, `view ${view} missing`);
  }

  @Step("Querying view <path> without reduce returns <count> rows")
  async viewRows(path: string, count: string) {
    const [ddoc, view] = path.split("/");
    eq((await db().view(ddoc, view, { reduce: false })).length, Number(count));
  }

  @Step("Querying view <path> with reduce returns the value <value>")
  async viewReduce(path: string, value: string) {
    const [ddoc, view] = path.split("/");
    const rows = await db().view(ddoc, view, { reduce: true });
    eq(rows[0].value, Number(value));
  }

  @Step("Delete design document <ddoc>")
  async deleteDesign(ddoc: string) { await db().deleteDesign(ddoc); }

  @Step("Design document <ddoc> does not exist")
  async designMissing(ddoc: string) {
    try {
      await db().design(ddoc);
    } catch (e) {
      if (e instanceof NotFound) return;
      throw e;
    }
    throw new Error(`design document ${ddoc} still exists`);
  }

  // -- attachments
  @Step("Attach <data> as <name> to document <docid>")
  async attach(data: string, name: string, docid: string) {
    await db().putAttachment(docid, name, new TextEncoder().encode(data), "text/plain");
  }

  @Step("Attachment <name> of document <docid> contains <data>")
  async attachmentContains(name: string, docid: string, data: string) {
    eq(new TextDecoder().decode(await db().getAttachment(docid, name)), data);
  }

  @Step("Document <docid> lists attachment <name>")
  async documentListsAttachment(docid: string, name: string) {
    ok(name in ((await db().get(docid))._attachments ?? {}), `attachment ${name} not listed`);
  }

  @Step("Delete attachment <name> from document <docid>")
  async deleteAttachment(name: string, docid: string) { await db().deleteAttachment(docid, name); }

  @Step("Attachment <name> of document <docid> does not exist")
  async attachmentMissing(name: string, docid: string) {
    try {
      await db().getAttachment(docid, name);
    } catch (e) {
      if (e instanceof NotFound) return;
      throw e;
    }
    throw new Error(`attachment ${name} still exists`);
  }

  // -- changes
  @Step("The changes feed lists documents <ids>")
  async changesList(ids: string) {
    eq(sorted((await db().changes()).results.map((r) => r.id)), sorted(ids.split(",")));
  }

  @Step("Remember the current update sequence")
  async rememberSeq() { s.seq = (await db().changes()).lastSeq; }

  @Step("The changes feed since the remembered sequence lists documents <ids>")
  async changesSince(ids: string) {
    const got = (await db().changes({ since: s.seq })).results.map((r) => r.id);
    eq(sorted(got), sorted(ids.split(",")));
  }

  @Step("The changes feed marks document <docid> as deleted")
  async changesDeleted(docid: string) {
    const rows = (await db().changes()).results.filter((r) => r.id === docid);
    ok(rows.length > 0 && rows[rows.length - 1].deleted === true, JSON.stringify(rows));
  }

  @Step("The changes feed filtered to documents <ids> lists documents <expected>")
  async changesDocIds(ids: string, expected: string) {
    const got = (await db().changes({ docIds: ids.split(",") })).results.map((r) => r.id);
    eq(sorted(got), sorted(expected.split(",")));
  }

  @Step("Follow the changes feed with checkpoint <name> until document <docid>")
  async followUntil(name: string, docid: string) {
    const feed = db().follow({ checkpoint: name, timeout: 1000 });
    for await (const row of feed) {
      if (row.id === docid) feed.stop();
    }
  }

  @Step("Following the changes feed with checkpoint <name> next yields document <docid>")
  async followNext(name: string, docid: string) {
    const it = db().follow({ checkpoint: name, timeout: 1000 })[Symbol.asyncIterator]();
    const { value } = await it.next();
    await it.return?.();
    eq(value?.id, docid);
  }

  // -- security
  @Step("Set the database members to user <user>")
  async setMembers(user: string) { await db().setSecurity(undefined, { names: [user], roles: [] }); }

  @Step("The database members include user <user>")
  async membersInclude(user: string) {
    ok((await db().security()).members.names.includes(user), `${user} not a member`);
  }

  @Step("Anonymous access to the database fails with status <status>")
  async anonymousDenied(status: string) {
    await assertStatus(status, () => new CouchDB(URL).database(db().name).info());
  }

  // -- partitions
  @Step("All documents in partition <partition> lists <count> rows")
  async partitionAllDocs(partition: string, count: string) {
    eq((await db().partition(partition).allDocs()).length, Number(count));
  }

  @Step("Finding in partition <partition> for field <field> = <value> returns <count> documents")
  async partitionFind(partition: string, field: string, value: string, count: string) {
    eq((await db().partition(partition).find({ [field]: value })).docs.length, Number(count));
  }

  // -- replication
  @Step("Replicate the database to a new database")
  async replicate() {
    s.replica = newName();
    await couch().replicate(db().name, s.replica, { createTarget: true });
  }

  @Step("The replica has <count> documents")
  async replicaCount(count: string) {
    eq((await couch().database(s.replica).info()).doc_count, Number(count));
  }
}
