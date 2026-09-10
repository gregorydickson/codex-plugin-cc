import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after, afterEach } from "node:test";
import { clearBrokerSession, loadBrokerSession, sendBrokerShutdown, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const tempDirs = new Set();
const allTempDirs = new Set();

async function cleanupBrokers(dirs) {
  for (const cwd of dirs) {
    const session = loadBrokerSession(cwd);
    if (session) {
      await sendBrokerShutdown(session.endpoint);
      teardownBrokerSession({ ...session, killProcess: terminateProcessTree });
      clearBrokerSession(cwd);
    }
  }
}

afterEach(async () => {
  await cleanupBrokers(tempDirs);
  tempDirs.clear();
});

// A background command may finish starting its broker after its test returns.
after(() => cleanupBrokers(allTempDirs));

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  allTempDirs.add(dir);
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
