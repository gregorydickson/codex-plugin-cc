import fs from "node:fs";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withFileLockSync } from "./file-lock.mjs";
import { atomicWriteJson, emitJobEvent, resultEnvelope, resultFilePath, runJobCommand } from "./job-results.mjs";
import { snapshotChangedFiles, changedFilesSince, validateWorktree } from "./worktree-jobs.mjs";
export { resultEnvelope } from "./job-results.mjs";

import { listJobs, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    let progressJob = null;
    withFileLockSync(`${resolveJobFile(workspaceRoot, jobId)}.lock`, () => {
    const current = readStoredJobOrNull(workspaceRoot, jobId);
    if (!current || TERMINAL_STATUSES.has(current.status)) return;
    progressJob = current;
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
    }, { timeoutMs: 45000 });
    if (progressJob) void emitJobEvent(progressJob, "progress", { progress: normalized });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "orphaned"]);

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

function mutateJob(workspaceRoot, jobId, change) {
  return withFileLockSync(`${resolveJobFile(workspaceRoot, jobId)}.lock`, () => {
    const current = readStoredJobOrNull(workspaceRoot, jobId) ?? listJobs(workspaceRoot).find(job => job.id === jobId);
    if (!current) throw new Error(`Unknown job ${jobId}`);
    current.workspaceRoot ??= workspaceRoot;
    const next = change(current);
    writeJobFile(workspaceRoot, jobId, next);
    upsertJob(workspaceRoot, next);
    return next;
  }, { timeoutMs: 45000 });
}

// Persist the final snapshot before releasing ownership. A replay never snapshots
// an unlocked worktree, and each answer starts a fresh segment baseline.
function closeSegment(workspaceRoot, jobId) {
  let job = mutateJob(workspaceRoot, jobId, current => {
    const next = { ...current };
    if (next.changedFilesBefore) {
      try {
        next.changedFiles = [...new Set([...(next.changedFiles ?? []), ...changedFilesSince(next.changedFilesBefore, snapshotChangedFiles(workspaceRoot))])].sort();
        next.result = { ...next.result, changedFiles: next.changedFiles };
      } catch (error) { next.changedFilesError = error.message; }
      next.changedFilesBefore = null;
    }
    if (next.externalLock && next.externalLock.state !== "released") next.externalLock = { ...next.externalLock, state: "releasing" };
    return next;
  });
  if ((job.externalLock && job.externalLock.state !== "released") || job.lockAcquired) {
    try {
      runJobCommand(job.unlockCmd, job);
      job = mutateJob(workspaceRoot, jobId, current => ({ ...current, lockAcquired: false, externalLock: current.externalLock ? { ...current.externalLock, state: "released" } : null, unlockError: null }));
    } catch (error) {
      job = mutateJob(workspaceRoot, jobId, current => ({ ...current, unlockError: error.message }));
    }
  }
  return job;
}

// An outbox entry is acknowledged only after delivery. A crash can replay a
// delivered event; consumers must deduplicate deliveryId, including shell hooks.
export async function replayTerminalDelivery(workspaceRoot, jobId) {
  const stored = readStoredJobOrNull(workspaceRoot, jobId);
  if (stored && TERMINAL_STATUSES.has(stored.status) && (stored.lockAcquired || (stored.externalLock && stored.externalLock.state !== "released"))) closeSegment(workspaceRoot, jobId);
  let claimed = false;
  let job = mutateJob(workspaceRoot, jobId, current => {
    if (!TERMINAL_STATUSES.has(current.status) || !current.terminalDelivery || current.terminalDelivery.delivered || alive(current.terminalDelivery.senderPid) || alive(current.pauseDelivery?.senderPid)) return current;
    claimed = true;
    return { ...current, terminalDelivery: { ...current.terminalDelivery, senderPid: process.pid } };
  });
  if (!claimed) return job;
  const delivery = job.terminalDelivery;
  const errors = await emitJobEvent(job, delivery.event, { ...resultEnvelope(job), deliveryId: delivery.id });
  job = mutateJob(workspaceRoot, jobId, current => {
    if (current.terminalDelivery?.id !== delivery.id) return current;
    return { ...current, deliveryErrors: errors, terminalDelivery: { ...current.terminalDelivery, senderPid: null, delivered: errors.length === 0 } };
  });
  return job;
}

