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

export function snapshotChangedFiles(root) {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const entries = output.split("\0");
  const snapshot = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const file = entry.slice(3);
    const status = entry.slice(0, 2);
    if (/[RC]/.test(status)) i++;
    let digest = "deleted";
    try {
      const target = path.join(root, file);
      const stat = fs.lstatSync(target);
      digest = createHash("sha256").update(stat.isSymbolicLink() ? fs.readlinkSync(target) : stat.isFile() ? fs.readFileSync(target) : "directory").update(String(stat.mode)).digest("hex");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    snapshot[file] = `${status}:${digest}`;
  }
  return snapshot;
}

export function changedFilesSince(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
}
