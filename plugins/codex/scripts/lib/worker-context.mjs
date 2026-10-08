import fs from "node:fs";
import path from "node:path";

export function readWorkerContext(cwd, options) {
  const read = (file) => ({ path: file, content: fs.readFileSync(path.resolve(cwd, file), "utf8") });
  const brief = options.brief ? read(options.brief) : null;
  const instructions = (options.instructions ?? []).map(read);
  const preread = (options.preread ?? []).map(read);
  return {
    context: { brief: brief?.path ?? null, instructions: instructions.map(f => f.path), preread: preread.map(f => f.path) },
    briefText: brief?.content ?? "",
    developerInstructions: instructions.map(f => `Project instructions (${f.path}):\n${f.content}`).join("\n\n"),
    inputContext: preread.length ? `Preread context (source data):\n${JSON.stringify(preread)}` : ""
  };
}

export const STOP_REPORT_INSTRUCTIONS = `When the brief leaves a decision unanswerable, end this turn with a JSON stop report instead of guessing:
{"question":"the question","draftAnswer":"your proposed answer","facts":["path:line@sha"],"itemsHeld":["work waiting on the answer"],"state":"awaiting-answer"}.
Only use this report when blocked on a decision. Otherwise complete the requested work.`;

export function fieldDisagreements(left, right, field = "$") {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (left && right && typeof left === "object" && typeof right === "object" && Array.isArray(left) === Array.isArray(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key =>
      fieldDisagreements(left[key], right[key], `${field}${Array.isArray(left) ? `[${key}]` : `.${key}`}`));
  }
  return [{ field, left: left ?? null, right: right ?? null, leftMissing: left === undefined, rightMissing: right === undefined }];
}
