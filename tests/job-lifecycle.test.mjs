import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { runTrackedJob, finalizeTrackedJob, reconcileOrphanedJobs } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { resultEnvelope } from "../plugins/codex/scripts/lib/job-results.mjs";
import { writeJobFile, upsertJob, readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { validateWorktree } from "../plugins/codex/scripts/lib/worktree-jobs.mjs";

function cleanupWatchdog(t, workspaceRoot, jobId) {
  t.after(() => {
    const pid = readJobFile(resolveJobFile(workspaceRoot, jobId)).watchdogPid;
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  });
}

const schema = { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 1 } }, additionalProperties: false };

test("typed envelope preserves invalid raw output and enforces schema constraints", () => {
  const good = resultEnvelope({ id: "a", status: "completed", outputSchema: schema, result: { rawOutput: '{"count":2}' } });
  assert.equal(good.schemaValid, true); assert.deepEqual(good.result, { count: 2 });
  const bad = resultEnvelope({ id: "a", status: "completed", outputSchema: schema, result: { rawOutput: '{"count":0}' } });
  assert.equal(bad.schemaValid, false); assert.match(bad.parseError, /minimum/);
  const malformed = resultEnvelope({ id: "a", outputSchema: schema, result: { rawOutput: "not json" } });
  assert.equal(malformed.schemaValid, false); assert.equal(malformed.rawOutput, "not json"); assert.equal(malformed.result, null);
});

test("cancel wins late completion; result, socket and end hook run once", async () => {
  const workspaceRoot = makeTempDir();
  const hookFile = path.join(workspaceRoot, "hook");
  const socketPath = path.join(workspaceRoot, "socket");
  const events = [];
  let received; const receivedEvents = new Promise(resolve => received = resolve);
  const server = net.createServer(socket => { let data = ""; socket.on("data", chunk => data += chunk); socket.on("data", () => { if (data.endsWith("\n")) { events.push(JSON.parse(data)); if (events.length === 2) received(); } }); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const job = { id: "cancel", workspaceRoot, resultFile: path.join(workspaceRoot, "result.json"), notifySocket: socketPath, hooks: { end: `echo done >> '${hookFile}'` } };
  try {
    await runTrackedJob(job, async () => {
      await finalizeTrackedJob(workspaceRoot, job.id, { status: "cancelled" });
      return { exitStatus: 0, payload: { rawOutput: "late" } };
    });
    await receivedEvents;
    assert.equal(JSON.parse(fs.readFileSync(job.resultFile)).status, "cancelled");
    assert.equal(fs.readFileSync(hookFile, "utf8"), "done\n");
    assert.deepEqual(events.map(event => event.event), ["start", "end"]);
    assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).status, "cancelled");
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("worktree run reports shell changes including previously dirty files and unlocks failure", async t => {
  const workspaceRoot = makeTempDir(); initGitRepo(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, "b"), "original");
  run("git", ["add", "."], { cwd: workspaceRoot }); run("git", ["commit", "-m", "initial"], { cwd: workspaceRoot });
  fs.writeFileSync(path.join(workspaceRoot, "b"), "dirty before");
  assert.equal(validateWorktree(workspaceRoot), fs.realpathSync(workspaceRoot));
  const nested = path.join(workspaceRoot, "nested"); fs.mkdirSync(nested);
  assert.throws(() => validateWorktree(nested), /root/);
  const lock = path.join(workspaceRoot, "lock");
  cleanupWatchdog(t, workspaceRoot, "write");
  const job = { id: "write", workspaceRoot, worktree: workspaceRoot, structured: true, lockCmd: `touch '${lock}'`, unlockCmd: `rm '${lock}'` };
  await assert.rejects(runTrackedJob(job, async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a"), "new");
    fs.writeFileSync(path.join(workspaceRoot, "b"), "dirty after");
    throw new Error("execution broke");
  }), /execution broke/);
  assert.equal(fs.existsSync(lock), false);
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.deepEqual(stored.result.changedFiles, ["a", "b"]); assert.equal(stored.status, "failed");
});

test("dead workers reconcile into orphaned result and fail hook", async () => {
  const workspaceRoot = makeTempDir();
  const job = { id: "orphan", workspaceRoot, status: "running", pid: 2147483647, resultFile: path.join(workspaceRoot, "result") };
  writeJobFile(workspaceRoot, job.id, job); upsertJob(workspaceRoot, job);
  const changed = await reconcileOrphanedJobs(workspaceRoot);
  assert.equal(changed[0].status, "orphaned");
  assert.equal(JSON.parse(fs.readFileSync(job.resultFile)).status, "orphaned");
  assert.deepEqual(await reconcileOrphanedJobs(workspaceRoot), []);
});

test("pause-and-ask retains thread and does not fire terminal hook", async () => {
  const workspaceRoot = makeTempDir();
  const hookFile = path.join(workspaceRoot, "terminal-hook");
  const job = { id: "question", workspaceRoot, pauseAndAsk: true, hooks: { end: `echo done >> '${hookFile}'` } };
  await runTrackedJob(job, async () => ({ exitStatus: 0, threadId: "same-thread", payload: { rawOutput: JSON.stringify({ question: "Which?", state: "awaiting-answer", draftAnswer: "A", facts: [], itemsHeld: [] }) } }));
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.equal(stored.status, "awaiting-answer"); assert.equal(stored.threadId, "same-thread");
  assert.equal(fs.existsSync(hookFile), false);
  await runTrackedJob(stored, async () => ({ exitStatus: 0, threadId: "same-thread", payload: { rawOutput: "answered" } }));
  assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).status, "completed");
  assert.equal(fs.readFileSync(hookFile, "utf8"), "done\n");
});

