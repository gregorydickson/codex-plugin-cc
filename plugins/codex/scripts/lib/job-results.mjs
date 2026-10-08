import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Ajv, Ajv2020 } from "../vendor/runtime-deps.mjs";

export function validateOutputSchema(schema) {
  const Validator = schema?.$schema?.includes("2020-12") ? Ajv2020 : Ajv;
  return new Validator({ allErrors: true, strict: false }).compile(schema);
}

export function resultEnvelope(job) {
  const payload = job.result ?? null;
  const rawOutput = payload?.rawOutput ?? payload?.codex?.stdout ?? job.rawOutput ?? null;
  let result = payload;
  let schemaValid = job.schemaValid ?? null;
  let parseError = job.parseError ?? null;
  if (job.status === "awaiting-answer" && job.pauseAndAsk) {
    schemaValid = null;
    parseError = null;
    try { result = rawOutput != null ? JSON.parse(rawOutput) : (payload?.result ?? payload); }
    catch (error) { result = null; parseError = error.message; }
  } else if (job.outputSchema && payload != null) {
    try {
      result = rawOutput != null ? JSON.parse(rawOutput) : (payload.result ?? payload);
      const validate = validateOutputSchema(job.outputSchema);
      schemaValid = validate(result);
      parseError = schemaValid ? null : JSON.stringify(validate.errors);
    } catch (error) {
      result = null;
      schemaValid = false;
      parseError = error.message;
    }
  }
  return {
    jobId: job.id, status: job.status, schemaValid, result, parseError, rawOutput,
    threadId: job.threadId ?? payload?.threadId ?? null,
    usage: job.usage ?? payload?.usage ?? null,
    changedFiles: payload?.changedFiles ?? job.changedFiles ?? [],
    children: payload?.children ?? job.children ?? [],
    ...(job.unlockError ? { unlockError: job.unlockError } : {}),
    ...(job.deliveryErrors?.length ? { deliveryErrors: job.deliveryErrors } : {}),
    ...(job.changedFilesError ? { changedFilesError: job.changedFilesError } : {}),
    ...(job.errorMessage ? { error: job.errorCode ?? job.errorMessage, retryAfter: job.retryAfter ?? null } : {}),
    job: { id: job.id, name: job.name ?? null, sessionId: job.sessionId ?? null,
      context: job.context ?? null, model: job.model ?? null, effort: job.effort ?? null,
      profile: job.effectiveProfile ?? job.profile ?? null, activeMcpServers: job.activeServers ?? job.activeMcpServers ?? null }
  };
}

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

export function runJobCommand(command, job, event = null) {
  if (!command) return;
  const result = spawnSync(command, {
    shell: true, cwd: job.workspaceRoot, encoding: "utf8", timeout: 30000,
    input: event ? `${JSON.stringify(event)}\n` : "",
    env: { ...process.env, CODEX_JOB_ID: job.id, CODEX_JOB_EVENT: event?.event ?? "", CODEX_JOB_WORKTREE: job.workspaceRoot, CODEX_JOB_DELIVERY_ID: event?.deliveryId ?? "", CODEX_JOB_LOCK_TOKEN: job.externalLock?.token ?? "", CODEX_JOB_OWNER_PID: String(job.externalLock?.ownerPid ?? job.pid ?? process.pid) }
  });
  if (result.error || result.status !== 0) throw new Error(`Job command failed: ${result.error?.message ?? result.stderr ?? result.status}`);
}

const progressDeliveries = new Map();

export function emitJobEvent(job, event, data = {}) {
  if (event !== "progress") return deliverJobEvent(job, event, data);
  const key = `${job.workspaceRoot}:${job.id}`;
  const pending = progressDeliveries.get(key);
  if (pending) {
    pending.latest = { job, data };
    return pending.promise;
  }
  const state = { latest: { job, data }, promise: null };
  progressDeliveries.set(key, state);
  state.promise = (async () => {
    try {
      let errors = [];
      while (state.latest) {
        const next = state.latest;
        state.latest = null;
        errors = await deliverJobEvent(next.job, event, next.data);
      }
      return errors;
    } finally { progressDeliveries.delete(key); }
  })();
  return state.promise;
}

async function deliverJobEvent(job, event, data = {}) {
  const message = { event, jobId: job.id, timestamp: new Date().toISOString(), ...data };
  const failures = [];
  if (job.notifySocket) {
    await new Promise((resolve) => {
      const socket = net.createConnection(job.notifySocket);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) failures.push(error.message);
        socket.destroy(); resolve();
      };
      socket.setTimeout(1000, () => finish(new Error("Notification socket timed out")));
      socket.on("error", finish);
      socket.on("connect", () => socket.end(`${JSON.stringify(message)}\n`, () => finish()));
    }).catch(error => failures.push(error.message));
  }
  try { runJobCommand(job.hooks?.[event], job, message); } catch (error) { failures.push(error.message); }
  return failures;
}
