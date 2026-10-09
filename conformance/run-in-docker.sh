#!/usr/bin/env bash
# Create single-node system DBs (412 = already exists), then run the suite.
set -eu
for db in _users _replicator _global_changes; do
  curl -s -o /dev/null -X PUT "http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@couchdb:5984/$db"
done
exec bash scripts/conformance.sh "$@"
