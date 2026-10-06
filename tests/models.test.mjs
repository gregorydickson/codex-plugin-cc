import test from "node:test";
import assert from "node:assert/strict";

import { MODEL_ALIASES, normalizeRequestedModel } from "../plugins/codex/scripts/lib/models.mjs";

test("spark resolves to the fast, low-cost tier the Codex CLI currently lists", () => {
  assert.equal(normalizeRequestedModel("spark"), "gpt-6-luna");
});

test("alias lookup ignores case and surrounding whitespace", () => {
  for (const spelling of ["SPARK", "Spark", "  spark  "]) {
    assert.equal(normalizeRequestedModel(spelling), MODEL_ALIASES.get("spark"), spelling);
  }
});

test("a concrete model slug passes through unchanged", () => {
  assert.equal(normalizeRequestedModel("gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(normalizeRequestedModel(" gpt-6.1-sol "), "gpt-6.1-sol");
});

test("an absent or blank model leaves the choice to Codex", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(normalizeRequestedModel(value), null, String(value));
  }
});
