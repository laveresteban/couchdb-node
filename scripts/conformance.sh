#!/usr/bin/env bash
# Run the shared Gauge conformance suite against this SDK.
#   CONFORMANCE_SPECS  path to couchdb-sdk-generator/conformance/specs
#                      (default: ../couchdb-sdk-generator/conformance/specs)
#   extra args are passed to `gauge run`, e.g. --tags documents
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
specs="${CONFORMANCE_SPECS:-$root/../couchdb-sdk-generator/conformance/specs}"
[[ -d "$specs" ]] || { echo "conformance specs not found at $specs" >&2; exit 1; }

cd "$root/conformance"
rm -rf specs && cp -r "$specs" specs

gauge() { if type -P gauge >/dev/null; then command gauge "$@"; else npx --yes @getgauge/cli@1.6.38 "$@"; fi; }
(cd "$root" && npm ci --silent)
npm ci --silent
gauge install ts >/dev/null
gauge install html-report >/dev/null 2>&1 || true
gauge run specs "$@"