test("detached watchdog publishes crash result and unlocks without status polling", async t => {
  const { spawn } = await import("node:child_process");
  const workspaceRoot = makeTempDir();
  cleanupWatchdog(t, workspaceRoot, "crash");
  const resultFile = path.join(workspaceRoot, "crash-result.json");
  const lockFile = path.join(workspaceRoot, "held-lock");
  const hookFile = path.join(workspaceRoot, "failed");
  const socketPath = path.join(workspaceRoot, "crash.sock");
  let finishSignal;
  const notified = new Promise(resolve => finishSignal = resolve);
  const server = net.createServer(socket => {
    let data = "";
    socket.on("data", chunk => {
      data += chunk;
      if (data.endsWith("\n")) { const event = JSON.parse(data); if (event.event === "fail") finishSignal(event); }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const job = { id: "crash", workspaceRoot, structured: true, resultFile, notifySocket: socketPath,
    lockCmd: `touch '${lockFile}'`, unlockCmd: `rm '${lockFile}'`, hooks: { fail: `echo failed >> '${hookFile}'` } };
  const source = `import { runTrackedJob } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};\nawait runTrackedJob(${JSON.stringify(job)}, async () => { process.stdout.write("ready\\n"); await new Promise(() => { setInterval(() => {}, 1000); }); });`;
  const worker = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      worker.stdout.once("data", resolve); worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`Worker exited ${code}`)));
    });
    const exited = new Promise(resolve => worker.once("exit", resolve));
    worker.kill("SIGKILL"); await exited;
    const timeout = setTimeout(() => finishSignal(null), 10000);
    const event = await notified; clearTimeout(timeout);
    assert.equal(event?.status, "orphaned");
    assert.equal(JSON.parse(fs.readFileSync(resultFile)).status, "orphaned");
    assert.equal(fs.existsSync(lockFile), false);
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(hookFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.readFileSync(hookFile, "utf8"), "failed\n");
  } finally { worker.kill("SIGKILL"); await new Promise(resolve => server.close(resolve)); }
});

test("required unlock and result-file failures cannot report successful completion", async t => {
  for (const failure of ["unlock", "result-file"]) {
    const workspaceRoot = makeTempDir();
    cleanupWatchdog(t, workspaceRoot, failure);
    const occupied = path.join(workspaceRoot, "occupied");
    fs.writeFileSync(occupied, "file, not directory");
    const job = { id: failure, workspaceRoot, structured: true,
      ...(failure === "unlock" ? { lockCmd: "true", unlockCmd: "exit 7" } : { resultFile: path.join(occupied, "result.json") }) };
    const execution = await runTrackedJob(job, async () => ({ exitStatus: 0, payload: { rawOutput: "done" }, rendered: "Task done." }));
    assert.notEqual(execution.exitStatus, 0);
    assert.equal(execution.payload.status, "failed");
    assert.equal(execution.payload.error, failure === "unlock" ? "unlock_failed" : "result_file_failed");
    assert.match(execution.rendered, /Job failed:/);
    assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).status, "failed");
  }
});

test("cancellation intent prevents start and supersedes a stop report", async () => {
  const workspaceRoot = makeTempDir();
  let ran = false;
  const queued = { id: "cancel-before-run", workspaceRoot, status: "queued", cancelRequested: true };
  writeJobFile(workspaceRoot, queued.id, queued); upsertJob(workspaceRoot, queued);
  const stopped = await runTrackedJob({ ...queued, cancelRequested: false }, async () => { ran = true; return { exitStatus: 0 }; });
  assert.equal(ran, false); assert.notEqual(stopped.exitStatus, 0);
  assert.equal(readJobFile(resolveJobFile(workspaceRoot, queued.id)).status, "cancelled");
  const asking = { id: "cancel-before-pause", workspaceRoot, pauseAndAsk: true };
  const outcome = await runTrackedJob(asking, async () => {
    const file = resolveJobFile(workspaceRoot, asking.id);
    writeJobFile(workspaceRoot, asking.id, { ...readJobFile(file), cancelRequested: true });
    return { exitStatus: 0, threadId: "t", payload: { rawOutput: JSON.stringify({ question: "Which?", state: "awaiting-answer" }) } };
  });
  assert.notEqual(outcome.exitStatus, 0);
  assert.equal(readJobFile(resolveJobFile(workspaceRoot, asking.id)).status, "cancelled");
});
