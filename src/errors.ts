import { ResponseError, FetchError } from "../couchdb_client/src";

export class CouchDBError extends Error {
  constructor(
    public status: number,
    public error: string,
    public reason: string,
    public headers: Record<string, string> = {},
  ) {
    super(`${status} ${error}: ${reason}`);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class Unauthorized extends CouchDBError {}
export class Forbidden extends CouchDBError {}
export class NotFound extends CouchDBError {}
export class Conflict extends CouchDBError {}
export class PreconditionFailed extends CouchDBError {}

const BY_STATUS: Record<number, typeof CouchDBError> = {
  401: Unauthorized, 403: Forbidden, 404: NotFound, 409: Conflict, 412: PreconditionFailed,
};

/** Build a typed error from an HTTP error response. Header names are lowercase. */
export async function fromResponse(res: Response): Promise<CouchDBError> {
  const status = res.status;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const text = await res.text().catch(() => "");
  let error = "";
  let reason = text;
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object") {
      error = String(body.error ?? "");
      reason = String(body.reason ?? "");
    }
  } catch { /* non-JSON: keep raw text as reason */ }
  return new (BY_STATUS[status] ?? CouchDBError)(status, error, reason, headers);
}

/** Run a generated-client call, converting its errors to CouchDBError types. */
export async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ResponseError) throw await fromResponse(e.response);
    if (e instanceof FetchError) throw new CouchDBError(0, "fetch_error", e.cause?.message ?? e.message);
    throw e;
  }
}
