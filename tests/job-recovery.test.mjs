import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { makeTempDir, initGitRepo } from "./helpers.mjs";
import { runTrackedJob, reconcileOrphanedJobs } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { emitJobEvent } from "../plugins/codex/scripts/lib/job-results.mjs";
import { readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const lifecycleUrl = new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href;
const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
function command(source) { return `${quote(process.execPath)} -e ${quote(source)}`; }
function child(source) {
  const worker = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  worker.stdout.on("data", data => output += data);
  worker.stderr.on("data", data => errors += data);
  const exited = new Promise(resolve => worker.once("exit", (code, signal) => resolve({ code, signal, errors })));
  return { worker, exited, async ready() {
    const deadline = Date.now() + 10000;
    while (!output.includes("barrier") && Date.now() < deadline && worker.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(output, /barrier/, errors);
  } };
}
function installBarrier(job, condition, after = false) {
  return `import fs from "node:fs";
    import { resolveJobFile } from ${JSON.stringify(stateUrl)};
    const target = resolveJobFile(${JSON.stringify(job.workspaceRoot)}, ${JSON.stringify(job.id)});
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      let record; if (to === target) record = JSON.parse(fs.readFileSync(from, "utf8"));
      const stop = record && (${condition});
      if (${after}) rename.call(fs, from, to);
      if (stop) { process.stdout.write("barrier\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
      if (!${after}) return rename.call(fs, from, to);
    };`;
}
function locking(workspaceRoot) {
  const external = makeTempDir();
  const held = path.join(external, "held"), effects = path.join(external, "effects");
  return { held, effects, lockCmd: command(`const fs=require('fs'); fs.writeFileSync(${JSON.stringify(held)}, process.env.CODEX_JOB_LOCK_TOKEN);`),
    unlockCmd: command(`const fs=require('fs'); const p=${JSON.stringify(held)}; if(fs.existsSync(p) && fs.readFileSync(p,'utf8')===process.env.CODEX_JOB_LOCK_TOKEN) { fs.unlinkSync(p); fs.appendFileSync(${JSON.stringify(effects)}, 'release\\n'); }`) };
}

for (const boundary of ["acquire", "release", "terminal"]) {
  test(`SIGKILL at ${boundary} boundary recovers durable intent and delivery`, { timeout: 20000 }, async () => {
    const workspaceRoot = makeTempDir();
    const locks = locking(workspaceRoot);
    const deliveries = path.join(workspaceRoot, "deliveries");
    const hook = command(`require('fs').appendFileSync(${JSON.stringify(deliveries)}, process.env.CODEX_JOB_DELIVERY_ID+'\\n')`);
    const job = { id: boundary, workspaceRoot, lockCmd: locks.lockCmd, unlockCmd: locks.unlockCmd, hooks: { end: hook, fail: hook } };
    const condition = boundary === "acquire" ? 'record.externalLock?.state === "acquired"' : boundary === "release" ? 'record.externalLock?.state === "released"' : 'record.status === "completed"';
    const subprocess = child(`${installBarrier(job, condition, boundary === "terminal")}
      import { runTrackedJob } from ${JSON.stringify(lifecycleUrl)};
      await runTrackedJob(${JSON.stringify(job)}, async () => ({ exitStatus: 0, payload: { rawOutput: 'ok' } }));`);
    try {
      await subprocess.ready();
      subprocess.worker.kill("SIGKILL"); await subprocess.exited;
      await reconcileOrphanedJobs(workspaceRoot);
      const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
      assert.equal(stored.status, boundary === "acquire" ? "orphaned" : "completed");
      assert.equal(fs.existsSync(locks.held), false);
      assert.equal(fs.readFileSync(locks.effects, "utf8"), "release\n");
      assert.equal(fs.readFileSync(deliveries, "utf8"), `${stored.terminalDelivery.id}\n`);
      assert.equal(stored.terminalDelivery.delivered, true);
      await reconcileOrphanedJobs(workspaceRoot);
      assert.equal(fs.readFileSync(deliveries, "utf8"), `${stored.terminalDelivery.id}\n`);
    } finally { subprocess.worker.kill("SIGKILL"); }
  });
}

test("terminal delivery retries a failed hook using the same idempotency key", async () => {
  const workspaceRoot = makeTempDir();
  const observed = path.join(workspaceRoot, "observed"), allowed = path.join(workspaceRoot, "allowed");
  const hook = command(`const fs=require('fs'); fs.appendFileSync(${JSON.stringify(observed)},process.env.CODEX_JOB_DELIVERY_ID+'\\n'); if(!fs.existsSync(${JSON.stringify(allowed)})) process.exit(1);`);
  await runTrackedJob({ id: "retry", workspaceRoot, hooks: { end: hook } }, async () => ({ exitStatus: 0 }));
  const first = readJobFile(resolveJobFile(workspaceRoot, "retry"));
  assert.equal(first.terminalDelivery.delivered, false);
  fs.writeFileSync(allowed, "yes");
  await reconcileOrphanedJobs(workspaceRoot);
  assert.equal(fs.readFileSync(observed, "utf8"), `${first.terminalDelivery.id}\n${first.terminalDelivery.id}\n`);
  assert.equal(readJobFile(resolveJobFile(workspaceRoot, "retry")).terminalDelivery.delivered, true);
});

test("pause segments accumulate own writes and exclude writes during the unlocked question", async () => {
  const workspaceRoot = makeTempDir(); initGitRepo(workspaceRoot);
  const locks = locking(workspaceRoot);
  const job = { id: "segments", workspaceRoot, worktree: workspaceRoot, pauseAndAsk: true, lockCmd: locks.lockCmd, unlockCmd: locks.unlockCmd };
  await runTrackedJob(job, async () => {
    fs.writeFileSync(path.join(workspaceRoot, "a"), "first");
    return { exitStatus: 0, threadId: "thread", payload: { rawOutput: JSON.stringify({ state: "awaiting-answer", question: "Continue?" }) } };
  });
  fs.writeFileSync(path.join(workspaceRoot, "other-owner"), "exclude");
  const paused = readJobFile(resolveJobFile(workspaceRoot, job.id));
  await runTrackedJob(paused, async () => { fs.writeFileSync(path.join(workspaceRoot, "b"), "second"); return { exitStatus: 0 }; });
  const completed = readJobFile(resolveJobFile(workspaceRoot, job.id));
  assert.deepEqual(completed.changedFiles, ["a", "b"]);
  assert.deepEqual(completed.result.changedFiles, ["a", "b"]);
});

test("progress delivery coalesces a burst while connection establishment is blocked", async () => {
  const original = net.createConnection;
  const connections = [], delivered = [];
  let active = 0, peak = 0;
  net.createConnection = () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    active++; peak = Math.max(peak, active);
    socket.destroy = () => { active--; };
    socket.end = (message, callback) => { delivered.push(JSON.parse(message)); callback(); };
    connections.push(socket);
    return socket;
  };
  try {
    const job = { id: "progress", workspaceRoot: makeTempDir(), notifySocket: "blocked" };
    const pending = emitJobEvent(job, "progress", { progress: 0 });
    for (let i = 1; i <= 10000; i++) void emitJobEvent(job, "progress", { progress: i });
    assert.equal(connections.length, 1);
    connections[0].emit("connect");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connections.length, 2);
    connections[1].emit("connect");
    await pending;
    assert.equal(connections.length, 2);
    assert.deepEqual(delivered.map(event => event.progress), [0, 10000]);
    assert.equal(peak, 1);
    assert.equal(active, 0);
  } finally { net.createConnection = original; }
});

