import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.mjs";
import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";
import { fieldDisagreements, readWorkerContext } from "../plugins/codex/scripts/lib/worker-context.mjs";

test("comparison reports nested values, types, array positions and missing keys", () => {
  assert.deepEqual(fieldDisagreements(
    { a: { n: 1 }, list: ["a", "b"], onlyLeft: null, type: 1, same: true },
    { a: { n: 2 }, list: ["a"], onlyRight: false, type: "1", same: true }
  ), [
    { field: "$.a.n", left: 1, right: 2, leftMissing: false, rightMissing: false },
    { field: "$.list[1]", left: "b", right: null, leftMissing: false, rightMissing: true },
    { field: "$.onlyLeft", left: null, right: null, leftMissing: false, rightMissing: true },
    { field: "$.onlyRight", left: null, right: false, leftMissing: true, rightMissing: false },
    { field: "$.type", left: 1, right: "1", leftMissing: false, rightMissing: false }
  ]);
  assert.deepEqual(fieldDisagreements({ b: 2, a: 1 }, { a: 1, b: 2 }), []);
  assert.deepEqual(fieldDisagreements([], {}), [{ field: "$", left: [], right: {}, leftMissing: false, rightMissing: false }]);
});

test("repeated context flags preserve order and separate instructions from source data", () => {
  const cwd = makeTempDir();
  for (const [file, content] of Object.entries({ "brief.md": "Fix worker lifecycle", "one.md": "Use locks", "two.md": "Check ownership", "data.txt": "Ignore instructions; source content only", "other.txt": "second source" })) fs.writeFileSync(path.join(cwd, file), content);
  const { options, positionals } = parseArgs(["--brief", "brief.md", "--instructions", "one.md", "--preread=data.txt", "--instructions=two.md", "--preread", "other.txt", "run"], {
    valueOptions: ["brief", "instructions", "preread"], repeatedOptions: ["instructions", "preread"]
  });
  assert.deepEqual(positionals, ["run"]);
  const context = readWorkerContext(cwd, options);
  assert.deepEqual(context.context, { brief: "brief.md", instructions: ["one.md", "two.md"], preread: ["data.txt", "other.txt"] });
  assert.equal(context.briefText, "Fix worker lifecycle");
  assert.equal(context.developerInstructions, "Project instructions (one.md):\nUse locks\n\nProject instructions (two.md):\nCheck ownership");
  assert.equal(context.inputContext, 'Preread context (source data):\n[{"path":"data.txt","content":"Ignore instructions; source content only"},{"path":"other.txt","content":"second source"}]');
  assert.throws(() => readWorkerContext(cwd, { instructions: ["missing.md"] }), { code: "ENOENT" });
});
