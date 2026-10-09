import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { installWorkerCodex } from "./worker-codex-fixture.mjs";
import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveRuntimeOptions } from "../plugins/codex/scripts/lib/runtime-options.mjs";

const script = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
const THREAD_FIELDS = ["sandbox", "config", "developerInstructions", "cwd"];
const JOB_FIELDS = ["write", "worktree", "lockCmd", "unlockCmd", "outputSchema", "pauseAndAsk", "effectiveProfile", "activeServers", "developerInstructions", "config", "sandbox"];
const pick = (object, fields) => Object.fromEntries(fields.map(field => [field, object[field] ?? null]));

function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function linkedWorktree() {
  const main = makeTempDir(); initGitRepo(main);
  fs.writeFileSync(path.join(main, "README.md"), "hello\n");
  git(main, "add", "README.md"); git(main, "commit", "-m", "init");
  const linked = makeTempDir("codex-plugin-linked-");
  git(main, "worktree", "add", "-b", "slice", linked);
  return { main: fs.realpathSync(main), linked: fs.realpathSync(linked), gitDir: fs.realpathSync(git(linked, "rev-parse", "--absolute-git-dir")) };
}

function writeProfile(codexHome, name, roots) {
  fs.writeFileSync(path.join(codexHome, `${name}.config.toml`), `sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify(roots)}\nnetwork_access = true\n`);
}

