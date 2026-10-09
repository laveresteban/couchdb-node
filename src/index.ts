export { CouchDB } from "./client";
export { Database, Partition } from "./database";
export type { ChangesOptions, FindOptions, QueryOptions, ViewOptions, Row } from "./database";
export { ChangesFeed } from "./changes";
export type { ChangesSource, ChangesFeedOptions } from "./changes";
export type { Doc, Change, FindResult, ChangesResult } from "./types";
export {
  CouchDBError, Unauthorized, Forbidden, NotFound, Conflict, PreconditionFailed,
} from "./errors";
