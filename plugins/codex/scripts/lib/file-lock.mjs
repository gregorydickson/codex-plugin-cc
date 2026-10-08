import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));

function readOwner(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function ownerExited(owner) {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function tryAcquire(lockFile, depth = 0) {
  const token = randomUUID();
  const candidate = `${lockFile}.${process.pid}.${token}`;
  fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
  try {
    // Publish complete ownership metadata atomically, without an empty-file window.
    fs.linkSync(candidate, lockFile);
    return () => {
      if (readOwner(lockFile)?.token === token) fs.unlinkSync(lockFile);
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    fs.unlinkSync(candidate);
  }
  const owner = readOwner(lockFile);
  if (!owner || !ownerExited(owner) || depth >= 16) return null;

  // Serialize stale-owner reclamation too: two waiters must never unlink a new
  // owner's lock after both observed the same dead process. Reclamation locks
  // are themselves recoverable if a process dies during this short operation.
  const releaseReaper = tryAcquire(`${lockFile}.reap`, depth + 1);
  if (releaseReaper) {
    try {
      const current = readOwner(lockFile);
      if (current && ownerExited(current)) fs.unlinkSync(lockFile);
    } finally {
      releaseReaper();
    }
  }
  return null;
}

export async function withFileLock(lockFile, action, { timeoutMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  do {
    const release = tryAcquire(lockFile);
    if (release) {
      try { return await action(); } finally { release(); }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for lock: ${lockFile}`);
}

export function withFileLockSync(lockFile, action, { timeoutMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  do {
    const release = tryAcquire(lockFile);
    if (release) {
      try { return action(); } finally { release(); }
    }
    Atomics.wait(pauseBuffer, 0, 0, 20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for lock: ${lockFile}`);
}

export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
