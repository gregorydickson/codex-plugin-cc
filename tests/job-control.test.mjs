import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { writeJobFile, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

const script = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));

test("status wait resolves a linked-worktree name once and polls that job until completion", async () => {
  const cwd = makeTempDir(), linked = makeTempDir(), bin = makeTempDir();
  initGitRepo(cwd);
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd }).status, 0);
  assert.equal(run("git", ["worktree", "add", "-b", "linked", linked], { cwd }).status, 0);
  const job = { id: "task-selected", name: "linked-job", workspaceRoot: linked, status: "running", pid: process.pid, createdAt: new Date().toISOString() };
  writeJobFile(linked, job.id, job); upsertJob(linked, job);
  const callsFile = path.join(bin, "calls.jsonl");
  const observer = path.join(bin, "observe-git.mjs");
  fs.writeFileSync(observer, `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const original = cp.spawnSync; cp.spawnSync = function(command, args, options) { if (command === 'git' && args[0] === 'worktree') fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args)+'\\n'); return original.call(this, command, args, options); }; syncBuiltinESMExports();`);
  const child = spawn(process.execPath, ["--import", observer, script, "status", "linked-job", "--wait", "--poll-interval-ms", "100", "--timeout-ms", "10000", "--json"], { cwd, env: process.env });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  // Wait until target resolution has actually run before changing the selected record.
  const finish = (async () => {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(callsFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(callsFile), "CLI did not resolve worktrees");
    await new Promise(resolve => setTimeout(resolve, 350));
    const completed = { ...job, status: "completed", summary: "selected job finished" };
    writeJobFile(linked, job.id, completed); upsertJob(linked, completed);
  })();
  const code = await new Promise(resolve => child.on("close", resolve));
  await finish;
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.waitTimedOut, false);
  assert.equal(fs.realpathSync(result.workspaceRoot), fs.realpathSync(linked));
  assert.equal(result.job.id, job.id);
  assert.equal(result.job.summary, "selected job finished");
  assert.deepEqual(fs.readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse), [["worktree", "list", "--porcelain", "-z"]]);
});
