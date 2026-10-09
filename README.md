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

// Follow changes (longpoll, checkpointed, at-least-once)
for await (const change of db.follow()) {
  console.log(change.id);
  break;
}
```

Errors: `NotFound`, `Conflict`, `Unauthorized`, `Forbidden`, `PreconditionFailed` (all extend `CouchDBError`).

## Parity

Mirrors `couchdb-python`: same spec version (lockstep), same feature set, same conformance specs.

## Development

```bash
npm test         # vitest
npm run build    # tsc -> dist/
node scripts/sync-version.mjs [--check]
```
