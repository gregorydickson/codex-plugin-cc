import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { runAppServerReview, runAppServerTurn, isQuotaError, buildPauseOutputSchema } from "../plugins/codex/scripts/lib/codex.mjs";
import { validateOutputSchema } from "../plugins/codex/scripts/lib/job-results.mjs";
import { resolveRuntimeOptions } from "../plugins/codex/scripts/lib/runtime-options.mjs";
import { installFakeCodex, buildEnv } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

function setup(t, notifications = [], finalMessage = '{"ok":true}') {
  const dir = makeTempDir();
  installFakeCodex(dir);
  const oldPath = process.env.PATH;
  process.env.PATH = buildEnv(dir).PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); });
  const requests = [];
  const client = {
    stderr: "", transport: "direct", notificationHandler: null, exitPromise: new Promise(() => {}),
    setNotificationHandler(handler) { this.notificationHandler = handler; },
    close: async () => {},
    async request(method, params) {
      requests.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread" } };
      if (method === "turn/start" || method === "review/start") {
        queueMicrotask(() => {
          for (const message of notifications) this.notificationHandler?.(message);
          this.notificationHandler?.({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { type: "agentMessage", text: finalMessage } } });
          this.notificationHandler?.({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
        });
        return { turn: { id: "turn", status: "inProgress" } };
      }
      return {};
    }
  };
  t.mock.method(CodexAppServerClient, "connect", async () => client);
  return { dir, requests, client };
}

test("structured reviews use schema-capable turns and preserve runtime options", async (t) => {
  const { dir, requests } = setup(t);
  const schema = { type: "object" };
  const result = await runAppServerReview(dir, { target: { type: "baseBranch", branch: "main" }, effort: "high", outputSchema: schema, config: { mcp_servers: {} }, developerInstructions: "Check security" });
  assert.equal(result.reviewText, '{"ok":true}');
  assert.equal(requests.some((r) => r.method === "review/start"), false);
  const start = requests.find((r) => r.method === "thread/start").params;
  assert.deepEqual(start.config, { mcp_servers: {} });
  assert.equal(start.developerInstructions, "Check security");
  const turn = requests.find((r) => r.method === "turn/start").params;
  assert.deepEqual(turn.outputSchema, schema);
  assert.equal(turn.effort, "high");
  assert.match(turn.input[0].text, /baseBranch/);
});

test("native review effort is applied through thread config", async (t) => {
  const { dir, requests } = setup(t);
  await runAppServerReview(dir, { target: { type: "uncommittedChanges" }, effort: "low" });
  assert.equal(requests.find((r) => r.method === "thread/start").params.config.model_reasoning_effort, "low");
  assert.ok(requests.some((r) => r.method === "review/start"));
});

test("usage sums API requests within a turn without charging prior resumed usage", async (t) => {
  const usage = (total, last) => ({ method: "thread/tokenUsage/updated", params: { threadId: "thread", turnId: "turn", tokenUsage: { total: { totalTokens: total }, last: { totalTokens: last } } } });
  const { dir } = setup(t, [usage(110, 10), usage(125, 15), usage(125, 15)]);
  const result = await runAppServerTurn(dir, { prompt: "hello", resumeThreadId: "thread" });
  assert.deepEqual(result.usage, { totalTokens: 25 });
});

test("quota notification fails immediately with typed exit code, transient rate limits do not", async (t) => {
  const { dir } = setup(t, [{ method: "error", params: { threadId: "thread", turnId: "turn", error: { message: "Exhausted", codexErrorInfo: "usageLimitExceeded" } } }]);
  await assert.rejects(runAppServerTurn(dir, { prompt: "hello" }), (error) => error.code === "quota_exhausted" && error.exitCode === 75);
  assert.equal(isQuotaError({ codexErrorInfo: "rateLimitExceeded" }), false);
});

test("owning transport steering uses expected turn precondition", async (t) => {
  const { dir, requests } = setup(t);
  let steering;
  await runAppServerTurn(dir, { prompt: "hello", onActiveTurn(active) { steering = active.send("also check X"); } });
  await steering;
  assert.deepEqual(requests.find((r) => r.method === "turn/steer").params, { threadId: "thread", expectedTurnId: "turn", input: [{ type: "text", text: "also check X", text_elements: [] }] });
});

