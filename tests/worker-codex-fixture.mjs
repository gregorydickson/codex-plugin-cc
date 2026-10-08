import fs from "node:fs";
import path from "node:path";
import { installFakeCodex } from "./fake-codex-fixture.mjs";
export function installWorkerCodex(binDir, behavior = "review-ok") {
  installFakeCodex(binDir, behavior);
  const file = path.join(binDir, "codex");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("        const payload = message.params.outputSchema");
  const end = source.indexOf("\n\n        if (", start);
  if (start < 0 || end < 0) throw new Error("Fixture payload anchor not found");
  const payload = `        const paused = prompt.includes("NEED_ANSWER") && !prompt.includes("Answer to your stop report:");
        const wrapped = message.params.outputSchema?.properties?.state?.enum && message.params.outputSchema?.properties?.result;
        const payload = wrapped
          ? JSON.stringify({ state: paused ? "awaiting-answer" : "completed", result: paused ? null : { count: 2 }, question: paused ? "Which option?" : null, draftAnswer: paused ? "yes" : null, facts: [], itemsHeld: [] })
          : paused ? JSON.stringify({ question: "Which option?", draftAnswer: "yes", facts: [], itemsHeld: [], state: "awaiting-answer" }) : JSON.stringify({ count: 2 });`;

  fs.writeFileSync(file, source.slice(0, start) + payload + source.slice(end));
}