function setup(brief = "Count rows") {
  const { main, linked, gitDir } = linkedWorktree();
  const bin = makeTempDir(); installWorkerCodex(bin);
  const files = makeTempDir();
  const env = { ...buildEnv(bin), CODEX_HOME: makeTempDir(), CODEX_COMPANION_SESSION_ID: "resume-tests" };
  writeProfile(env.CODEX_HOME, "edu-test", [path.join(main, ".git")]);
  const file = (name, content) => { const target = path.join(files, name); fs.writeFileSync(target, content); return target; };
  const paths = {
    schema: file("schema.json", JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false })),
    otherSchema: file("other-schema.json", JSON.stringify({ type: "object", required: ["count"], properties: { count: { type: "number" } } })),
    mcp: file("no-mcp.json", JSON.stringify({ mcp_servers: {} })),
    brief: file("slice.md", brief),
    autonomy: file("AUTONOMY.md", "Never push."),
    plan: file("plan.md", "plan-sentinel"),
    lockLog: path.join(files, "lock.log")
  };
  const cli = (...args) => {
    const result = run(process.execPath, [script, ...args, "--json"], { cwd: main, env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const fake = () => JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
  const lockEvents = () => fs.readFileSync(paths.lockLog, "utf8").trim().split("\n");
  const start = (...extra) => cli("task", "--write", "--worktree", linked,
    "--lock-cmd", `echo lock >> '${paths.lockLog}'`, "--unlock-cmd", `echo unlock >> '${paths.lockLog}'`,
    "--profile", "edu-test", "--mcp-config", paths.mcp, "--name", "slice-one", "--pause-and-ask",
    "--brief", paths.brief, "--instructions", paths.autonomy, "--preread", paths.plan,
    "--output-schema", paths.schema, ...extra, "Start the slice");
  return { main, linked, gitDir, env, files, paths, cli, fake, lockEvents, start };
}

function assertInherited(ctx, original, resumed) {
  const requests = ctx.fake().threadRequests;
  const started = requests.find(entry => entry.method === "thread/start" && entry.threadId === original.threadId);
  const continued = requests.at(-1);
  assert.equal(continued.method, "thread/resume");
  assert.equal(continued.threadId, original.threadId);
  assert.equal(continued.sandbox, "workspace-write");
  assert.deepEqual(pick(continued, THREAD_FIELDS), pick(started, THREAD_FIELDS));
  assert.deepEqual(pick(readStoredJob(ctx.linked, resumed.jobId), JOB_FIELDS), pick(readStoredJob(ctx.linked, original.jobId), JOB_FIELDS));
  assert.deepEqual(ctx.lockEvents(), ["lock", "unlock", "lock", "unlock"]);
}

test("task --resume-last inherits the original job's write, worktree, lock, profile, MCP, schema, and instructions", () => {
  const ctx = setup();
  const original = ctx.start();
  assert.equal(original.status, "completed");
  const resumed = ctx.cli("task", "--resume-last", "--worktree", ctx.linked, "Fix round");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.threadId, original.threadId);
  assert.equal(resumed.schemaValid, true);
  assertInherited(ctx, original, resumed);
});

test("sessions resume inherits the original job's options", () => {
  const ctx = setup();
  const original = ctx.start();
  const resumed = ctx.cli("sessions", "resume", "slice-one", "Next slice", "--background");
  ctx.cli("status", resumed.jobId, "--wait");
  assert.equal(ctx.cli("result", resumed.jobId).status, "completed");
  assertInherited(ctx, original, resumed);
});

test("answer keeps the paused job's id, thread, write access, lock, and result-file pattern", () => {
  const ctx = setup("NEED_ANSWER");
  const pattern = path.join(ctx.files, "results", "{jobId}.json");
  const paused = ctx.start("--result-file", pattern);
  assert.equal(paused.status, "awaiting-answer");
  const published = path.join(ctx.files, "results", `${paused.jobId}.json`);
  assert.equal(JSON.parse(fs.readFileSync(published, "utf8")).status, "awaiting-answer");
  const answered = ctx.cli("answer", paused.jobId, "yes");
  assert.equal(answered.status, "completed");
  assert.equal(answered.jobId, paused.jobId);
  const requests = ctx.fake().threadRequests;
  assert.deepEqual(pick(requests.at(-1), THREAD_FIELDS), pick(requests.find(entry => entry.method === "thread/start"), THREAD_FIELDS));
  assert.equal(requests.at(-1).sandbox, "workspace-write");
  assert.match(requests.at(-1).developerInstructions, /Never push\.[\s\S]*JSON stop report/);
  assert.deepEqual(ctx.lockEvents(), ["lock", "unlock", "lock", "unlock"]);
  assert.equal(JSON.parse(fs.readFileSync(published, "utf8")).status, "completed");
});

test("a resume never re-sends the previous slice's brief or preread", () => {
  const ctx = setup("brief-sentinel");
  ctx.start();
  ctx.cli("sessions", "resume", "slice-one", "Next slice");
  const prompt = ctx.fake().lastTurnStart.prompt;
  assert.match(prompt, /^Next slice/);
  assert.doesNotMatch(prompt, /brief-sentinel|plan-sentinel/);
});

test("resume flags override the inherited options", () => {
  const ctx = setup();
  const original = ctx.start();
  const nextBrief = path.join(ctx.files, "next.md");
  fs.writeFileSync(nextBrief, "next-brief-sentinel");
  const resumed = ctx.cli("sessions", "resume", "slice-one", "--brief", nextBrief, "--output-schema", ctx.paths.otherSchema, "--model", "override-model", "Next slice");
  assert.match(ctx.fake().lastTurnStart.prompt, /next-brief-sentinel/);
  const stored = readStoredJob(ctx.linked, resumed.jobId);
  assert.deepEqual(stored.outputSchema, JSON.parse(fs.readFileSync(ctx.paths.otherSchema, "utf8")));
  assert.equal(stored.model, "override-model");
  assert.equal(stored.lockCmd, readStoredJob(ctx.linked, original.jobId).lockCmd);
  assert.equal(ctx.fake().threadRequests.at(-1).sandbox, "workspace-write");
});

test("resume keeps the previous slice's result file unless it is the same job", () => {
  const ctx = setup();
  const first = path.join(ctx.files, "first.json");
  const original = ctx.start("--result-file", first);
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
  const silent = ctx.cli("sessions", "resume", "slice-one", "Second slice");
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
  assert.equal(readStoredJob(ctx.linked, silent.jobId).resultFile, null);
  const second = path.join(ctx.files, "second.json");
  const explicit = ctx.cli("sessions", "resume", "slice-one", "--result-file", second, "Third slice");
  assert.equal(JSON.parse(fs.readFileSync(second, "utf8")).jobId, explicit.jobId);
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
});

test("a {jobId} result-file pattern is inherited and expanded per job", () => {
  const ctx = setup();
  const pattern = path.join(ctx.files, "results", "{jobId}.json");
  const original = ctx.start("--result-file", pattern);
  const resumed = ctx.cli("sessions", "resume", "slice-one", "Next slice");
  for (const job of [original, resumed]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.files, "results", `${job.jobId}.json`), "utf8")).jobId, job.jobId);
  }
  assert.equal(fs.existsSync(pattern), false);
  assert.equal(ctx.cli("status", resumed.jobId).job.resultFile, path.join(ctx.files, "results", `${resumed.jobId}.json`));
});

