import {
  AuthenticationApi, Configuration, DatabasesApi, ReplicationApi, ServerApi,
} from "../couchdb_client/src";
import { Database } from "./database";
import { NotFound, translate } from "./errors";
import type { Doc } from "./types";

/** Server-level entry point. Holds one shared Configuration (basic auth + cookie session). */
export class CouchDB {
  private readonly config: Configuration;
  private readonly basePath: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly _session: { cookie?: string } = {};
  private readonly server: ServerApi;
  private readonly auth: AuthenticationApi;
  private readonly dbs: DatabasesApi;
  private readonly replication: ReplicationApi;

  constructor(url = "http://localhost:5984", username?: string, password?: string) {
    this.basePath = url.replace(/\/+$/, "");
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
      }],
    });
    this.server = new ServerApi(this.config);
    this.auth = new AuthenticationApi(this.config);
    this.dbs = new DatabasesApi(this.config);
    this.replication = new ReplicationApi(this.config);
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

  // -- sessions
  /** Start a cookie session; later requests send the AuthSession cookie. */
  async login(name: string, password: string): Promise<void> {
    const res = await translate(() => this.auth.postSessionRaw({ sessionRequest: { name, password } }));
    const h = res.raw.headers;
    const header = h.getSetCookie?.()[0] ?? h.get("set-cookie");
    // Only replace the stored cookie once a new one was actually issued.
    if (header) this._session.cookie = header.split(";", 1)[0];
  }

  async logout(): Promise<void> {
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
  private endpoint(x: string): Doc {
    if (x.includes("://")) return { url: x };
    const ep: Doc = { url: `${this.basePath}/${x}` };
    if (this.username) ep.auth = { basic: { username: this.username, password: this.password } };
    return ep;
  }

  /** Replicate between databases. Bare names are resolved against this server. */
  async replicate(source: string, target: string, options: Doc = {}): Promise<Doc> {
    const body: any = { source: this.endpoint(source), target: this.endpoint(target), ...options };
    return { ...(await translate(() => this.replication.postReplicate({ replicationRequest: body }))) };
  }
}
