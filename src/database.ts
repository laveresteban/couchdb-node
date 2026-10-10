import {
  AttachmentsApi, ChangesApi, Configuration, DatabasesApi, DesignDocumentsApi, DocumentsApi,
  MaintenanceApi, PartitionsApi, QueryApi, ReplicationApi, SecurityApi,
} from "../couchdb_client/src";
import type { AllDocsQuery, FindQuery, ViewQuery } from "../couchdb_client/src";
import { ChangesFeed } from "./changes";
import type { ChangesFeedOptions, ChangesSource } from "./changes";
import { Conflict, CouchDBError, NotFound, translate } from "./errors";
import type { Change, ChangesResult, Doc, FindResult } from "./types";

export type Row = Record<string, any>;
export type QueryOptions = Partial<AllDocsQuery>;
export type FindOptions = Partial<Omit<FindQuery, "selector">>;
export type ViewOptions = Partial<ViewQuery>;

export interface ChangesOptions {
  since?: string;
  feed?: string;
  includeDocs?: boolean;
  conflicts?: boolean;
  attachments?: boolean;
  style?: string;
  filter?: string;
  view?: string;
  limit?: number;
  timeout?: number;
  heartbeat?: number;
  seqInterval?: number;
  descending?: boolean;
  docIds?: string[];
  selector?: Doc;
  /** Aborts the request (e.g. a pending longpoll). */
  signal?: AbortSignal;
}

export interface GetOptions {
  rev?: string;
  revsInfo?: boolean;
  conflicts?: boolean;
  /** Include the revision history as `_revisions`. */
  revs?: boolean;
  /** With `rev`, return the latest leaf on that branch. */
  latest?: boolean;
}

/** Options for `designDocs()` / `localDocs()`. Keys take plain values; they're JSON-encoded here. */
export interface ListOptions {
  includeDocs?: boolean;
  startKey?: unknown;
  endKey?: unknown;
  limit?: number;
  skip?: number;
  descending?: boolean;
}

const listParams = ({ startKey, endKey, ...rest }: ListOptions) => ({
  ...rest,
  ...(startKey !== undefined ? { startKey: JSON.stringify(startKey) } : {}),
  ...(endKey !== undefined ? { endKey: JSON.stringify(endKey) } : {}),
});

/** One `_bulk_get` request entry. */
export interface BulkGetItem {
  id: string;
  rev?: string;
  atts_since?: string[];
}

// CouchDB's own snake_case names are accepted alongside camelCase.
const snake = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));

// Send the user's JSON verbatim: the generated Document serializer adds/clobbers alias fields
// (id, rev, ...). The override runs after the generated body is built and replaces it; the
// runtime then JSON.stringifies it (Content-Type is JSON), so pass the object, not a string.
const verbatim = (body: unknown) => () => Promise.resolve({ body: body as any });

// Raw JSON body avoids the generated models adding alias fields to user docs.
function json<T = any>(call: () => Promise<{ raw: Response }>): Promise<T> {
  return translate(async () => (await call()).raw.json());
}

function findResult(res: any): FindResult {
  return { docs: res.docs, bookmark: res.bookmark, warning: res.warning };
}

export class Partition {
  constructor(private database: Database, public name: string) {}

  async allDocs(query: QueryOptions = {}): Promise<Row[]> {
    const res = await json(() => this.database._partitions.postPartitionAllDocsRaw({
      db: this.database.name, partition: this.name, allDocsQuery: query }));
    return res.rows ?? [];
  }

  async find(selector: Doc, opts: FindOptions = {}): Promise<FindResult> {
    const body = { selector, ...snake(opts) };
    return findResult(await json(() => this.database._partitions.postPartitionFindRaw({
      db: this.database.name, partition: this.name, findQuery: body as any }, verbatim(body))));
  }
}

/** A CouchDB database. Documents are plain objects; `save` keeps `_id`/`_rev` current. */
export class Database implements ChangesSource {
  /** @internal */ _partitions: PartitionsApi;
  private dbs: DatabasesApi;
  private docs: DocumentsApi;
  private queryApi: QueryApi;
  private designApi: DesignDocumentsApi;
  private attachments: AttachmentsApi;
  private changesApi: ChangesApi;
  private securityApi: SecurityApi;
  private replication: ReplicationApi;
  private maintenance: MaintenanceApi;

