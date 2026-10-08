import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});


test("terminateProcessTree stops a foreground child that has no dedicated process group", { skip: process.platform === "win32" }, async t => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: false });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child, "spawn");
  const exited = once(child, "exit");
  const result = terminateProcessTree(child.pid);
  assert.deepEqual(result, { attempted: true, delivered: true, method: "process" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    const [, signal] = await exited;
    assert.equal(signal, "SIGTERM");
  } finally { clearTimeout(timer); }
});

test("terminateProcessTree rejects invalid process ids before invoking process APIs", () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, null, undefined]) {
    assert.deepEqual(terminateProcessTree(pid, { killImpl() { assert.fail("invalid pid reached kill"); } }), { attempted: false, delivered: false, method: null });
  }
});
