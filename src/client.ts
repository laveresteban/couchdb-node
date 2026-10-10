import {
  AuthenticationApi, Configuration, DatabasesApi, MaintenanceApi, ReplicationApi, ServerApi,
} from "../couchdb_client/src";
import type { GetDbUpdatesRequest } from "../couchdb_client/src";
import { Database } from "./database";
import { NotFound, translate } from "./errors";
import type { Doc } from "./types";

export interface CouchDBOptions {
  /**
   * How the CouchDB server reaches itself, for `replicate()` with bare
   * database names. Defaults to the client URL; set it when the client and
   * server see different hostnames (Docker, proxies).
   */
  replicationUrl?: string;
}

/** Server-level entry point. Holds one shared Configuration (basic auth + cookie session). */
export class CouchDB {
  private readonly config: Configuration;
  private readonly basePath: string;
  private readonly replicationUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly _session: { cookie?: string; credentials?: { name: string; password: string } } = {};
  private readonly server: ServerApi;
  private readonly auth: AuthenticationApi;
  private readonly dbs: DatabasesApi;
  private readonly replication: ReplicationApi;
  private readonly maintenance: MaintenanceApi;

  constructor(url = "http://localhost:5984", username?: string, password?: string, options: CouchDBOptions = {}) {
    this.basePath = url.replace(/\/+$/, "");
    this.replicationUrl = (options.replicationUrl ?? url).replace(/\/+$/, "");
    const basePath = this.basePath;
    this.username = username;
    this.password = password;
    const session = this._session;
    this.config = new Configuration({
      basePath: this.basePath,
      username,
      password,
      middleware: [{
        async pre({ url, init }) {
          if (!session.cookie) return;
          return { url, init: { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: session.cookie } } };
        },
        // CouchDB re-issues Set-Cookie to extend the session; keep the latest non-empty one.
        // If the session expired anyway, log in again once and retry the request.
        // The login and retry use plain fetch, so a second 401 can't loop back here.
        async post({ url, init, response }) {
          keepCookie(session, response);
          const creds = session.credentials;
          if (response.status !== 401 || !creds || !session.cookie || url.endsWith("/_session")) return response;
          await response.text().catch(() => "");
          const login = await fetch(`${basePath}/_session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(creds),
          });
          await login.text().catch(() => "");
          if (!login.ok) return response;
          keepCookie(session, login);
          const retried = await fetch(url, {
            ...init, headers: { ...(init.headers as Record<string, string>), Cookie: session.cookie! } });
          keepCookie(session, retried);
          return retried;
        },
      }],
    });
    this.server = new ServerApi(this.config);
    this.auth = new AuthenticationApi(this.config);
    this.dbs = new DatabasesApi(this.config);
    this.replication = new ReplicationApi(this.config);
    this.maintenance = new MaintenanceApi(this.config);
  }

  close(): void { /* global fetch has no pool; kept for try/finally symmetry */ }

  // -- server
  async info(): Promise<Doc> {
    return { ...(await translate(() => this.server.getServerInformation())) };
  }

  async up(): Promise<boolean> {
    try {
      return (await translate(() => this.server.getUp())).status === "ok";
    } catch (e) {
      if (e instanceof NotFound) return false;
      throw e;
    }
  }

  async uuids(count = 1): Promise<string[]> {
    return (await translate(() => this.server.getUuids({ count }))).uuids;
  }

  allDbs(): Promise<string[]> {
    return translate(() => this.server.getAllDbs());
  }

  /** Running compactions, indexing and replications. */
  activeTasks(): Promise<Doc[]> {
    return translate(async () => (await this.maintenance.getActiveTasksRaw()).raw.json());
  }

  /** Info for several databases at once: `{ key, info }` or `{ key, error }` each. */
  dbsInfo(names: string[]): Promise<Doc[]> {
    return translate(async () => (await this.dbs.postDbsInfoRaw({ postDbsInfoRequest: { keys: names } })).raw.json());
  }

  /** Replication jobs the scheduler is running. */
  schedulerJobs(opts: { limit?: number; skip?: number } = {}): Promise<Doc> {
    return translate(async () => (await this.replication.getSchedulerJobsRaw(opts)).raw.json());
  }

  /** State of replications defined in `_replicator` databases. */
  schedulerDocs(opts: { limit?: number; skip?: number } = {}): Promise<Doc> {
    return translate(async () => (await this.replication.getSchedulerDocsRaw(opts)).raw.json());
  }

  /** One page of database events (`feed: "longpoll"`, `since`, `timeout` ...). */
  dbUpdates(opts: GetDbUpdatesRequest = {}): Promise<Doc> {
    return translate(async () => (await this.server.getDbUpdatesRaw(opts)).raw.json());
  }

  // -- sessions
  /** Start a cookie session; later requests send the AuthSession cookie. */
  async login(name: string, password: string): Promise<void> {
    const res = await translate(() => this.auth.postSessionRaw({ sessionRequest: { name, password } }));
    const h = res.raw.headers;
    const header = h.getSetCookie?.()[0] ?? h.get("set-cookie");
    // Only replace the stored cookie once a new one was actually issued.
    if (header) this._session.cookie = header.split(";", 1)[0];
    this._session.credentials = { name, password };
  }

  async logout(): Promise<void> {
    this._session.credentials = undefined;
    await translate(() => this.auth.deleteSession());
    this._session.cookie = undefined;
  }

  async session(): Promise<Doc> {
    const info = await translate(() => this.auth.getSession());
    return { ...info, userCtx: { ...info.userCtx, name: info.userCtx.name ?? null } };
  }

  // -- databases
  async createDatabase(name: string, partitioned = false): Promise<Database> {
    await translate(() => this.dbs.putDatabase({ db: name, partitioned: partitioned || undefined }));
    return this.database(name);
  }

  async deleteDatabase(name: string): Promise<void> {
    await translate(() => this.dbs.deleteDatabase({ db: name }));
  }

  database(name: string): Database {
    return new Database(this.config, name);
  }

  // -- replication
  private endpoint(x: string): Doc | string {
    if (x.includes("://")) return x; // full URLs go through as-is
    const ep: Doc = { url: `${this.replicationUrl}/${encodeURIComponent(x)}` };
    if (this.username) ep.auth = { basic: { username: this.username, password: this.password } };
    return ep;
  }

  /**
   * Replicate between databases. Bare names are resolved against this server
   * (with this client's credentials); full URLs are passed through as-is.
   */
  async replicate(source: string, target: string, options: Doc = {}): Promise<Doc> {
    const body: any = { source: this.endpoint(source), target: this.endpoint(target), ...options };
    return { ...(await translate(() => this.replication.postReplicate({ replicationRequest: body }))) };
  }
}

function keepCookie(session: { cookie?: string }, response: Response): void {
  const h = response.headers;
  const all = h.getSetCookie?.() ?? [h.get("set-cookie")];
  for (const c of all) {
    const kv = c?.split(";", 1)[0];
    if (kv?.startsWith("AuthSession=") && kv.length > "AuthSession=".length) session.cookie = kv;
  }
}
