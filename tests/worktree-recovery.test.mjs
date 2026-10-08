import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { snapshotChangedFiles, changedFilesSince, SNAPSHOT_LIMITS } from "../plugins/codex/scripts/lib/worktree-jobs.mjs";
import { saveState, upsertJob, writeJobFile, readJobFile, resolveJobFile, loadState } from "../plugins/codex/scripts/lib/state.mjs";

function git(root, ...args) {
  const result = run("git", args, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
}

test("worktree snapshots reject oversized preexisting content before reading it", () => {
  const root = makeTempDir(); initGitRepo(root);
  const file = path.join(root, "large-cache");
  const fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, SNAPSHOT_LIMITS.bytes + 1); fs.closeSync(fd);
  assert.throws(() => snapshotChangedFiles(root), { code: "worktree_snapshot_limit" });
  fs.unlinkSync(file);
  fs.writeFileSync(path.join(root, "ordinary"), "before");
  const before = snapshotChangedFiles(root);
  fs.writeFileSync(path.join(root, "ordinary"), "after");
  fs.writeFileSync(path.join(root, "__proto__"), "tracked safely");
  assert.deepEqual(changedFilesSince(before, snapshotChangedFiles(root)), ["__proto__", "ordinary"]);
});

test("SessionEnd finds linked-worktree ownership even without main-worktree state", async (t) => {
  const root = makeTempDir(); initGitRepo(root);
  fs.writeFileSync(path.join(root, "tracked"), "initial"); git(root, "add", "."); git(root, "commit", "-m", "initial");
  const linked = path.join(makeTempDir(), "linked"); git(root, "worktree", "add", "-b", "linked", linked);
  const children = [];
  t.after(() => { for (const child of children) { try { process.kill(child.pid, "SIGKILL"); } catch {} } });
  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    await once(child, "spawn"); children.push(child);
  }
  const exited = once(children[0], "exit");
  const resultFile = path.join(makeTempDir(), "cancelled.json");
  for (const job of [
    { id: "owned", sessionId: "ending", pid: children[0].pid, resultFile },
    { id: "other", sessionId: "other", pid: children[1].pid },
    { id: "persistent", sessionId: "ending", persistent: true, pid: children[1].pid },
    { id: "named", sessionId: "ending", name: "keep", pid: children[1].pid }
  ]) {
    const record = { ...job, workspaceRoot: linked, status: "running" };
    writeJobFile(linked, job.id, record); upsertJob(linked, record);
  }
  const result = spawnSync(process.execPath, [new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname, "SessionEnd"], {
    cwd: root, encoding: "utf8", timeout: 15000, input: JSON.stringify({ cwd: root, session_id: "ending" })
  });
  assert.equal(result.status, 0, result.stderr);
  await exited;
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).status, "cancelled");
  assert.doesNotThrow(() => process.kill(children[1].pid, 0));
  assert.deepEqual(loadState(linked).jobs.map(job => job.id).sort(), ["named", "other", "persistent"]);
  for (const id of ["named", "other", "persistent"]) assert.equal(readJobFile(resolveJobFile(linked, id)).status, "running");
});

test("history pruning retains undelivered terminal jobs and unreleased locks", () => {
  const root = makeTempDir();
  for (const job of [
    { id: "pending-event", status: "completed", terminalDelivery: { id: "event", delivered: false } },
    { id: "pending-lock", status: "failed", externalLock: { token: "owner", state: "releasing" } }
  ]) { writeJobFile(root, job.id, job); upsertJob(root, job); }
  const history = Array.from({ length: 55 }, (_, index) => ({ id: `history-${index}`, status: "completed", updatedAt: new Date(Date.now() + index * 1000).toISOString() }));
  // Save a complete snapshot to make ordering independent of wall-clock resolution.
  saveState(root, { jobs: [...loadState(root).jobs, ...history] });
  assert.deepEqual(loadState(root).jobs.map(job => job.id).sort(), ["pending-event", "pending-lock", ...history.slice(5).map(job => job.id)].sort());
  for (const id of ["pending-event", "pending-lock"]) assert.equal(readJobFile(resolveJobFile(root, id)).id, id);
});

test("optional snapshot budget failure is visible without preventing a read-only result", async (t) => {
  const root = makeTempDir(); initGitRepo(root);
  const fd = fs.openSync(path.join(root, "large-cache"), "w");
  fs.ftruncateSync(fd, SNAPSHOT_LIMITS.bytes + 1); fs.closeSync(fd);
  const { runTrackedJob } = await import("../plugins/codex/scripts/lib/tracked-jobs.mjs");
  t.after(() => {
    const pid = readJobFile(resolveJobFile(root, "optional")).watchdogPid;
    if (pid) { try { process.kill(pid); } catch {} }
  });
  const result = await runTrackedJob({ id: "optional", workspaceRoot: root, structured: true }, async () => ({ exitStatus: 0, payload: { rawOutput: "inspected" } }));
  assert.equal(result.payload.status, "completed");
  assert.equal(result.payload.rawOutput, "inspected");
  assert.match(result.payload.changedFilesError, /accounting is incomplete/);
});

test("a final worktree snapshot over budget fails the published completion", async (t) => {
  const root = makeTempDir(); initGitRepo(root);
  const resultFile = path.join(makeTempDir(), "result.json");
  const { runTrackedJob } = await import("../plugins/codex/scripts/lib/tracked-jobs.mjs");
  t.after(() => {
    const pid = readJobFile(resolveJobFile(root, "final-budget")).watchdogPid;
    if (pid) { try { process.kill(pid); } catch {} }
  });
  const result = await runTrackedJob({ id: "final-budget", workspaceRoot: root, worktree: root, structured: true, resultFile }, async () => {
    const fd = fs.openSync(path.join(root, "oversized-output"), "w");
    fs.ftruncateSync(fd, SNAPSHOT_LIMITS.bytes + 1); fs.closeSync(fd);
    return { exitStatus: 0, payload: { rawOutput: "finished" } };
  });
  assert.equal(result.exitStatus, 1);
  assert.equal(result.payload.status, "failed");
  assert.equal(result.payload.error, "changed_files_failed");
  assert.match(result.payload.changedFilesError, /accounting is incomplete/);
  assert.equal(JSON.parse(fs.readFileSync(resultFile)).status, "failed");
});