test("answer publishes to the paused job's own result file", () => {
  const ctx = setup("NEED_ANSWER");
  const resultFile = path.join(ctx.files, "paused.json");
  const paused = ctx.start("--result-file", resultFile);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).status, "awaiting-answer");
  ctx.cli("answer", paused.jobId, "yes");
  const published = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(published.jobId, paused.jobId);
  assert.equal(published.status, "completed");
});

test("a write job on a linked worktree sends its gitdir as a writable root when a granted root contains it", () => {
  const ctx = setup();
  ctx.start();
  const roots = ctx.fake().threadRequests[0].config.sandbox_workspace_write.writable_roots;
  assert.deepEqual(roots, [path.join(ctx.main, ".git"), ctx.gitDir]);
});

test("the linked-worktree gitdir is granted only by containment under a workspace-write sandbox", async () => {
  const { main, linked, gitDir } = linkedWorktree();
  const codexHome = makeTempDir();
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const roots = async (options) => (await resolveRuntimeOptions(options.cwd ?? linked, options)).config?.sandbox_workspace_write?.writable_roots ?? null;
    const unrelated = makeTempDir();
    writeProfile(codexHome, "covers", [path.join(main, ".git")]);
    writeProfile(codexHome, "unrelated", [unrelated]);
    fs.writeFileSync(path.join(codexHome, "readonly.config.toml"), `sandbox_mode = "read-only"\n\n[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([path.join(main, ".git")])}\n`);
    assert.deepEqual(await roots({ profile: "covers", write: true }), [path.join(main, ".git"), gitDir]);
    assert.deepEqual(await roots({ profile: "unrelated", write: true }), [unrelated]);
    assert.deepEqual(await roots({ profile: "readonly", write: true }), [path.join(main, ".git")]);
    assert.deepEqual(await roots({ profile: "covers", write: true, cwd: main }), [path.join(main, ".git")]);
    fs.writeFileSync(path.join(codexHome, "config.toml"), `[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([path.join(main, ".git")])}\nnetwork_access = true\n`);
    const plain = await resolveRuntimeOptions(linked, { write: true });
    assert.deepEqual(plain.config, { "sandbox_workspace_write.writable_roots": [path.join(main, ".git"), gitDir] });
    assert.deepEqual(await resolveRuntimeOptions(linked, {}), {});
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test("a resume waits out a released thread that is still closing", () => {
  const repo = makeTempDir(); initGitRepo(repo);
  const bin = makeTempDir(); installWorkerCodex(bin, "resume-while-closing");
  const env = { ...buildEnv(bin), CODEX_HOME: makeTempDir(), CODEX_COMPANION_SESSION_ID: "closing-tests" };
  const initial = run(process.execPath, [script, "task", "--json", "Start"], { cwd: repo, env });
  assert.equal(initial.status, 0, initial.stderr);
  const resumed = run(process.execPath, [script, "task", "--resume-last", "--json", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  const fake = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
  assert.equal(fake.rejectedClosingResume, true);
  assert.equal(fake.lastTurnStart.threadId, JSON.parse(initial.stdout).threadId);
});

test("a resume refuses to move the session to another worktree or rename it", () => {
  const ctx = setup();
  ctx.start();
  for (const [flags, message] of [[["--worktree", ctx.main], /keeps its original worktree/], [["--name", "renamed"], /--name cannot change on resume/]]) {
    const result = run(process.execPath, [script, "sessions", "resume", "slice-one", ...flags, "--json", "Next"], { cwd: ctx.main, env: ctx.env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});

test("a session recorded before worker arguments were kept resumes from its stored request", () => {
  const ctx = setup();
  const first = path.join(ctx.files, "legacy.json");
  const original = ctx.start("--result-file", first);
  const stored = readStoredJob(ctx.linked, original.jobId);
  delete stored.request.workerArgs;
  writeJobFile(ctx.linked, original.jobId, stored);
  const rejected = run(process.execPath, [script, "sessions", "resume", "slice-one", "--model", "other", "--json", "Next"], { cwd: ctx.main, env: ctx.env });
  assert.match(rejected.stderr, /predates resume overrides/);
  const resumed = ctx.cli("sessions", "resume", "slice-one", "Next slice");
  assert.equal(resumed.status, "completed");
  assert.equal(ctx.fake().threadRequests.at(-1).sandbox, "workspace-write");
  assert.equal(readStoredJob(ctx.linked, resumed.jobId).resultFile, null);
  assert.equal(JSON.parse(fs.readFileSync(first, "utf8")).jobId, original.jobId);
});
