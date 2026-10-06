import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { MODEL_ALIASES } from "../plugins/codex/scripts/lib/models.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /codex-companion\.mjs" review --background "\$ARGUMENTS"/);
  assert.match(source, /Run it in the \*\*FOREGROUND\*\*/);
  assert.match(source, /Two layers of detachment is a bug, not redundancy/);
  assert.match(source, /Collection is REQUIRED/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /Poll to a terminal phase by \*\*inverting\*\* the terminal test/);
  assert.match(source, /result "\$JOB"/);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /codex-companion\.mjs" adversarial-review --background "\$ARGUMENTS"/);
  assert.match(source, /Run it in the \*\*FOREGROUND\*\*/);
  assert.match(source, /Two layers of detachment is a bug, not redundancy/);
  assert.match(source, /Collection is REQUIRED/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /Poll to a terminal phase by \*\*inverting\*\* the terminal test/);
  assert.match(source, /result "\$JOB"/);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /If they ask for `spark`, forward `--model spark`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /forwarding wrapper around the Codex companion task runtime/i);
  assert.match(agent, /Prefer `--background` for anything complicated, open-ended, multi-step, or likely to keep Codex running for a long time/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, or do independent analysis of your own/i);
  assert.match(agent, /Polling and collecting the Codex result is required/i);
  assert.match(agent, /Do not call `review` or `adversarial-review`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `spark`, pass `--model spark` through unchanged/i);
  assert.match(agent, /If the user asks for a concrete model name such as `[^`]+`, pass it through with `--model`/i);
  assert.match(agent, /If the Bash dispatch itself fails or Codex cannot be invoked, say so in one line rather than returning nothing/i);
  assert.match(agent, /^  - codex-prompting$/m);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `codex-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Pass `spark` through as `--model spark`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /--model \S+ --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to its fast, low-cost model alias \(see `MODEL_ALIASES`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("rescue return contract explains caller visibility and preserves recovery and no-findings cases", () => {
  const agent = read("agents/codex-rescue.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  // Pin the prompt contract, not model compliance at runtime.
  assert.match(agent, /caller receives ONLY your final message; your transcript, tool output, and anything you printed earlier are invisible/i);
  assert.match(agent, /"full result above\/below" delivers nothing/i);
  assert.match(agent, /Return the Codex result verbatim in your final message/i);
  assert.match(agent, /Both "I never fetched it" and "I fetched it and summarized" are failures/i);
  assert.match(agent, /If the job genuinely produced no findings, say so explicitly/i);
  assert.match(agent, /If you run out of time before the job is terminal[^\n]+Return the job id and the exact recovery command — `codex-companion\.mjs result <job-id>`/i);
  assert.match(resultHandling, /A completion wrapper alone is not evidence of no findings; retrieve the actual result using the job id before presenting a verdict/i);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/codex-prompting/SKILL.md");
  const promptRecipes = read("skills/codex-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});

function listMarkdown(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listMarkdown(full);
    }
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

test("model alias targets live only in MODEL_ALIASES; docs point there instead of restating them", () => {
  const docs = [path.join(ROOT, "README.md"), ...listMarkdown(PLUGIN_ROOT)];
  const targets = [...MODEL_ALIASES.values()];
  const sparkDocs = docs.filter((file) => /`spark`/.test(fs.readFileSync(file, "utf8")));

  assert.deepEqual(
    sparkDocs.map((file) => path.relative(ROOT, file)).sort(),
    [
      "README.md",
      "plugins/codex/agents/codex-rescue.md",
      "plugins/codex/commands/rescue.md",
      "plugins/codex/skills/codex-cli-runtime/SKILL.md"
    ]
  );
  for (const file of docs) {
    const text = fs.readFileSync(file, "utf8");
    for (const target of targets) {
      assert.equal(text.includes(target), false, `${path.relative(ROOT, file)} restates alias target ${target}`);
    }
  }
  for (const file of sparkDocs) {
    assert.match(fs.readFileSync(file, "utf8"), /`MODEL_ALIASES`/, path.relative(ROOT, file));
  }
});

test("every skill the rescue agent preloads resolves to a skill whose name matches its directory", () => {
  const agent = read("agents/codex-rescue.md");
  const frontmatter = agent.split(/^---$/m)[1];
  const skills = [...frontmatter.matchAll(/^  - (\S+)$/gm)].map((match) => match[1]);

  assert.deepEqual(skills, ["codex-cli-runtime", "codex-prompting"]);
  for (const skill of skills) {
    assert.match(read(`skills/${skill}/SKILL.md`), new RegExp(`^name: ${skill}$`, "m"));
  }
});
