import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withFileLockSync } from "./file-lock.mjs";
import { atomicWriteJson, emitJobEvent, resultEnvelope, runJobCommand } from "./job-results.mjs";
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

  return (event) => withFileLockSync(`${resolveJobFile(workspaceRoot, jobId)}.lock`, () => {
    const normalized = normalizeProgressEvent(event);
    const current = readStoredJobOrNull(workspaceRoot, jobId);
    if (!current || TERMINAL_STATUSES.has(current.status)) return;
    if (current) void emitJobEvent(current, "progress", { progress: normalized });
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

export async function finalizeTrackedJob(workspaceRoot, jobId, patch, options = {}) {
  let transitioned = false;
  const completed = withFileLockSync(`${resolveJobFile(workspaceRoot, jobId)}.lock`, () => {
    const existing = readStoredJobOrNull(workspaceRoot, jobId) ?? listJobs(workspaceRoot).find(candidate => candidate.id === jobId);
    if (existing) existing.workspaceRoot ??= workspaceRoot;
    if (!existing) throw new Error(`Unknown job ${jobId}`);
    if (TERMINAL_STATUSES.has(existing.status)) return existing;
    if (options.expectedOwnerPid != null && (!["queued", "running"].includes(existing.status) || (existing.pid ?? existing.workerPid) !== options.expectedOwnerPid)) return existing;
    options.beforeTransition?.(existing);
    const status = existing.cancelRequested ? "cancelled" : patch.status;
    const completed = { ...existing, ...patch, status, pid: null, workerPid: null, completedAt: nowIso(), phase: status === "completed" ? "done" : status };
    if (completed.lockAcquired && completed.unlockCmd) {
      try { runJobCommand(completed.unlockCmd, completed); }
      catch (error) {
        completed.unlockError = error.message;
        completed.status = "failed"; completed.phase = "failed";
        completed.errorCode = "unlock_failed"; completed.errorMessage = `Worktree unlock failed: ${error.message}`;
      }
      completed.lockAcquired = false;
    }
    if (completed.changedFilesBefore) {
      try { completed.result = { ...completed.result, changedFiles: changedFilesSince(completed.changedFilesBefore, snapshotChangedFiles(workspaceRoot)) }; }
      catch (error) { completed.changedFilesError = error.message; }
    }
    const envelope = resultEnvelope(completed);
    completed.schemaValid = envelope.schemaValid;
    completed.parseError = envelope.parseError;
    if (completed.resultFile) {
      try { atomicWriteJson(completed.resultFile, envelope); }
      catch (error) {
        completed.deliveryErrors = [error.message];
        completed.status = "failed"; completed.phase = "failed";
        completed.errorCode = "result_file_failed"; completed.errorMessage = `Result-file publication failed: ${error.message}`;
      }
    }
    if (completed.unlockError || completed.errorCode === "result_file_failed") completed.rendered = `${completed.rendered ?? ""}\nJob failed: ${completed.errorMessage}\n`;
    writeJobFile(workspaceRoot, jobId, completed);
    upsertJob(workspaceRoot, completed);
    transitioned = true;
    return completed;
  }, { timeoutMs: 45000 });
  if (!transitioned) return completed;
  const envelope = resultEnvelope(completed);
  const deliveryErrors = [...(completed.deliveryErrors ?? [])];
  deliveryErrors.push(...await emitJobEvent(completed, completed.status === "failed" || completed.status === "orphaned" ? "fail" : "end", { ...envelope }));
  if (deliveryErrors.length) {
    completed.deliveryErrors = deliveryErrors;
    withFileLockSync(`${resolveJobFile(workspaceRoot, jobId)}.lock`, () => {
      const current = readStoredJobOrNull(workspaceRoot, jobId);
      if (!current || current.completedAt !== completed.completedAt) return;
      const updated = { ...current, deliveryErrors };
      writeJobFile(workspaceRoot, jobId, updated);
      upsertJob(workspaceRoot, updated);
    }, { timeoutMs: 45000 });
  }
  return completed;
}

export async function reconcileOrphanedJobs(workspaceRoot) {
  const reconciled = [];
  for (const job of listJobs(workspaceRoot)) {
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
    runningRecord = updateActiveJob(job, current => {
      const next = { ...current };
      if (next.cancelRequested) return next;
      if (job.worktree) validateWorktree(job.worktree);
      if (job.worktree) next.changedFilesBefore = snapshotChangedFiles(job.workspaceRoot);
      else if (job.structured || job.write) {
        try { next.changedFilesBefore = snapshotChangedFiles(job.workspaceRoot); } catch {}
      }
      if (job.lockCmd) {
        runJobCommand(job.lockCmd, next);
        next.lockAcquired = true;
      }
      return next;
    });
    if (TERMINAL_STATUSES.has(runningRecord.status)) return finishedExecution(runningRecord, job.structured);
    if (runningRecord.cancelRequested) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
    if (job.structured) startJobWatchdog(runningRecord);
    await emitJobEvent(runningRecord, "start");
    const beforeRun = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (!beforeRun || TERMINAL_STATUSES.has(beforeRun.status)) return finishedExecution(beforeRun ?? { status: "cancelled" }, job.structured);
    if (beforeRun.cancelRequested) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
    const execution = await runner();
    const payload = execution.payload;
    let stopReport = payload?.result ?? null;
    if (!stopReport && payload?.rawOutput) { try { stopReport = JSON.parse(payload.rawOutput); } catch {} }
    if (job.pauseAndAsk && stopReport?.question && stopReport?.state === "awaiting-answer") {
      const paused = updateActiveJob(job, current => {
        if (current.cancelRequested) return current;
        const next = { ...current, status: "awaiting-answer", phase: "awaiting-answer", pid: null, workerPid: null, threadId: execution.threadId, turnId: execution.turnId, result: payload, rendered: execution.rendered };
        if (next.lockAcquired) { runJobCommand(next.unlockCmd, next); next.lockAcquired = false; }
        return next;
      });
      if (TERMINAL_STATUSES.has(paused.status)) return finishedExecution(paused, job.structured);
      if (paused.cancelRequested) return finishedExecution(await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "cancelled" }), job.structured);
      if (paused.resultFile) atomicWriteJson(paused.resultFile, resultEnvelope(paused));
      await emitJobEvent(paused, "stop-report", { ...resultEnvelope(paused), stopReport });
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
    if (completed.unlockError || completed.errorCode === "result_file_failed") execution.rendered = completed.rendered;
    appendLogBlock(runningRecord.logFile, "Final output", execution.rendered);
    if (job.structured) execution.payload = resultEnvelope(completed);
    return execution;
  } catch (error) {
    await finalizeTrackedJob(job.workspaceRoot, job.id, { status: "failed", errorMessage: error instanceof Error ? error.message : String(error), errorCode: error.code, retryAfter: error.retryAfter });
    throw error;
  }
}
