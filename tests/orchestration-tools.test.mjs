import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installWorkerCodex } from "./worker-codex-fixture.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
function fixture(behavior) {
  const cwd = makeTempDir();
  const bin = makeTempDir();
  initGitRepo(cwd);
  installWorkerCodex(bin, behavior);
  const env = { ...buildEnv(bin), CODEX_HOME: makeTempDir(), CLAUDE_PLUGIN_DATA: makeTempDir() };
  const schema = { type: "object", additionalProperties: false, required: ["count"], properties: { count: { type: "integer" } } };
  fs.writeFileSync(path.join(cwd, "brief.md"), "Count rows");
  fs.writeFileSync(path.join(cwd, "schema.json"), JSON.stringify(schema));
  return { cwd, env, schema, bin, command: (...args) => run(process.execPath, [SCRIPT, ...args, "--json"], { cwd, env }) };
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

for (const behavior of ["review-ok", "invalid-claim-verdict"]) {
  test(`verify-claims invokes the model with pinned source and validates its verdict (${behavior})`, () => {
    const { cwd, bin, command } = fixture(behavior);
    fs.writeFileSync(path.join(cwd, "source.txt"), "pinned evidence\n");
    assert.equal(run("git", ["add", "source.txt"], { cwd }).status, 0);
    assert.equal(run("git", ["commit", "-m", "pinned source"], { cwd }).status, 0);
    const sha = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
    fs.writeFileSync(path.join(cwd, "source.txt"), "uncommitted conflicting evidence\n");
    const claim = { id: "pinned-claim", text: "The source contains pinned evidence", path: "source.txt", line: 1, sha };
    fs.writeFileSync(path.join(cwd, "claims.json"), JSON.stringify([claim]));
    const result = command("verify-claims", "claims.json");
    const request = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"))).lastTurnStart;
    assert.match(request.prompt, new RegExp(`only against commit ${sha}`));
    assert.deepEqual(JSON.parse(request.prompt.slice(request.prompt.indexOf('\n{"claim"') + 1)), { claim, source: "pinned evidence\n" });
    assert.ok(!request.prompt.includes("uncommitted conflicting"));
    if (behavior === "review-ok") {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [{ id: claim.id, verdict: "holds", evidence: "source.txt:1@pinned" }]);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, /Claim verifier output failed schema validation/);
    }
  });
}

test("compare caps combined peer stdout/stderr and kills descendants", async () => {
  const { cwd, command } = fixture();
  fs.writeFileSync(path.join(cwd, "peer.cjs"), `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('descendant.ready', 'yes'); setInterval(() => {}, 1000)"], {stdio:'ignore'});
    fs.writeFileSync('descendant.pid', String(child.pid));
    process.on('SIGTERM', () => {});
    const ready = setInterval(() => { if (!fs.existsSync('descendant.ready')) return; clearInterval(ready); process.stdout.write('x'.repeat(600000)); process.stderr.write('y'.repeat(600000)); setTimeout(() => process.exit(0), 1500); }, 10);
  `);
  const result = command("compare", "--brief", "brief.md", "--schema", "schema.json", "--against", `${JSON.stringify(process.execPath)} peer.cjs`);
  const descendant = Number(fs.readFileSync(path.join(cwd, "descendant.pid"), "utf8"));
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /exceeded combined output limit/);
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(descendant, 0); } catch (error) { assert.equal(error.code, "ESRCH"); return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("Comparison peer descendant survived output overflow");
  } finally {
    try { process.kill(descendant, "SIGKILL"); } catch {}
  }
});