  constructor(config: Configuration, public name: string) {
    this.dbs = new DatabasesApi(config);
    this.docs = new DocumentsApi(config);
    this.queryApi = new QueryApi(config);
    this.designApi = new DesignDocumentsApi(config);
    this.attachments = new AttachmentsApi(config);
    this.changesApi = new ChangesApi(config);
    this.securityApi = new SecurityApi(config);
    this._partitions = new PartitionsApi(config);
    this.replication = new ReplicationApi(config);
    this.maintenance = new MaintenanceApi(config);
  }

  // -- database ---------------------------------------------------------
  info(): Promise<Row> {
    return json(() => this.dbs.getDatabaseInformationRaw({ db: this.name }));
  }

  async exists(): Promise<boolean> {
    try {
      await this.info();
      return true;
    } catch (e) {
      if (e instanceof NotFound) return false;
      throw e;
    }
  }

  // -- documents --------------------------------------------------------
  get(docid: string, params: GetOptions = {}): Promise<Doc> {
    return json(() => this.docs.getDocumentRaw({ db: this.name, docid, ...params }));
  }

  /** The doc's current revision without downloading it, or null if it doesn't exist. */
  async head(docid: string): Promise<string | null> {
    try {
      const res = await translate(() => this.docs.headDocumentRaw({ db: this.name, docid }));
      return res.raw.headers.get("etag")?.replace(/"/g, "") || null;
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
  }

  /** The doc, or null if it still matches `etag` (its rev, quoted or not). */
  async getIfChanged(docid: string, etag: string): Promise<Doc | null> {
    const ifNoneMatch = etag.startsWith('"') ? etag : `"${etag}"`;
    try {
      return await json(() => this.docs.getDocumentRaw({ db: this.name, docid, ifNoneMatch }));
    } catch (e) {
      if (e instanceof CouchDBError && e.status === 304) return null; // non-2xx throws
      throw e;
    }
  }

  /** Create or update `doc` in place, setting its `_id` and `_rev`. */
  async save(doc: Doc): Promise<Doc> {
    const ov = verbatim(doc);
    const res = await translate(() => doc._id != null
      ? this.docs.putDocument({ db: this.name, docid: doc._id, document: doc as any }, ov)
      : this.docs.postDocument({ db: this.name, document: doc as any }, ov));
    doc._id = res.id;
    doc._rev = res.rev;
    return doc;
  }

  async remove(docOrId: Doc | string): Promise<void> {
    const doc = typeof docOrId === "string" ? await this.get(docOrId) : docOrId;
    await translate(() => this.docs.deleteDocument({ db: this.name, docid: doc._id, rev: doc._rev }));
  }

  /** Apply `fn` to the latest revision, retrying on conflicts. */
  async update(docid: string, fn: (doc: Doc) => Doc | Promise<Doc>, retries = 5): Promise<Doc> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.save(await fn(await this.get(docid)));
      } catch (e) {
        if (!(e instanceof Conflict) || attempt >= retries - 1) throw e;
      }
    }
  }

  /**
   * Write many docs at once. Docs that were saved get their new `_id`/`_rev`.
   * With `newEdits: false` the docs keep the `_rev` (and `_revisions`) you
   * give them, the way a replicator writes; CouchDB then only reports failures.
   */
  async bulkSave(docs: Doc[], opts: { newEdits?: boolean } = {}): Promise<Row[]> {
    const body: Doc = { docs };
    if (opts.newEdits === false) body.new_edits = false;
    const rows: Row[] = await json(() => this.docs.postBulkDocsRaw(
      { db: this.name, bulkDocs: body as any }, verbatim(body)));
    if (opts.newEdits !== false) {
      docs.forEach((doc, i) => {
        const row = rows[i];
        if (row?.rev && !row.error) {
          doc._id = row.id;
          doc._rev = row.rev;
        }
      });
    }
    return rows;
  }

  async has(docid: string): Promise<boolean> {
    try {
      await this.get(docid);
      return true;
    } catch (e) {
      if (e instanceof NotFound) return false;
      throw e;
    }
  }

  // -- queries ----------------------------------------------------------
  async allDocs(query: QueryOptions = {}): Promise<Row[]> {
    const res = await json(() => this.queryApi.postAllDocsRaw({ db: this.name, allDocsQuery: query }));
    return res.rows ?? [];
  }

  async find(selector: Doc, opts: FindOptions | Record<string, any> = {}): Promise<FindResult> {
    const body = { selector, ...snake(opts) };
    return findResult(await json(() => this.queryApi.postFindRaw({
      db: this.name, findQuery: body as any }, verbatim(body))));
  }

  /** The plan for a Mango query: which index it uses, and the options applied. */
  explain(selector: Doc, opts: FindOptions | Record<string, any> = {}): Promise<Row> {
    const body = { selector, ...snake(opts) };
    return json(() => this.queryApi.postExplainRaw({ db: this.name, findQuery: body as any }, verbatim(body)));
  }

  async designDocs(opts: ListOptions = {}): Promise<Row[]> {
    return (await json(() => this.queryApi.getDesignDocsRaw({ db: this.name, ...listParams(opts) }))).rows ?? [];
  }

  /** Rows for the `_local` documents (checkpoints). */
  async localDocs(opts: ListOptions = {}): Promise<Row[]> {
    return (await json(() => this.queryApi.getLocalDocsRaw({ db: this.name, ...listParams(opts) }))).rows ?? [];
  }

  createIndex(fields: string[], name?: string, opts: Record<string, any> = {}): Promise<Row> {
    const { partialFilterSelector, partial_filter_selector, ...rest } = opts;
    const pfs = partialFilterSelector ?? partial_filter_selector;
    const body = {
      index: { fields, ...(pfs ? { partial_filter_selector: pfs } : {}) },
      ...(name ? { name } : {}), ...snake(rest),
    };
    return json(() => this.queryApi.postIndexRaw(
      { db: this.name, indexDefinitionRequest: body as any }, verbatim(body)));
  }

  async indexes(): Promise<Row[]> {
    return (await json(() => this.queryApi.getIndexesRaw({ db: this.name }))).indexes;
  }

  // -- design documents and views ---------------------------------------
  design(name: string): Promise<Doc> {
    return json(() => this.designApi.getDesignDocumentRaw({ db: this.name, ddoc: name }));
  }

  async saveDesign(name: string, views: Record<string, { map: string; reduce?: string }>,
    extra: Doc = {}): Promise<Doc> {
    const doc: Doc = { _id: `_design/${name}`, views, ...extra };
    try {
      doc._rev = (await this.design(name))._rev;
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
    const res = await translate(() => this.designApi.putDesignDocument({
      db: this.name, ddoc: name, designDocument: doc as any }, verbatim(doc)));
    doc._rev = res.rev;
    return doc;
  }

  async deleteDesign(name: string): Promise<void> {
    const rev = (await this.design(name))._rev;
    await translate(() => this.designApi.deleteDesignDocument({ db: this.name, ddoc: name, rev }));
  }

  async view(ddoc: string, view: string, query: ViewOptions = {}): Promise<Row[]> {
    const res = await json(() => this.designApi.postViewRaw({
      db: this.name, ddoc, view, viewQuery: query }));
    return res.rows ?? [];
  }

  // -- attachments ------------------------------------------------------
  /** Attach `data` to `docid` (creating the doc if needed); returns the new rev. */
  async putAttachment(docid: string, name: string, data: Uint8Array | Blob,
    contentType = "application/octet-stream"): Promise<string> {
    let rev: string | undefined;
    try {
      rev = (await this.get(docid))._rev;
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
    const body = data instanceof Blob ? data : new Blob([data as BlobPart]);
    // The override replaces the whole headers object, so keep the generated ones (auth).
    const res = await translate(() => this.attachments.putAttachment(
      { db: this.name, docid, attname: name, body, rev },
      ({ init }) => Promise.resolve({
        headers: { ...(init.headers as Record<string, string>), "Content-Type": contentType } })));
    return res.rev as string;
  }

  async getAttachment(docid: string, name: string): Promise<Uint8Array> {
    const blob = await translate(() => this.attachments.getAttachment({ db: this.name, docid, attname: name }));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async deleteAttachment(docid: string, name: string): Promise<string> {
    const rev = (await this.get(docid))._rev;
    const res = await translate(() => this.attachments.deleteAttachment({
      db: this.name, docid, attname: name, rev }));
    return res.rev as string;
  }

  // -- changes ----------------------------------------------------------
  /** One page of changes. `docIds` or `selector` filter server-side via POST. */
  async changes(opts: ChangesOptions = {}): Promise<ChangesResult> {
    const { signal, ...rest } = opts;
    const res = await json(() => this.changesRequest(rest, signal));
    return { results: res.results as Change[], lastSeq: res.last_seq, pending: res.pending };
  }

  /** Opens `feed=continuous` and returns the raw NDJSON body (see `follow({ feed: "continuous" })`). */
  async continuousChanges(opts: ChangesOptions = {}, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await translate(() => this.changesRequest({ ...opts, feed: "continuous" }, signal));
    return res.raw.body!;
  }

  // GET, or POST when filtering by docIds/selector. The body isn't read here.
  private changesRequest(opts: ChangesOptions, signal?: AbortSignal) {
    const { since = "0", docIds, selector, ...rest } = opts;
    const params: any = { db: this.name, since, ...rest };
    const init = signal ? { signal } : undefined;
    if (docIds === undefined && selector === undefined) return this.changesApi.getChangesRaw(params, init);
    params.filter ??= selector !== undefined ? "_selector" : "_doc_ids";
    params.changesQuery = { docIds, selector };
    return this.changesApi.postChangesRaw(params, init);
  }

  follow(opts?: ChangesFeedOptions): ChangesFeed {
    return new ChangesFeed(this, opts);
  }

  // -- local documents --------------------------------------------------
  getLocal(docid: string): Promise<Doc> {
    return json(() => this.docs.getLocalDocumentRaw({ db: this.name, docid }));
  }

  /** Write `_local/<docid>` (not replicated, not in the changes feed). */
  async putLocal(docid: string, doc: Doc): Promise<Doc> {
    const res = await translate(() => this.docs.putLocalDocument({
      db: this.name, docid, document: doc as any }, verbatim(doc)));
    return { ...doc, _id: res.id, _rev: res.rev };
  }

  async deleteLocal(docid: string, rev?: string): Promise<void> {
    rev ??= (await this.getLocal(docid))._rev;
    await translate(() => this.docs.deleteLocalDocument({ db: this.name, docid, rev }));
  }

  // -- maintenance -------------------------------------------------------
  /** Start compacting the database; it runs in the background. */
  async compact(): Promise<void> {
    await translate(() => this.maintenance.postCompact({ db: this.name, body: {} }));
  }

  /** Remove index files no design document uses anymore. */
  async viewCleanup(): Promise<void> {
    await translate(() => this.maintenance.postViewCleanup({ db: this.name, body: {} }));
  }

  /** Permanently remove revisions (no tombstone, not replicated). Returns what was purged. */
  async purge(revs: Record<string, string[]>): Promise<Record<string, string[]>> {
    return (await json(() => this.maintenance.postPurgeRaw({ db: this.name, requestBody: revs }))).purged;
  }

  // -- replication primitives -------------------------------------------
  /** Which of the given revisions this database is missing, per doc id. */
  revsDiff(revs: Record<string, string[]>): Promise<Record<string, { missing: string[]; possible_ancestors?: string[] }>> {
    return json(() => this.replication.postRevsDiffRaw({ db: this.name, requestBody: revs }));
  }

  /**
   * Fetch many docs/revisions at once. Returns one entry per requested id:
   * `{ id, docs: [{ ok: doc } | { error: {...} }] }`.
   */
  async bulkGet(docs: BulkGetItem[], opts: { revs?: boolean; latest?: boolean; attachments?: boolean } = {}): Promise<Row[]> {
    const body = { docs };
    const res = await json(() => this.replication.postBulkGetRaw(
      { db: this.name, bulkGetRequest: body as any, ...opts }, verbatim(body)));
    return res.results;
  }

  // -- security ---------------------------------------------------------
  security(): Promise<Row> {
    return json(() => this.securityApi.getSecurityRaw({ db: this.name }));
  }

  async setSecurity(admins?: Doc, members?: Doc): Promise<void> {
    const empty = () => ({ names: [], roles: [] });
    await translate(() => this.securityApi.putSecurity({ db: this.name, security: {
      admins: admins ?? empty(), members: members ?? empty() } }));
  }

  // -- partitions -------------------------------------------------------
  partition(name: string): Partition {
    return new Partition(this, name);
  }
}
