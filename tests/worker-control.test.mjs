import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { startWorkerControl, sendWorkerMessage } from "../plugins/codex/scripts/lib/worker-control.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("steering acknowledgement waits for the owning turn and survives turn cleanup", async t => {
  const cwd = makeTempDir();
  const control = startWorkerControl(cwd, "worker");
  t.after(() => control.close());
  let acknowledge;
  let sent;
  const entered = new Promise(resolve => { sent = resolve; });
  control.onActiveTurn({ threadId: "thread-1", turnId: "turn-1", async send(message) {
    assert.equal(message, "check the race");
    sent();
    await new Promise(resolve => { acknowledge = resolve; });
  } });
  let replied = false;
  const reply = sendWorkerMessage(cwd, "worker", "check the race", 2000).then(result => { replied = true; return result; });
  await entered;
  await delay(75);
  assert.equal(replied, false);
  control.onActiveTurn(null);
  acknowledge();
  assert.deepEqual(await reply, { accepted: true, threadId: "thread-1", turnId: "turn-1" });
});

test("steering reports transport rejection and drains malformed requests", async t => {
  const cwd = makeTempDir();
  const control = startWorkerControl(cwd, "worker");
  t.after(() => control.close());
  const directory = `${resolveJobFile(cwd, "worker")}.control`;
  fs.writeFileSync(path.join(directory, "000.request.json"), "malformed");
  control.onActiveTurn({ threadId: "thread", turnId: "turn", send() { throw new Error("turn already completed"); } });
  assert.deepEqual(await sendWorkerMessage(cwd, "worker", "continue", 2000), { accepted: false, error: "turn already completed" });
  assert.equal(fs.existsSync(path.join(directory, "000.request.json")), false);
});

test("expired messages are never delivered when the worker becomes ready later", async t => {
  const cwd = makeTempDir();
  const control = startWorkerControl(cwd, "worker");
  t.after(() => control.close());
  let sent = false;
  await assert.rejects(sendWorkerMessage(cwd, "worker", "late", 100), /did not acknowledge/);
  control.onActiveTurn({ threadId: "thread", turnId: "turn", send() { sent = true; } });
  await delay(100);
  assert.equal(sent, false);
  assert.deepEqual(fs.readdirSync(`${resolveJobFile(cwd, "worker")}.control`), []);
  await assert.rejects(sendWorkerMessage(cwd, "unknown", "hi", 100), /not ready/);
});
