// Stamp package.json version from couchdb_client/.generated-from; --check fails on drift.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function readVersion(text) {
  const m = /^spec_version=(.+)$/m.exec(text);
  if (!m) throw new Error("spec_version not found in .generated-from");
  return m[1].trim();
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkgPath = join(root, "package.json");
  const spec = readVersion(readFileSync(join(root, "couchdb_client", ".generated-from"), "utf8"));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (process.argv.includes("--check")) {
    if (pkg.version !== spec) {
      console.error(`version drift: package.json=${pkg.version} spec=${spec}; run node scripts/sync-version.mjs`);
      process.exit(1);
    }
    return;
  }
  if (pkg.version !== spec) {
    pkg.version = spec;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  console.log(`version ${spec}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
