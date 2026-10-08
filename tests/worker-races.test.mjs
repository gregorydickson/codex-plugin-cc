import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./helpers.mjs";
import { writeJobFile, upsertJob, loadState } from "../plugins/codex/scripts/lib/state.mjs";
import { finalizeTrackedJob, reconcileOrphanedJobs } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

const trackedUrl = new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href;
const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));

async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `Missing synchronization file ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function save(cwd, job) { writeJobFile(cwd, job.id, job); upsertJob(cwd, job); }

test("reconciliation cannot orphan a queued job after its live worker takes ownership", async t => {
  const cwd = makeTempDir();
  const initial = { id: "ownership", workspaceRoot: cwd, status: "queued", pid: 99999999 };
  save(cwd, initial);
  const originalKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === initial.pid && signal === 0) {
      save(cwd, { ...initial, status: "running", pid: process.pid });
      const error = new Error("Old launcher exited"); error.code = "ESRCH"; throw error;
    }
    return originalKill.call(process, pid, signal);
  });
  await reconcileOrphanedJobs(cwd);
  const current = loadState(cwd).jobs[0];
  assert.equal(current.status, "running");
  assert.equal(current.pid, process.pid);
});

test("stale watchdog ownership cannot release a resumed worker's lock or overwrite its result", async () => {
  const cwd = makeTempDir();
  const resultFile = path.join(cwd, "result.json");
  fs.writeFileSync(resultFile, '{"generation":"new"}');
  const job = { id: "resumed", workspaceRoot: cwd, status: "running", pid: process.pid, lockAcquired: true,
    resultFile, unlockCmd: `"${process.execPath}" -e "require('fs').writeFileSync('unlocked', 'yes')"` };
  save(cwd, job);
  const result = await finalizeTrackedJob(cwd, job.id, { status: "orphaned" }, { expectedOwnerPid: 99999999 });
  assert.equal(result.status, "running");
  assert.equal(loadState(cwd).jobs[0].lockAcquired, true);
  assert.equal(fs.existsSync(path.join(cwd, "unlocked")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), { generation: "new" });
});

test("cancellation claims terminal state before the watchdog observes the killed worker", async t => {
  const cwd = makeTempDir();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(sleeper, "spawn");
  t.after(() => { try { sleeper.kill("SIGKILL"); } catch {} });
  const resultFile = path.join(cwd, "result.json");
  const job = { id: "cancel-race", workspaceRoot: cwd, status: "running", pid: sleeper.pid, resultFile };
  save(cwd, job);
  const ready = path.join(cwd, "ready");
  const killed = path.join(cwd, "killed");
  const observed = path.join(cwd, "observed");
  const watcher = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { finalizeTrackedJob } from ${JSON.stringify(trackedUrl)};
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    while (!fs.existsSync(${JSON.stringify(killed)})) await new Promise(resolve => setTimeout(resolve, 10));
    fs.writeFileSync(${JSON.stringify(observed)}, 'observed');
    const result = await finalizeTrackedJob(${JSON.stringify(cwd)}, 'cancel-race', {status:'orphaned'}, {expectedOwnerPid:${sleeper.pid}});
    process.stdout.write(JSON.stringify({ status: result.status, cancelRequested: result.cancelRequested, finalizingStatus: result.finalization?.patch?.status }));
  `], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { watcher.kill("SIGKILL"); } catch {} });
  let output = ""; let errors = "";
  watcher.stdout.on("data", chunk => { output += chunk; });
  watcher.stderr.on("data", chunk => { errors += chunk; });
  const watcherExit = once(watcher, "exit");
  await waitForFile(ready);
  const completed = await finalizeTrackedJob(cwd, job.id, { status: "cancelled" }, {
    beforeTransition(current) {
      assert.equal(current.pid, sleeper.pid);
      sleeper.kill("SIGTERM");
      fs.writeFileSync(killed, "killed");
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(observed)) {
        assert.ok(Date.now() < deadline, "watchdog failed to observe worker exit");
        Atomics.wait(pauseBuffer, 0, 0, 10);
      }
    }
  });
  const [code] = await watcherExit;
  assert.equal(code, 0, errors);
  const observation = JSON.parse(output);
  assert.ok(["running", "cancelled"].includes(observation.status));
  assert.equal(observation.cancelRequested, true);
  if (observation.status === "running") assert.equal(observation.finalizingStatus, "cancelled");
  assert.equal(completed.status, "cancelled");
  assert.equal(loadState(cwd).jobs[0].status, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).status, "cancelled");
});
