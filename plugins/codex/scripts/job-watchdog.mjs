import fs from "node:fs";
import process from "node:process";
import { readJobFile, resolveJobFile } from "./lib/state.mjs";
import { finalizeTrackedJob, TERMINAL_STATUSES } from "./lib/tracked-jobs.mjs";

const [workspaceRoot, jobId, ownerText] = process.argv.slice(2);
const ownerPid = Number(ownerText);
if (!workspaceRoot || !jobId || !Number.isInteger(ownerPid) || ownerPid <= 0) process.exit(2);
const jobFile = resolveJobFile(workspaceRoot, jobId);
while (fs.existsSync(jobFile)) {
  const job = readJobFile(jobFile);
  if (TERMINAL_STATUSES.has(job.status) || job.status === "awaiting-answer" || job.pid !== ownerPid) break;
  try { process.kill(ownerPid, 0); }
  catch (error) {
    if (error.code === "ESRCH") {
      await finalizeTrackedJob(workspaceRoot, jobId, {
        status: "orphaned", errorMessage: "Worker process exited without completing the job."
      }, { expectedOwnerPid: ownerPid });
      break;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}
