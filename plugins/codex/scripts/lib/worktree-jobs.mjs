import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function validateWorktree(directory) {
  const root = fs.realpathSync(directory);
  const actual = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim());
  if (root !== actual) throw new Error("--worktree must name a Git worktree root.");
  const listed = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root, encoding: "utf8" });
  if (!listed.split("\0").some((entry) => entry === `worktree ${root}`)) throw new Error("Path is not a registered Git worktree root.");
  return root;
}

export const SNAPSHOT_LIMITS = Object.freeze({ entries: 10000, bytes: 64 * 1024 * 1024 });

function snapshotLimit() {
  return Object.assign(new Error("Worktree snapshot exceeds its 10,000-entry or 64 MiB content budget; changed-file accounting is incomplete."), { code: "worktree_snapshot_limit" });
}

export function snapshotChangedFiles(root) {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
  const entries = output.split("\0");
  const snapshot = Object.create(null);
  let count = 0;
  let bytes = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (++count > SNAPSHOT_LIMITS.entries) throw snapshotLimit();
    const file = entry.slice(3);
    const status = entry.slice(0, 2);
    if (/[RC]/.test(status)) i++;
    let digest = "deleted";
    try {
      const target = path.join(root, file);
      const stat = fs.lstatSync(target);
      const hash = createHash("sha256");
      if (stat.isFile()) {
        if (bytes + stat.size > SNAPSHOT_LIMITS.bytes) throw snapshotLimit();
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          let read;
          while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            bytes += read;
            if (bytes > SNAPSHOT_LIMITS.bytes) throw snapshotLimit();
            hash.update(buffer.subarray(0, read));
          }
        } finally { fs.closeSync(fd); }
      } else {
        const content = stat.isSymbolicLink() ? fs.readlinkSync(target) : "directory";
        bytes += Buffer.byteLength(content);
        if (bytes > SNAPSHOT_LIMITS.bytes) throw snapshotLimit();
        hash.update(content);
      }
      digest = hash.update(String(stat.mode)).digest("hex");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    snapshot[file] = `${status}:${digest}`;
  }
  return snapshot;
}

export function changedFilesSince(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
}
