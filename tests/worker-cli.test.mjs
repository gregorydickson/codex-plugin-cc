import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
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
  const env = { ...buildEnv(bin), CODEX_HOME: makeTempDir(), CODEX_COMPANION_SESSION_ID: "worker-tests" };
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

test("stopped named sessions resume their thread with private configuration intact", () => {
  const { root, cli } = setup();
  const secret = "credential-sentinel-never-public";
  fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ mcp_servers: { private: { command: "unused", env: { TOKEN: secret } } } }));
  const initial = cli("task", "--name", "private-session", "--pause-and-ask", "--mcp-config", "mcp.json", "--on-end", `true ${secret}`, "NEED_ANSWER");
  assert.equal(initial.status, "awaiting-answer");
  assert.ok(!JSON.stringify(initial).includes(secret));
  for (const args of [["status", "--all-sessions"], ["status", initial.jobId], ["sessions", "list"], ["result", initial.jobId]]) {
    const output = cli(...args);
    assert.ok(!JSON.stringify(output).includes(secret), `Secret exposed by ${args.join(" ")}`);
    const records = args[0] === "sessions" ? output : args[0] === "status" ? [output.job ?? output.latestFinished] : [output.job];
    assert.equal(records[0].id, initial.jobId);
    for (const record of records) for (const field of ["request", "config", "hooks", "lockCmd", "unlockCmd", "developerInstructions"]) assert.equal(Object.hasOwn(record, field), false, field);
  }
  assert.equal(cli("sessions", "stop", "private-session").status, "cancelled");
  const resumed = cli("sessions", "resume", "private-session", "Continue task");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.threadId, initial.threadId);
  assert.notEqual(resumed.jobId, initial.jobId);
  assert.ok(!JSON.stringify(resumed).includes(secret));
  // The secret is excluded from public output, while the next turn still has its config.
  const { config } = readStoredJob(root, resumed.jobId).request;
  assert.equal(config.mcp_servers.private.env.TOKEN, secret);
});

test("cancel reports a pending request while another process owns finalization", () => {
  const { root, cli } = setup();
  const job = { id: "task-finalizing", workspaceRoot: root, status: "running", pid: null,
    finalization: { pid: process.pid, patch: { status: "completed" } } };
  writeJobFile(root, job.id, job); upsertJob(root, job);
  const result = cli("cancel", job.id);
  assert.equal(result.status, "running");
  assert.equal(result.cancellationRequested, true);
  assert.equal(readStoredJob(root, job.id).cancelRequested, true);
  assert.deepEqual(readStoredJob(root, job.id).finalization, job.finalization);
});


test("cancel reports publication failure after the signalled finalizer exits", async t => {
  const { root, env } = setup();
  const owner = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200));
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { owner.kill("SIGKILL"); } catch {} });
  await once(owner.stdout, "data");
  const job = { id: "task-exiting-finalizer", workspaceRoot: root, status: "running", pid: owner.pid,
    resultFile: root, finalization: { pid: owner.pid, patch: { status: "completed" } } };
  writeJobFile(root, job.id, job); upsertJob(root, job);
  const cancelling = spawn(process.execPath, [script, "cancel", job.id, "--json"], { cwd: root, env });
  t.after(() => { try { cancelling.kill("SIGKILL"); } catch {} });
  let stdout = "", stderr = "";
  cancelling.stdout.on("data", chunk => { stdout += chunk; });
  cancelling.stderr.on("data", chunk => { stderr += chunk; });
  const [exitCode] = await once(cancelling, "close");
  assert.equal(exitCode, 1, stderr + stdout);
  const report = JSON.parse(stdout);
  assert.equal(report.status, "failed");
  assert.equal(report.error, "result_file_failed");
  assert.equal(Object.hasOwn(report, "cancellationRequested"), false);
  assert.equal(readStoredJob(root, job.id).status, "failed");
});
