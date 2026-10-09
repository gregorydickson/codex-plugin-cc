import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { loadState, resolveJobFile, resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const lifecycleUrl = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
const lockUrl = new URL("../plugins/codex/scripts/lib/file-lock.mjs", import.meta.url).href;
const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url);

function runChild(source, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `Child exited ${code}`)));
  });
}

test("concurrent processes start exactly one workspace broker", async () => {
  const cwd = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin);
  const source = `import {ensureBrokerSession} from ${JSON.stringify(lifecycleUrl)}; console.log(JSON.stringify(await ensureBrokerSession(process.cwd(), {timeoutMs: 5000})));`;
  const results = await Promise.all(Array.from({ length: 8 }, () => runChild(source, cwd, buildEnv(bin))));
  const sessions = results.map((result) => JSON.parse(result));
  assert.ok(sessions.every(Boolean));
  assert.deepEqual(sessions, Array(8).fill(sessions[0]));
  assert.deepEqual(loadBrokerSession(cwd), sessions[0]);
  const fakeState = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.appServerStarts, 1);
});

test("dead startup-lock owners are recovered by concurrent callers", async () => {
  const cwd = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin);
  const lockFile = path.join(resolveStateDir(cwd), "broker.lock");
  await runChild(`import {withFileLock} from ${JSON.stringify(lockUrl)}; await withFileLock(${JSON.stringify(lockFile)}, () => process.exit(0));`, cwd);
  assert.equal(fs.existsSync(lockFile), true);
  const source = `import {ensureBrokerSession} from ${JSON.stringify(lifecycleUrl)}; console.log(JSON.stringify(await ensureBrokerSession(process.cwd(), {timeoutMs: 5000})));`;
  const results = await Promise.all(Array.from({ length: 6 }, () => runChild(source, cwd, buildEnv(bin))));
  const sessions = results.map((result) => JSON.parse(result));
  assert.ok(sessions.every(Boolean));
  assert.deepEqual(sessions, Array(6).fill(sessions[0]));
  assert.equal(fs.existsSync(lockFile), false);
});

test("concurrent state writers retain every independent job", async () => {
  const cwd = makeTempDir();
  await Promise.all(Array.from({ length: 8 }, (_, index) => runChild(`
    import {upsertJob} from ${JSON.stringify(stateUrl)};
    for (let i=0; i<5; i++) upsertJob(process.cwd(), {id: ${JSON.stringify(`writer-${index}-`)} + i, status: 'running'});
  `, cwd)));
  const expected = Array.from({ length: 8 }, (_, i) => Array.from({ length: 5 }, (_, j) => `writer-${i}-${j}`)).flat().sort();
  assert.deepEqual(loadState(cwd).jobs.map((job) => job.id).sort(), expected);
});

test("SessionEnd leaves another session's broker connection and persistent jobs usable", async (t) => {
  const cwd = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin);
  const session = await ensureBrokerSession(cwd, { env: buildEnv(bin), timeoutMs: 5000 });
  assert.ok(session);
  const client = await CodexAppServerClient.connect(cwd, { brokerEndpoint: session.endpoint });
  t.after(() => client.close());
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  await once(sleeper, "spawn");
  t.after(() => { try { process.kill(sleeper.pid); } catch {} });
  for (const job of [
    { id: "ephemeral", sessionId: "ending", status: "completed" },
    { id: "named", sessionId: "ending", status: "running", name: "worker", pid: sleeper.pid },
    { id: "persistent", sessionId: "ending", status: "completed", persistent: true },
    { id: "other", sessionId: "other", status: "running" }
  ]) upsertJob(cwd, job);
  const result = spawnSync(process.execPath, [hook.pathname, "SessionEnd"], {
    cwd, env: buildEnv(bin), encoding: "utf8", input: JSON.stringify({ cwd, session_id: "ending" })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(loadBrokerSession(cwd), session);
  await client.request("account/read", {});
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  assert.deepEqual(loadState(cwd).jobs.map((job) => job.id).sort(), ["named", "other", "persistent"]);
});

test("a live lock owner is not evicted when a waiter times out", async () => {
  const cwd = makeTempDir();
  const lockFile = path.join(cwd, "held.lock");
  const { withFileLock } = await import(lockUrl);
  await withFileLock(lockFile, async () => {
    const owner = fs.readFileSync(lockFile, "utf8");
    const result = await runChild(`
      import {withFileLock} from ${JSON.stringify(lockUrl)};
      try {
        await withFileLock(${JSON.stringify(lockFile)}, () => { throw new Error('entered protected section'); }, {timeoutMs: 100});
      } catch (error) { console.log(error.message); }
    `, cwd);
    assert.match(result, /Timed out waiting for lock/);
    assert.equal(fs.readFileSync(lockFile, "utf8"), owner);
  });
  assert.equal(fs.existsSync(lockFile), false);
});

test("history pruning never forgets active or persistent jobs", () => {
  const cwd = makeTempDir();
  const { jobs } = loadState(cwd);
  assert.deepEqual(jobs, []);
  for (const job of [
    { id: "running", status: "running" },
    { id: "queued", status: "queued" },
    { id: "paused", status: "awaiting-answer" },
    { id: "persistent", status: "completed", persistent: true },
    { id: "named", status: "completed", name: "worker" }
  ]) upsertJob(cwd, { ...job, updatedAt: "2000-01-01T00:00:00.000Z" });
  for (let i = 0; i < 52; i++) upsertJob(cwd, { id: `history-${i}`, status: "completed", updatedAt: new Date(2026, 0, i + 1).toISOString() });
  const ids = loadState(cwd).jobs.map((job) => job.id).sort();
  assert.deepEqual(ids, [...Array.from({ length: 50 }, (_, i) => `history-${i + 2}`), "running", "queued", "paused", "persistent", "named"].sort());
});

test("job discovery includes linked worktrees without mixing workspace state", async () => {
  const cwd = makeTempDir();
  const linked = path.join(makeTempDir(), "linked worktree");
  const git = (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-b", "main"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"]);
  git(["worktree", "add", "-b", "worker", linked]);
  upsertJob(cwd, { id: "main-job", name: "main" });
  upsertJob(linked, { id: "worker-job", name: "worker" });
  const { listJobsAcrossWorktrees } = await import(stateUrl);
  assert.deepEqual(listJobsAcrossWorktrees(cwd).map(({ id, workspaceRoot }) => ({ id, workspaceRoot })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: "main-job", workspaceRoot: fs.realpathSync(cwd) },
    { id: "worker-job", workspaceRoot: fs.realpathSync(linked) }
  ]);
  assert.deepEqual(loadState(cwd).jobs.map((job) => job.id), ["main-job"]);
  const plain = makeTempDir();
  upsertJob(plain, { id: "plain-job" });
  assert.deepEqual(listJobsAcrossWorktrees(plain).map((job) => job.id), ["plain-job"]);
});


