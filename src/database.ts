import {
  AttachmentsApi, ChangesApi, Configuration, DatabasesApi, DesignDocumentsApi, DocumentsApi,
  PartitionsApi, QueryApi, SecurityApi,
} from "../couchdb_client/src";
import type { AllDocsQuery, FindQuery, ViewQuery } from "../couchdb_client/src";
import { ChangesFeed } from "./changes";
import type { ChangesFeedOptions, ChangesSource } from "./changes";
import { Conflict, NotFound, translate } from "./errors";
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
}

// Generated Document models read/write `_id` etc. via aliases (id, rev, ...); map them explicitly.
function toGen(doc: Doc): any {
  return { ...doc, id: doc._id, rev: doc._rev, deleted: doc._deleted,
    attachments: doc._attachments, conflicts: doc._conflicts };
}

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
    return findResult(await json(() => this.database._partitions.postPartitionFindRaw({
      db: this.database.name, partition: this.name, findQuery: { selector, ...opts } })));
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

  constructor(config: Configuration, public name: string) {
    this.dbs = new DatabasesApi(config);
    this.docs = new DocumentsApi(config);
    this.queryApi = new QueryApi(config);
    this.designApi = new DesignDocumentsApi(config);
    this.attachments = new AttachmentsApi(config);
    this.changesApi = new ChangesApi(config);
    this.securityApi = new SecurityApi(config);
    this._partitions = new PartitionsApi(config);
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
  get(docid: string, params: { rev?: string; revsInfo?: boolean; conflicts?: boolean } = {}): Promise<Doc> {
    return json(() => this.docs.getDocumentRaw({ db: this.name, docid, ...params }));
  }

  /** Create or update `doc` in place, setting its `_id` and `_rev`. */
  async save(doc: Doc): Promise<Doc> {
    const res = await translate(() => "_id" in doc
      ? this.docs.putDocument({ db: this.name, docid: doc._id, document: toGen(doc) })
      : this.docs.postDocument({ db: this.name, document: toGen(doc) }));
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

  bulkSave(docs: Doc[]): Promise<Row[]> {
    return json(() => this.docs.postBulkDocsRaw({ db: this.name, bulkDocs: { docs: docs.map(toGen) } }));
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

  async find(selector: Doc, opts: FindOptions = {}): Promise<FindResult> {
    return findResult(await json(() => this.queryApi.postFindRaw({
      db: this.name, findQuery: { selector, ...opts } })));
  }

  createIndex(fields: string[], name?: string, opts: Record<string, any> = {}): Promise<Row> {
    const { partialFilterSelector, ...rest } = opts;
    return json(() => this.queryApi.postIndexRaw({ db: this.name, indexDefinitionRequest: {
      index: { fields, partialFilterSelector }, ...(name ? { name } : {}), ...rest } }));
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
      db: this.name, ddoc: name, designDocument: toGen(doc) }));
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
    const { since = "0", docIds, selector, ...rest } = opts;
    const params: any = { db: this.name, since, ...rest };
    const res = await json(() => {
      if (docIds === undefined && selector === undefined) return this.changesApi.getChangesRaw(params);
      params.filter ??= selector !== undefined ? "_selector" : "_doc_ids";
      params.changesQuery = { docIds, selector };
      return this.changesApi.postChangesRaw(params);
    });
    return { results: res.results as Change[], lastSeq: res.last_seq, pending: res.pending };
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
      db: this.name, docid, document: toGen(doc) }));
    return { ...doc, _id: res.id, _rev: res.rev };
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
