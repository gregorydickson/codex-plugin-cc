import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveJobFile } from "./state.mjs";
import { atomicWriteJson } from "./job-results.mjs";

export function startWorkerControl(workspaceRoot, jobId) {
  const directory = `${resolveJobFile(workspaceRoot, jobId)}.control`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let active = null;
  let busy = false;
  const timer = setInterval(async () => {
    if (!active || busy) return;
    busy = true;
    try {
      for (const file of fs.readdirSync(directory).filter(file => file.endsWith(".request.json")).sort()) {
        const requestPath = path.join(directory, file);
        const replyPath = requestPath.replace(/\.request\.json$/, ".reply.json");
        let reply;
        try {
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          if (!Number.isFinite(request.deadline) || request.deadline < Date.now()) throw new Error("Steering request expired.");
          if (typeof request.message !== "string" || !request.message.trim()) throw new Error("Provide a nonempty steering message.");
          const turn = active;
          if (!turn) throw new Error("The worker no longer has an active turn.");
          await turn.send(request.message);
          reply = { accepted: true, threadId: turn.threadId, turnId: turn.turnId };
        } catch (error) { reply = { accepted: false, error: error.message }; }
        atomicWriteJson(replyPath, reply);
        fs.rmSync(requestPath, { force: true });
      }
    } catch { /* A concurrent sender or shutdown may remove an entry. */ }
    finally { busy = false; }
  }, 50);
  timer.unref();
  return { onActiveTurn: value => { active = value; }, close: () => { active = null; clearInterval(timer); } };
}

export async function sendWorkerMessage(workspaceRoot, jobId, message, timeoutMs = 10000) {
  const directory = `${resolveJobFile(workspaceRoot, jobId)}.control`;
  if (!fs.existsSync(directory)) throw new Error("The worker is not ready for messages.");
  const id = randomUUID();
  const requestPath = path.join(directory, `${id}.request.json`);
  const replyPath = path.join(directory, `${id}.reply.json`);
  const deadline = Date.now() + timeoutMs;
  atomicWriteJson(requestPath, { message, deadline });
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(replyPath)) return JSON.parse(fs.readFileSync(replyPath, "utf8"));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Worker did not acknowledge the message before the timeout.");
  } finally {
    fs.rmSync(requestPath, { force: true });
    fs.rmSync(replyPath, { force: true });
  }
}
