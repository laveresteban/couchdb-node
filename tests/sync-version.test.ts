import { expect, test } from "vitest";
// @ts-ignore - plain .mjs
import { readVersion } from "../scripts/sync-version.mjs";

test("stamps package version from .generated-from", () => {
  expect(readVersion("spec_version=0.3.0\nspec_sha=abc\n")).toBe("0.3.0");
});

test("throws when spec_version missing", () => {
  expect(() => readVersion("spec_sha=abc\n")).toThrow();
});