test("profiles and TOML MCP replacement disable inherited servers without mutating config", (t) => {
  const dir = makeTempDir();
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  t.after(() => { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true }); });
  const source = '[mcp_servers.old]\ncommand="old"\n[profiles.ro]\nsandbox_mode="read-only"\n';
  fs.writeFileSync(path.join(dir, "config.toml"), source);
  fs.writeFileSync(path.join(dir, "m.toml"), '[mcp_servers.tracker]\ncommand="tracker"\nargs=["--mcp"]\n');
  const result = resolveRuntimeOptions(dir, { profile: "ro", mcpConfig: "m.toml" });
  assert.equal(result.sandbox, "read-only");
  assert.deepEqual(result.activeServers, ["tracker"]);
  assert.equal(result.config.mcp_servers.old.enabled, false);
  assert.equal(result.config.mcp_servers.tracker.command, "tracker");
  assert.equal(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), source);
  assert.throws(() => resolveRuntimeOptions(dir, { profile: "missing" }), /Unknown Codex profile/);
  assert.throws(() => resolveRuntimeOptions(dir, { profile: "../bad" }), /Invalid profile name/);
});

test("fanout cannot report success when model did not produce requested children", async (t) => {
  const { dir } = setup(t);
  await assert.rejects(runAppServerTurn(dir, { prompt: "delegate", fanout: 2 }), (error) => error.code === "fanout_incomplete" && error.requested === 2);
});


test("pause schema uses an object transport, relocates local refs, and decodes completed output", async (t) => {
  const original = { type: "object", additionalProperties: false, required: ["count"], properties: { count: { $ref: "#/$defs/count" } }, $defs: { count: { type: "integer" } } };
  const wrapped = { state: "completed", result: { count: 2 }, question: null, draftAnswer: null, facts: [], itemsHeld: [] };
  const { dir, requests } = setup(t, [], JSON.stringify(wrapped));
  const result = await runAppServerTurn(dir, { prompt: "count", outputSchema: original, pauseAndAsk: true });
  assert.equal(result.finalMessage, '{"count":2}');
  const request = requests.find(r => r.method === "turn/start").params;
  assert.equal(request.outputSchema.type, "object");
  assert.equal(request.outputSchema.additionalProperties, false);
  assert.equal(request.outputSchema.properties.result.anyOf[0].properties.count.$ref, "#/properties/result/anyOf/0/$defs/count");
  assert.match(request.input[0].text, /transport object/);
  assert.equal(original.properties.count.$ref, "#/$defs/count");
  const validate = validateOutputSchema(request.outputSchema);
  assert.equal(validate(wrapped), true);
  assert.equal(validate({ ...wrapped, result: { count: "two" } }), false);
});

test("pause schema decodes a stop report without validating it against the completion result schema", async (t) => {
  const report = { state: "awaiting-answer", result: null, question: "Which?", draftAnswer: "A", facts: ["a:1@abc"], itemsHeld: ["choice"] };
  const { dir } = setup(t, [], JSON.stringify(report));
  const result = await runAppServerTurn(dir, { prompt: "count", outputSchema: { type: "object" }, pauseAndAsk: true });
  const { result: unused, ...expected } = report;
  assert.deepEqual(JSON.parse(result.finalMessage), expected);
});

test("pause schema rejects unsafe reference scopes and preserves literal data with schema-looking keys", () => {
  assert.throws(() => buildPauseOutputSchema({ $ref: "https://example.com/schema" }), /local JSON-pointer/);
  assert.throws(() => buildPauseOutputSchema({ $id: "https://example.com/schema", type: "object" }), /cannot safely wrap/);
  const schema = { type: "object", properties: { $id: { type: "string" }, value: { const: { $ref: "literal" } } } };
  assert.deepEqual(buildPauseOutputSchema(schema).properties.result.anyOf[0], schema);
});
