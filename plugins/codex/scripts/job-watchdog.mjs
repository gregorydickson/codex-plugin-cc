import fs from "node:fs";
import process from "node:process";
import { readJobFile, resolveJobFile } from "./lib/state.mjs";
import { finalizeTrackedJob, replayTerminalDelivery, TERMINAL_STATUSES } from "./lib/tracked-jobs.mjs";

const [workspaceRoot, jobId, ownerText] = process.argv.slice(2);
const ownerPid = Number(ownerText);
if (!workspaceRoot || !jobId || !Number.isInteger(ownerPid) || ownerPid <= 0) process.exit(2);
const jobFile = resolveJobFile(workspaceRoot, jobId);
let terminalDeadline = null;
let retryDelayMs = 1000;
while (fs.existsSync(jobFile)) {
  const job = readJobFile(jobFile);
  if (TERMINAL_STATUSES.has(job.status)) {
    terminalDeadline ??= Date.now() + 5 * 60 * 1000;
    if (Date.now() >= terminalDeadline) break;
    await replayTerminalDelivery(workspaceRoot, jobId);
    const updated = readJobFile(jobFile);
    if ((!updated.terminalDelivery || updated.terminalDelivery.delivered) && !updated.lockAcquired && (!updated.externalLock || updated.externalLock.state === "released")) break;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(retryDelayMs, terminalDeadline - Date.now()))));
    retryDelayMs = Math.min(retryDelayMs * 2, 30000);
    continue;
  }
  if (job.status === "awaiting-answer" || job.pid !== ownerPid) break;
  try { process.kill(ownerPid, 0); }
  catch (error) {
    if (error.code === "ESRCH") {
      await finalizeTrackedJob(workspaceRoot, jobId, {
        status: "orphaned", errorMessage: "Worker process exited without completing the job."
      }, { expectedOwnerPid: ownerPid });
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}
