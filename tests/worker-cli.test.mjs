import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installWorkerCodex } from "./worker-codex-fixture.mjs";
const script = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
function setup(behavior) {
  const root = makeTempDir(); initGitRepo(root);
  const bin = makeTempDir(); installWorkerCodex(bin, behavior);
  const env = { ...buildEnv(bin), CODEX_COMPANION_SESSION_ID: "worker-tests" };
  const schema = path.join(root, "schema.json");
  fs.writeFileSync(schema, JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false }));
  const cli = (...args) => {
    const result = run(process.execPath, [script, ...args, "--json"], { cwd: root, env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, bin, env, schema, cli };
}

test("worker CLI validates foreground/background schemas and retains caller metadata", () => {
  const { root, schema, cli } = setup();
  fs.writeFileSync(path.join(root, "brief.md"), "Count the rows");
  fs.writeFileSync(path.join(root, "input.ts"), "export const rows = 2;");
  const typed = cli("task", "--output-schema", schema, "--brief", "brief.md", "--preread", "input.ts", "--model", "test-model", "--effort", "low");
  assert.equal(typed.schemaValid, true); assert.deepEqual(typed.result, { count: 2 });
  assert.equal(typed.job.model, "test-model"); assert.equal(typed.job.effort, "low");
  assert.deepEqual(typed.job.context.preread, ["input.ts"]);
  const resultFile = path.join(root, "result.json");
  const launched = cli("task", "--background", "--output-schema", schema, "--result-file", resultFile, "Count rows");
  cli("status", launched.jobId, "--wait");
  const result = cli("result", launched.jobId);
  assert.equal(result.status, "completed"); assert.equal(result.schemaValid, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile)).result, { count: 2 });
});

test("worker CLI named sessions resume the same thread and answer stop reports", () => {
  const { cli } = setup();
  const initial = cli("task", "--name", "named-worker", "Start task");
  assert.equal(cli("sessions", "list").find(job => job.name === "named-worker").status, "completed");
  const resumed = cli("sessions", "resume", "named-worker", "Continue task");
  assert.equal(resumed.threadId, initial.threadId);
  const question = cli("task", "--name", "question-worker", "--pause-and-ask", "NEED_ANSWER");
  assert.equal(question.status, "awaiting-answer");
  const answer = cli("answer", question.jobId, "yes");
  assert.equal(answer.status, "completed"); assert.equal(answer.threadId, question.threadId);
  assert.equal(cli("status", question.jobId).job.status, "completed");
});

test("worker CLI cancellation writes the terminal envelope exactly once", () => {
  const { root, cli } = setup("interruptible-slow-task");
  const resultFile = path.join(root, "cancelled.json");
  const endFile = path.join(root, "ended");
  const launched = cli("task", "--background", "--name", "cancel-worker", "--result-file", resultFile, "--on-end", `echo done >> '${endFile}'`, "Wait for cancellation");
  const cancelled = cli("cancel", launched.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(resultFile)).status, "cancelled");
  assert.equal(fs.readFileSync(endFile, "utf8"), "done\n");
});

test("worker CLI accepts caller schemas for both review commands", () => {
  const { root, schema, cli } = setup();
  fs.writeFileSync(path.join(root, "source.txt"), "original\n");
  run("git", ["add", "."], { cwd: root }); run("git", ["commit", "-m", "initial"], { cwd: root });
  fs.writeFileSync(path.join(root, "source.txt"), "changed\n");
  for (const command of ["review", "adversarial-review"]) {
    const reviewed = cli(command, "--scope", "working-tree", "--output-schema", schema, "--effort", "high");
    assert.equal(reviewed.status, "completed"); assert.equal(reviewed.schemaValid, true);
    assert.deepEqual(reviewed.result, { count: 2 }); assert.equal(reviewed.job.effort, "high");
  }
});

test("worker CLI preserves caller schema across stop-report answer", () => {
  const { cli, schema } = setup();
  const paused = cli("task", "--name", "typed-question", "--pause-and-ask", "--output-schema", schema, "NEED_ANSWER");
  assert.equal(paused.status, "awaiting-answer"); assert.equal(paused.schemaValid, null);
  assert.equal(paused.result.question, "Which option?");
  const completed = cli("answer", paused.jobId, "yes");
  assert.equal(completed.jobId, paused.jobId); assert.equal(completed.threadId, paused.threadId);
  assert.equal(completed.status, "completed"); assert.equal(completed.schemaValid, true);
  assert.deepEqual(completed.result, { count: 2 });
});


test("cancel reports a required result-file publication failure", () => {
  const { root, env, cli } = setup("interruptible-slow-task");
  const launched = cli("task", "--background", "--result-file", root, "Wait for cancellation");
  const cancelled = run(process.execPath, [script, "cancel", launched.jobId, "--json"], { cwd: root, env });
  assert.equal(cancelled.status, 1, cancelled.stderr);
  const report = JSON.parse(cancelled.stdout);
  assert.equal(report.status, "failed");
  assert.equal(report.error, "result_file_failed");
});
