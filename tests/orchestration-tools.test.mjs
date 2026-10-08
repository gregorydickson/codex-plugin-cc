import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installWorkerCodex } from "./worker-codex-fixture.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
function fixture() {
  const cwd = makeTempDir();
  const bin = makeTempDir();
  initGitRepo(cwd);
  installWorkerCodex(bin);
  const env = { ...buildEnv(bin), CODEX_HOME: makeTempDir(), CLAUDE_PLUGIN_DATA: makeTempDir() };
  const schema = { type: "object", additionalProperties: false, required: ["count"], properties: { count: { type: "integer" } } };
  fs.writeFileSync(path.join(cwd, "brief.md"), "Count rows");
  fs.writeFileSync(path.join(cwd, "schema.json"), JSON.stringify(schema));
  return { cwd, env, schema, command: (...args) => run(process.execPath, [SCRIPT, ...args, "--json"], { cwd, env }) };
}

test("compare validates both outputs, feeds the same brief/schema to the peer, and reports field disagreements", () => {
  const { cwd, schema, command } = fixture();
  fs.writeFileSync(path.join(cwd, "peer.cjs"), `const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(0, 'utf8')); fs.writeFileSync('peer-input.json', JSON.stringify(input)); process.stdout.write(JSON.stringify({count: 3}));`);
  const result = command("compare", "--brief", "brief.md", "--schema", "schema.json", "--against", `${JSON.stringify(process.execPath)} peer.cjs`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    codex: { count: 2 }, peer: { count: 3 },
    disagreements: [{ field: "$.count", left: 2, right: 3, leftMissing: false, rightMissing: false }]
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "peer-input.json"), "utf8")), { brief: "Count rows", schema });
});

test("compare fails rather than comparing a peer result that violates the schema", () => {
  const { cwd, command } = fixture();
  fs.writeFileSync(path.join(cwd, "peer.cjs"), 'process.stdout.write(JSON.stringify({count:"three"}));');
  const result = command("compare", "--brief", "brief.md", "--schema", "schema.json", "--against", `${JSON.stringify(process.execPath)} peer.cjs`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Peer output failed schema validation/);
});

test("verify-claims reports unavailable commits/files and out-of-range lines as unverifiable", () => {
  const { cwd, command } = fixture();
  fs.writeFileSync(path.join(cwd, "source.txt"), "known line\n");
  assert.equal(run("git", ["add", "source.txt"], { cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "source"], { cwd }).status, 0);
  const sha = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  fs.writeFileSync(path.join(cwd, "claims.json"), JSON.stringify([
    { id: "commit", text: "assertion", path: "source.txt", line: 1, sha: "abcdef1234567890abcdef1234567890abcdef12" },
    { id: "file", text: "assertion", path: "missing.txt", line: 1, sha },
    { id: "line", text: "assertion", path: "source.txt", line: 99, sha }
  ]));
  const result = command("verify-claims", "claims.json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { id: "commit", verdict: "unverifiable", evidence: "Commit or file is not available." },
    { id: "file", verdict: "unverifiable", evidence: "Commit or file is not available." },
    { id: "line", verdict: "unverifiable", evidence: "Claim line is outside the file." }
  ]);
});

test("verify-claims rejects duplicate ids and malformed revisions before returning ambiguous reports", () => {
  const { cwd, command } = fixture();
  const claim = { id: "same", text: "assertion", path: "source.txt", line: 1, sha: "abcdef1234567890abcdef1234567890abcdef12" };
  fs.writeFileSync(path.join(cwd, "claims.json"), JSON.stringify([claim, claim]));
  const duplicate = command("verify-claims", "claims.json");
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr + duplicate.stdout, /unique string id/);
  fs.writeFileSync(path.join(cwd, "claims.json"), JSON.stringify([{ ...claim, sha: "HEAD;touch nope" }]));
  const invalid = command("verify-claims", "claims.json");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr + invalid.stdout, /commit SHA/);
  assert.equal(fs.existsSync(path.join(cwd, "nope")), false);
});