export async function finalizeTrackedJob(workspaceRoot, jobId, patch, options = {}) {
  let claimed = false;
  let job = mutateJob(workspaceRoot, jobId, existing => {
    if (TERMINAL_STATUSES.has(existing.status)) return existing;
    if (options.expectedOwnerPid != null && (!["queued", "running"].includes(existing.status) || (existing.pid ?? existing.workerPid) !== options.expectedOwnerPid)) return existing;
    options.beforeTransition?.(existing);
    if (existing.finalization && alive(existing.finalization.pid)) return { ...existing, cancelRequested: existing.cancelRequested || patch.status === "cancelled" };
    claimed = true;
    return { ...existing, finalization: { pid: process.pid, patch: existing.finalization?.patch ?? patch }, cancelRequested: existing.cancelRequested || patch.status === "cancelled" };
  });
  if (claimed) {
    job = closeSegment(workspaceRoot, jobId);
    job = mutateJob(workspaceRoot, jobId, existing => {
      const terminalPatch = existing.finalization.patch;
      const status = existing.cancelRequested ? "cancelled" : terminalPatch.status;
      const completed = { ...existing, ...terminalPatch, status, pid: null, workerPid: null, completedAt: nowIso(), phase: status === "completed" ? "done" : status, finalization: null };
      if (existing.changedFiles) completed.result = { ...completed.result, changedFiles: existing.changedFiles };
      if (completed.unlockError) {
        completed.status = "failed"; completed.phase = "failed";
        completed.errorCode = "unlock_failed"; completed.errorMessage = `Worktree unlock failed: ${completed.unlockError}`;
      }
      if (completed.worktree && completed.changedFilesError) {
        completed.status = "failed"; completed.phase = "failed";
        completed.errorCode = "changed_files_failed"; completed.errorMessage = `Changed-file report failed: ${completed.changedFilesError}`;
      }
      const envelope = resultEnvelope(completed);
      completed.schemaValid = envelope.schemaValid;
      completed.parseError = envelope.parseError;
      if (completed.resultFile) {
        try { atomicWriteJson(resultFilePath(completed), envelope); }
        catch (error) {
          completed.deliveryErrors = [error.message];
          completed.status = "failed"; completed.phase = "failed";
          completed.errorCode = "result_file_failed"; completed.errorMessage = `Result-file publication failed: ${error.message}`;
        }
      }
      if (completed.unlockError || ["result_file_failed", "changed_files_failed"].includes(completed.errorCode)) completed.rendered = `${completed.rendered ?? ""}\nJob failed: ${completed.errorMessage}\n`;
      completed.terminalDelivery = { id: randomUUID(), event: completed.status === "failed" || completed.status === "orphaned" ? "fail" : "end", delivered: false, senderPid: null };
      return completed;
    });
  }
  return replayTerminalDelivery(workspaceRoot, jobId);
}

export async function reconcileOrphanedJobs(workspaceRoot) {
  const reconciled = [];
  for (const job of listJobs(workspaceRoot)) {
    if (TERMINAL_STATUSES.has(job.status)) {
      if ((job.terminalDelivery && !job.terminalDelivery.delivered) || job.lockAcquired || (job.externalLock && job.externalLock.state !== "released")) await replayTerminalDelivery(workspaceRoot, job.id);
      continue;
    }
    if (!["running", "queued"].includes(job.status) || !Number.isInteger(job.pid ?? job.workerPid) || (job.pid ?? job.workerPid) <= 0) continue;
    try { process.kill(job.pid ?? job.workerPid, 0); }
    catch (error) {
      if (error.code !== "ESRCH") continue;
      reconciled.push(await finalizeTrackedJob(workspaceRoot, job.id, { status: "orphaned", errorMessage: "Worker process exited without completing the job." }, { expectedOwnerPid: job.pid ?? job.workerPid }));
    }
  }
  return reconciled;
}

