# couchdb-node

TypeScript SDK for Apache CouchDB, generated from [couchdb-openapi](../couchdb-openapi) (`couchdb_client/`) with a hand-written layer in `src/`.

## Install

```bash
npm install couchdb-node
```

## Quickstart

```ts
import { CouchDB } from "couchdb-node";

const couch = new CouchDB("http://localhost:5984", "admin", "password");
const db = await couch.createDatabase("people");

const doc = await db.save({ _id: "alice", age: 30 });
const alice = await db.get("alice");
const adults = await db.find({ age: { $gte: 18 } });

// Follow changes (longpoll by default, checkpointed, at-least-once)
const feed = db.follow({ feed: "continuous", checkpoint: "indexer", includeDocs: true });
for await (const change of feed) {
  console.log(change.id);
  if (done) feed.stop(); // also aborts the open request
}

// Replication building blocks, for writing your own sync
await db.revsDiff({ alice: [alice._rev] });               // revisions the db is missing
await db.bulkGet([{ id: "alice" }], { revs: true });       // docs with _revisions
await db.bulkSave(docsWithRevisions, { newEdits: false }); // keep the given _rev ids
```

`login()` keeps the cookie session alive: it takes the renewed cookie CouchDB
sends and logs in again once if the session expires.

Errors: `NotFound`, `Conflict`, `Unauthorized`, `Forbidden`, `PreconditionFailed` (all extend `CouchDBError`).

## Parity

Mirrors `couchdb-python`: same spec version (lockstep), same feature set, same conformance specs.

## Development

```bash
npm test         # vitest
npm run build    # tsc -> dist/
node scripts/sync-version.mjs [--check]
```

## Conformance

Run the shared Gauge suite against a throwaway CouchDB, no local toolchain needed (only Docker):

```bash
docker compose -f conformance/docker-compose.yml run --rm conformance
docker compose -f conformance/docker-compose.yml down -v
```

Without Docker: `bash scripts/conformance.sh` (needs CouchDB at `COUCHDB_URL`).
