# couchdb-node

TypeScript SDK for Apache CouchDB, generated from [couchdb-openapi](../couchdb-openapi) (`couchdb_client/`) with a hand-written layer in `src/`.

## Install

```bash
npm install couchdb-node
```

## Quickstart

```ts
import { Client } from "couchdb-node";

const client = new Client({ url: "http://localhost:5984", username: "admin", password: "password" });
const db = client.database("mydb");
await db.put({ _id: "a", n: 1 });
```

(API shown is the target surface; see the Python SDK for the reference behavior.)

## Parity

Mirrors `couchdb-python`: same spec version (lockstep), same feature set, same conformance specs.

## Development

```bash
npm test         # vitest
npm run build    # tsc -> dist/
node scripts/sync-version.mjs [--check]
```