test("pause publication and concurrent cancellation preserve the terminal result and event order", { timeout: 20000 }, async () => {
  const workspaceRoot = makeTempDir();
  const gate = path.join(workspaceRoot, "gate"), events = path.join(workspaceRoot, "events");
  const job = { id: "pause-race", workspaceRoot, pauseAndAsk: true, resultFile: path.join(workspaceRoot, "result"), hooks: {
    "stop-report": command(`require('fs').appendFileSync(${JSON.stringify(events)},'stop\\n')`),
    end: command(`require('fs').appendFileSync(${JSON.stringify(events)},'end\\n')`)
  } };
  const barrier = installBarrier(job, 'record.status === "awaiting-answer"', true).replace('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);', `while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`);
  const pausing = child(`${barrier}
    import { runTrackedJob } from ${JSON.stringify(lifecycleUrl)};
    await runTrackedJob(${JSON.stringify(job)}, async () => ({ exitStatus: 0, payload: { rawOutput: JSON.stringify({ state: 'awaiting-answer', question: 'Continue?' }) } }));`);
  let cancelling;
  try {
    await pausing.ready();
    cancelling = child(`import { finalizeTrackedJob } from ${JSON.stringify(lifecycleUrl)};
      process.stdout.write('barrier\\n');
      await finalizeTrackedJob(${JSON.stringify(workspaceRoot)}, ${JSON.stringify(job.id)}, { status: 'cancelled' });`);
    await cancelling.ready();
    fs.writeFileSync(gate, "go");
    assert.equal((await pausing.exited).code, 0);
    assert.equal((await cancelling.exited).code, 0);
    await reconcileOrphanedJobs(workspaceRoot);
    assert.equal(JSON.parse(fs.readFileSync(job.resultFile)).status, "cancelled");
    assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).status, "cancelled");
    assert.ok(["end\n", "stop\nend\n"].includes(fs.readFileSync(events, "utf8")));
  } finally { pausing.worker.kill("SIGKILL"); cancelling?.worker.kill("SIGKILL"); }
});

