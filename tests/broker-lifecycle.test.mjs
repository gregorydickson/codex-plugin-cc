import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession, saveBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for process cleanup");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function startBroker(behavior) {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  const session = await ensureBrokerSession(cwd, {
    env: { ...buildEnv(binDir), CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "500" },
    timeoutMs: 5000
  });
  assert.ok(session, "broker must actually start");
  const { appServerPid } = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  return { cwd, session, appServerPid };
}

test("unused broker expires and the next command starts a replacement", async () => {
  const { cwd, session, appServerPid } = await startBroker();
  await waitFor(() => !isAlive(session.pid));
  await waitFor(() => !isAlive(appServerPid));
  assert.equal(loadBrokerSession(cwd), null);
  assert.equal(fs.existsSync(session.pidFile), false);
  if (process.platform !== "win32") {
    assert.equal(fs.existsSync(parseBrokerEndpoint(session.endpoint).path), false);
  }
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const replacement = await ensureBrokerSession(cwd, { env: buildEnv(binDir), timeoutMs: 5000 });
  assert.ok(replacement);
  assert.notEqual(replacement.pid, session.pid);
  await sendBrokerShutdown(replacement.endpoint);
  await waitFor(() => !isAlive(replacement.pid));
});

test("expiring an older broker does not clear a replacement's state", async () => {
  const { cwd, session } = await startBroker();
  const replacement = { endpoint: "unix:/tmp/replacement-broker.sock" };
  saveBrokerSession(cwd, replacement);
  await waitFor(() => !isAlive(session.pid));
  assert.deepEqual(loadBrokerSession(cwd), replacement);
});

test("idle shutdown also reaps an app-server that ignores SIGTERM", async () => {
  const { session, appServerPid } = await startBroker("ignore-shutdown");
  await waitFor(() => !isAlive(session.pid));
  await waitFor(() => !isAlive(appServerPid));
});

test("connected clients survive idle expiry and disconnect starts a fresh timeout", async (t) => {
  const { cwd, session } = await startBroker();
  const client = await CodexAppServerClient.connect(cwd, { brokerEndpoint: session.endpoint });
  t.after(() => client.close());
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(isAlive(session.pid), true);
  await client.request("account/read", {});
  await client.close();
  await waitFor(() => !isAlive(session.pid));
});

test("shutdown completes even when another client holds its socket open", async (t) => {
  const { session } = await startBroker();
  const socket = net.createConnection({ path: parseBrokerEndpoint(session.endpoint).path });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  await sendBrokerShutdown(session.endpoint);
  await waitFor(() => !isAlive(session.pid));
});

test("shutdown request is bounded when an endpoint accepts but never replies", async (t) => {
  const dir = makeTempDir("cxc-test-");
  const endpoint = createBrokerEndpoint(dir);
  const sockets = new Set();
  const server = net.createServer((socket) => sockets.add(socket));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(parseBrokerEndpoint(endpoint).path);
  await once(server, "listening");
  await Promise.race([
    sendBrokerShutdown(endpoint, 100),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Shutdown hung")), 1000);
      timer.unref();
    })
  ]);
});

test("startup timeout terminates the newly spawned broker", async (t) => {
  const cwd = makeTempDir();
  const marker = path.join(cwd, "started.pid");
  const scriptPath = path.join(cwd, "slow-broker.mjs");
  fs.writeFileSync(scriptPath, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
  t.after(() => {
    if (fs.existsSync(marker)) {
      const pid = Number(fs.readFileSync(marker, "utf8"));
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });
  const session = await ensureBrokerSession(cwd, { scriptPath, timeoutMs: 1000 });
  assert.equal(session, null);
  assert.equal(fs.existsSync(marker), true, "fixture must start before the timeout");
  const pid = Number(fs.readFileSync(marker, "utf8"));
  await waitFor(() => !isAlive(pid));
});