function startJobWatchdog(job) {
  const watchdog = spawn(process.execPath, [fileURLToPath(new URL("../job-watchdog.mjs", import.meta.url)), job.workspaceRoot, job.id, String(process.pid)], {
    detached: true, stdio: "ignore", env: process.env
  });
  watchdog.on("error", error => appendLogLine(job.logFile, `Watchdog failed: ${error.message}`));
  watchdog.unref();
  return watchdog.pid ?? null;
}

function updateActiveJob(job, update) {
  return withFileLockSync(`${resolveJobFile(job.workspaceRoot, job.id)}.lock`, () => {
    const current = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (current && TERMINAL_STATUSES.has(current.status)) return current;
    const next = update(current ?? job);
    writeJobFile(job.workspaceRoot, job.id, next);
    upsertJob(job.workspaceRoot, next);
    return next;
  }, { timeoutMs: 45000 });
}

function finishedExecution(job, structured) {
  return { exitStatus: job.status === "completed" ? 0 : 1, payload: structured ? resultEnvelope(job) : (job.result ?? null), rendered: job.rendered ?? `Job ${job.id ?? ""} ${job.status}.\n` };
}

export async function runTrackedJob(job, runner, options = {}) {
  let runningRecord;
  try {
    runningRecord = updateActiveJob(job, current => ({ ...current, ...job, status: "running", cancelRequested: Boolean(current.cancelRequested || job.cancelRequested), startedAt: nowIso(), phase: "starting", pid: process.pid, logFile: options.logFile ?? job.logFile ?? null }));
    if (TERMINAL_STATUSES.has(runningRecord.status)) return finishedExecution(runningRecord, job.structured);
    if (job.structured) {
      const watchdogPid = startJobWatchdog(runningRecord);
      runningRecord = updateActiveJob(job, current => ({ ...current, watchdogPid }));
    }
    if (job.worktree) validateWorktree(job.worktree);
    if (job.lockCmd && !runningRecord.cancelRequested) {
      runningRecord = updateActiveJob(job, current => ({ ...current, externalLock: { token: randomUUID(), state: "acquiring", ownerPid: process.pid } }));
      if (TERMINAL_STATUSES.has(runningRecord.status)) return finishedExecution(runningRecord, job.structured);
      if (runningRecord.cancelRequested) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
      runJobCommand(job.lockCmd, runningRecord);
      runningRecord = updateActiveJob(job, current => ({ ...current, lockAcquired: true, externalLock: { ...current.externalLock, state: "acquired" } }));
    }
    runningRecord = updateActiveJob(job, current => {
      const next = { ...current };
      if (next.cancelRequested) return next;
      if (job.worktree) next.changedFilesBefore = snapshotChangedFiles(job.workspaceRoot);
      else if (job.structured || job.write) {
        try { next.changedFilesBefore = snapshotChangedFiles(job.workspaceRoot); } catch (error) { next.changedFilesError = error.message; }
      }
      return next;
    });
    if (TERMINAL_STATUSES.has(runningRecord.status)) return finishedExecution(runningRecord, job.structured);
    if (runningRecord.cancelRequested) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
    await emitJobEvent(runningRecord, "start");
    const beforeRun = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (!beforeRun || TERMINAL_STATUSES.has(beforeRun.status)) return finishedExecution(beforeRun ?? { status: "cancelled" }, job.structured);
    if (beforeRun.cancelRequested) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
    const execution = await runner();
    const payload = execution.payload;
    let stopReport = payload?.result ?? null;
    if (!stopReport && payload?.rawOutput) { try { stopReport = JSON.parse(payload.rawOutput); } catch {} }
    if (job.pauseAndAsk && stopReport?.question && stopReport?.state === "awaiting-answer") {
      let pauseClaimed = false;
      updateActiveJob(job, current => {
        if (current.finalization || current.cancelRequested) return current;
        pauseClaimed = true;
        return { ...current, finalization: { pid: process.pid, patch: null } };
      });
      if (!pauseClaimed) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
      closeSegment(job.workspaceRoot, job.id);
      const paused = updateActiveJob(job, current => {
        if (current.cancelRequested) return { ...current, finalization: null };
        const next = { ...current, status: "awaiting-answer", phase: "awaiting-answer", pid: null, workerPid: null, threadId: execution.threadId, turnId: execution.turnId, result: { ...payload, changedFiles: current.changedFiles ?? [] }, rendered: execution.rendered, finalization: null, pauseDelivery: { id: randomUUID(), senderPid: process.pid } };
        if (next.worktree && next.changedFilesError) throw new Error(`Changed-file report failed: ${next.changedFilesError}`);
        if (next.unlockError) throw new Error(`Worktree unlock failed: ${next.unlockError}`);
        // Publication shares the transition lock: cancellation can only publish
        // after this envelope, never before a stale pause overwrites it.
        if (next.resultFile) atomicWriteJson(resultFilePath(next), resultEnvelope(next));
        return next;
      });
      if (TERMINAL_STATUSES.has(paused.status)) return finishedExecution(paused, job.structured);
      if (paused.cancelRequested) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
      try {
        const latest = readStoredJobOrNull(job.workspaceRoot, job.id);
        if (latest?.status === "awaiting-answer" && latest.pauseDelivery?.id === paused.pauseDelivery.id) await emitJobEvent(paused, "stop-report", { ...resultEnvelope(paused), stopReport, deliveryId: paused.pauseDelivery.id });
      } finally {
        mutateJob(job.workspaceRoot, job.id, current => current.pauseDelivery?.id === paused.pauseDelivery.id ? { ...current, pauseDelivery: null } : current);
        await replayTerminalDelivery(job.workspaceRoot, job.id);
      }
      const afterPause = readStoredJobOrNull(job.workspaceRoot, job.id);
      if (afterPause && TERMINAL_STATUSES.has(afterPause.status)) return finishedExecution(afterPause, job.structured);
      if (job.structured) execution.payload = resultEnvelope(paused);
      return execution;
    }
    const checked = resultEnvelope({ ...job, result: payload });
    if (job.outputSchema && checked.schemaValid === false && execution.exitStatus === 0) execution.exitStatus = 1;
    const completed = await finalizeTrackedJob(job.workspaceRoot, job.id, {
      status: execution.exitStatus === 0 ? "completed" : "failed", threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null, result: payload, rendered: execution.rendered, summary: execution.summary,
      usage: execution.usage ?? payload?.usage ?? null,
      ...(execution.error ? { errorCode: execution.error.error ?? execution.error.code, errorMessage: execution.error.message, retryAfter: execution.error.retryAfter } : {})
    });
    if (completed.status !== "completed" && execution.exitStatus === 0) execution.exitStatus = 1;
    if (completed.unlockError || ["result_file_failed", "changed_files_failed"].includes(completed.errorCode)) execution.rendered = completed.rendered;
    appendLogBlock(runningRecord.logFile, "Final output", execution.rendered);
    if (job.structured) execution.payload = resultEnvelope(completed);
    return execution;
  } catch (error) {
    mutateJob(job.workspaceRoot, job.id, current => current.finalization?.pid === process.pid && !current.finalization.patch ? { ...current, finalization: null } : current);
    await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "failed", errorMessage: error instanceof Error ? error.message : String(error), errorCode: error.code, retryAfter: error.retryAfter });
    throw error;
  }
}