test("serialized worktree writers snapshot only inside their own lock segment", { timeout: 30000 }, async () => {
  const workspaceRoot = makeTempDir(); initGitRepo(workspaceRoot);
  const outside = makeTempDir(), held = path.join(outside, "held"), gate = path.join(outside, "gate"), waiting = path.join(outside, "waiting");
  const lockCmd = command(`const fs=require('fs'); fs.writeFileSync(${JSON.stringify(waiting)},'waiting'); while(true) { try { fs.mkdirSync(${JSON.stringify(held)}); break; } catch(e) { if(e.code!=='EEXIST') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } }`);
  const unlockCmd = command(`require('fs').rmdirSync(${JSON.stringify(held)})`);
  const first = { id: "writer-a", workspaceRoot, worktree: workspaceRoot, lockCmd, unlockCmd };
  const second = { ...first, id: "writer-b" };
  const a = child(`import fs from 'node:fs'; import { runTrackedJob } from ${JSON.stringify(lifecycleUrl)};
    await runTrackedJob(${JSON.stringify(first)}, async () => { process.stdout.write('barrier\\n'); while(!fs.existsSync(${JSON.stringify(gate)})) await new Promise(r=>setTimeout(r,10)); fs.writeFileSync(${JSON.stringify(path.join(workspaceRoot, "a"))},'a'); return {exitStatus:0}; });`);
  let b;
  try {
    await a.ready(); fs.unlinkSync(waiting);
    b = child(`import fs from 'node:fs'; import { runTrackedJob } from ${JSON.stringify(lifecycleUrl)};
      await runTrackedJob(${JSON.stringify(second)}, async () => { fs.writeFileSync(${JSON.stringify(path.join(workspaceRoot, "b"))},'b'); return {exitStatus:0}; });`);
    const deadline = Date.now() + 10000;
    while(!fs.existsSync(waiting) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(fs.existsSync(waiting));
    fs.writeFileSync(gate, "go");
    assert.equal((await a.exited).code, 0); assert.equal((await b.exited).code, 0);
    assert.deepEqual(readJobFile(resolveJobFile(workspaceRoot, first.id)).changedFiles, ["a"]);
    assert.deepEqual(readJobFile(resolveJobFile(workspaceRoot, second.id)).changedFiles, ["b"]);
  } finally { a.worker.kill("SIGKILL"); b?.worker.kill("SIGKILL"); }
});

test("SIGKILL after terminal hook execution replays the stable id without duplicating its effect", { timeout: 20000 }, async () => {
  const workspaceRoot = makeTempDir(), effects = path.join(workspaceRoot, "effect"), attempts = path.join(workspaceRoot, "attempts");
  const hook = command(`const fs=require('fs'), id=process.env.CODEX_JOB_DELIVERY_ID; fs.appendFileSync(${JSON.stringify(attempts)},id+'\\n'); if(!fs.existsSync(${JSON.stringify(effects)})) fs.writeFileSync(${JSON.stringify(effects)},id+'\\n');`);
  const job = { id: "ack-crash", workspaceRoot, hooks: { end: hook } };
  const subprocess = child(`${installBarrier(job, 'record.terminalDelivery?.delivered === true')}
    import { runTrackedJob } from ${JSON.stringify(lifecycleUrl)};
    await runTrackedJob(${JSON.stringify(job)}, async () => ({exitStatus:0}));`);
  try {
    await subprocess.ready(); subprocess.worker.kill("SIGKILL"); await subprocess.exited;
    const pending = readJobFile(resolveJobFile(workspaceRoot, job.id));
    assert.equal(pending.terminalDelivery.delivered, false);
    await reconcileOrphanedJobs(workspaceRoot);
    assert.equal(fs.readFileSync(attempts, "utf8"), `${pending.terminalDelivery.id}\n${pending.terminalDelivery.id}\n`);
    assert.equal(fs.readFileSync(effects, "utf8"), `${pending.terminalDelivery.id}\n`);
  } finally { subprocess.worker.kill("SIGKILL"); }
});