test("SessionEnd releases an ephemeral job's external lock and delivers its cancellation", () => {
  const cwd = makeTempDir();
  const marker = path.join(cwd, "unlock.txt");
  const resultFile = path.join(cwd, "result.json");
  const job = {
    id: "locked-worker", workspaceRoot: cwd, sessionId: "ending", status: "running",
    lockAcquired: true, resultFile,
    unlockCmd: `"${process.execPath}" -e "require('fs').writeFileSync('unlock.txt', 'released')"`
  };
  upsertJob(cwd, job);
  writeJobFile(cwd, job.id, job);
  const result = spawnSync(process.execPath, [hook.pathname, "SessionEnd"], {
    cwd, encoding: "utf8", input: JSON.stringify({ cwd, session_id: "ending" })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "released");
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).status, "cancelled");
  assert.deepEqual(loadState(cwd).jobs, []);
  assert.equal(fs.existsSync(resolveJobFile(cwd, job.id)), false);
});

test("SessionEnd interrupts its own turn while retaining the shared broker", async () => {
  const cwd = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin);
  const session = await ensureBrokerSession(cwd, { env: buildEnv(bin), timeoutMs: 5000 });
  assert.ok(session);
  const job = { id: "owned-turn", workspaceRoot: cwd, sessionId: "ending", status: "running", threadId: "owned-thread", turnId: "owned-turn" };
  upsertJob(cwd, job); writeJobFile(cwd, job.id, job);
  const result = spawnSync(process.execPath, [hook.pathname, "SessionEnd"], {
    cwd, env: buildEnv(bin), encoding: "utf8", input: JSON.stringify({ cwd, session_id: "ending" })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8")).lastInterrupt, { threadId: "owned-thread", turnId: "owned-turn" });
  assert.deepEqual(loadBrokerSession(cwd), session);
  assert.deepEqual(loadState(cwd).jobs, []);
});

async function waitForFakeState(bin, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return state;
}

test("the broker releases a disconnected client's threads unless another client still holds them", async () => {
  const cwd = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin, "with-subagent");
  const session = await ensureBrokerSession(cwd, { env: buildEnv(bin), timeoutMs: 5000 });
  const first = await CodexAppServerClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const second = await CodexAppServerClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const shared = (await first.request("thread/start", { cwd })).thread.id;
  const own = (await second.request("thread/start", { cwd })).thread.id;
  await second.request("thread/resume", { threadId: shared, cwd });
  const turnDone = new Promise(resolve => second.setNotificationHandler(message => {
    if (message.method === "turn/completed" && message.params.threadId === own) resolve();
  }));
  await second.request("turn/start", { threadId: own, input: [{ type: "text", text: "spawn a child", text_elements: [] }] });
  await turnDone;
  const child = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8")).threads.find(thread => thread.name === "design-challenger").id;
  await first.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8")).unsubscribed ?? [], []);
  await second.close();
  const expected = [shared, own, child].sort();
  const released = await waitForFakeState(bin, state => expected.every(id => (state.unsubscribed ?? []).includes(id)));
  assert.deepEqual([...(released.unsubscribed ?? [])].sort(), expected);
});
