# Changelog

## 0.7.0 (unreleased)
- Regenerated from couchdb-openapi 0.7.0 (stale `ReplicationRequestSource`/`Target` models removed).
- `Database.head()`, `getIfChanged()` (ETag / 304), `explain()`, `designDocs()`,
  `localDocs()`, `purge()`, `compact()`, `viewCleanup()`.
- `CouchDB.dbsInfo()`, `activeTasks()`, `schedulerJobs()`, `schedulerDocs()`, `dbUpdates()`.
- `replicate()` passes full URLs through as plain strings.
- Steps for the 13 conformance scenarios added with spec 0.7.0 (46/46). Same API as couchdb-python 0.7.0.

## 0.6.0 (unreleased)
- Regenerated from couchdb-openapi 0.6.0 (`_revs_diff`, `_bulk_get`, `revs`/`latest`
  on document GET, continuous `_changes`, more view query fields, typed 401/403).
- `follow({ feed: "continuous" })`: streaming reader with heartbeats, reconnect
  from the last seq, `docIds`/`selector` filters and batched checkpoints.
- `stop()` aborts a pending longpoll or open stream instead of waiting it out.
- `revsDiff()`, `bulkGet()`, `deleteLocal()` and `bulkSave(docs, { newEdits: false })`.
- `bulkSave()` sets `_id`/`_rev` on the docs it saved, like `save()`.
- `get()` takes `revs` and `latest`.
- `find()`/`createIndex()` accept CouchDB's snake_case options too.
- Cookie sessions log in again once after expiry.
- `new CouchDB(url, user, pass, { replicationUrl })` for servers behind Docker/proxies.
- Conformance fails when any scenario is skipped. Parity with couchdb-python 0.6.0.

## 0.3.0 (unreleased)
- Initial Node/TypeScript SDK, version-locked to the OpenAPI spec (`_changes` filters, `POST _changes`, `_local` docs).
