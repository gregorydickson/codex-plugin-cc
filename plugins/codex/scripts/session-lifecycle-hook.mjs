#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { loadState, readJobFile, resolveJobFile, resolveStateFile, updateState, upsertJob, writeJobFile } from "./lib/state.mjs";
import { withFileLockSync } from "./lib/file-lock.mjs";
import { interruptAppServerTurn } from "./lib/codex.mjs";
import { finalizeTrackedJob } from "./lib/tracked-jobs.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const owned = (job) => job.sessionId === sessionId && !job.persistent && !job.name;
  const removed = loadState(workspaceRoot).jobs.filter(owned);
  for (const job of removed) {
    if (!["queued", "running", "awaiting-answer"].includes(job.status)) continue;
    if (fs.existsSync(resolveJobFile(workspaceRoot, job.id))) {
      const current = withFileLockSync(`${resolveJobFile(workspaceRoot, job.id)}.lock`, () => {
        const file = resolveJobFile(workspaceRoot, job.id);
        if (!fs.existsSync(file)) return null;
        const latest = { ...job, ...readJobFile(file) };
        if (!owned(latest) || !["queued", "running", "awaiting-answer"].includes(latest.status)) return null;
        const requested = { ...latest, cancelRequested: true };
        writeJobFile(workspaceRoot, job.id, requested); upsertJob(workspaceRoot, requested);
        return requested;
      }, { timeoutMs: 45000 });
      if (!current) continue;
      if (current.status === "running") {
        await interruptAppServerTurn(workspaceRoot, { threadId: current.threadId, turnId: current.turnId });
      }
      await finalizeTrackedJob(workspaceRoot, job.id, { status: "cancelled" }, {
        beforeTransition(current) {
          if (!["queued", "running"].includes(current.status)) return;
          try {
            terminateProcessTree(current.pid ?? current.workerPid ?? Number.NaN);
          } catch {
            // Finalization still releases locks when a worker has already exited.
          }
        }
      });
    } else if (["queued", "running"].includes(job.status)) {
      try { terminateProcessTree(job.pid ?? job.workerPid ?? Number.NaN); } catch {}
    }
  }
  const removedIds = new Set(removed.map((job) => job.id));
  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => !removedIds.has(job.id) || !owned(job));
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  // The broker belongs to the workspace, not to this Claude session. Other
  // sessions and persistent jobs may still use it; its idle timer owns shutdown.
  await cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
