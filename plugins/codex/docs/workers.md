# Codex workers for orchestrators

The companion CLI can run named, typed background workers. Existing commands keep their default behavior; the options below enable worker behavior explicitly. Run from the repository root, with `C` pointing to `plugins/codex/scripts/codex-companion.mjs` in a checkout or `${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs` in an installed plugin.

```sh
node "$C" task --background --name audit --brief brief.md \
  --output-schema result.schema.json --result-file /tmp/audit-result.json --json
node "$C" status --all-sessions --json
node "$C" status JOB_ID --wait --json
node "$C" result JOB_ID --json
```

Typed results include `{jobId, status, schemaValid, result, parseError}`. Check both terminal status and `schemaValid`; syntactically valid JSON can still fail its schema. Invalid output retains its raw text for diagnosis. Runtime `changedFiles` and `children` metadata is available at the envelope top level so a strict caller schema does not lose metadata or gain unexpected fields. Without a caller schema, these fields are also present inside the worker result. Task, review, and adversarial-review all accept `--output-schema`. Schema-constrained native reviews use a regular schema-capable turn with the selected review target, because Codex `review/start` has no output-schema field. Both review commands also accept `--effort` and `--model`.

## Completion and lifecycle

`--result-file PATH` atomically replaces a JSON result envelope when the worker finishes, fails, is cancelled, or pauses for an answer. `--notify-socket PATH` delivers JSON lines for `start`, `progress`, `stop-report`, `end`, and `fail`. Start the Unix socket listener **before launching the worker**. Progress notifications are best effort and coalesce to the newest pending event while delivery is blocked. Terminal events use a durable outbox and are retried; retain a result file for durable collection.

Optional `--on-start`, `--on-progress`, `--on-stop-report`, `--on-end`, and `--on-fail` shell commands receive lifecycle events. Hooks are caller-authorized executable commands. Terminal delivery is persisted before sending and acknowledged only after the socket and hook succeed. Each terminal event has a stable `deliveryId`, also supplied as `CODEX_JOB_DELIVERY_ID` to the hook. A crash after a side effect but before acknowledgment can replay the event: consumers must atomically deduplicate this ID with their side effect. Arbitrary shell commands cannot provide exactly-once effects without that cooperation. Start/progress/stop-report hooks are best effort. Cancellation and pause result publication are serialized; a stop-report already being delivered finishes before the terminal event.

`cancel JOB_ID` records cancellation and releases acquired or pending lock ownership. If another process is already finalizing, the response reports `cancellationRequested: true` with the current status; wait for the terminal result. A process killed by SIGKILL cannot run cleanup: a detached watcher for structured workers detects a dead worker, marks it `orphaned`, finalizes its result, and attempts cleanup. Terminal retries back off from one second to at most 30 seconds for up to five minutes (an in-flight hook can take another 30 seconds). Pending recovery records survive history pruning. Status/session reconciliation retries pending delivery and lock release after that window or if the watcher dies. Do not treat a missing event as proof a worker is still alive.

## Sessions, messages, and questions

`--name NAME` makes a task persistent across the caller's SessionEnd. `--persistent` does the same without naming it. Default jobs remain tied to their owner session, including jobs launched in another registered worktree. `status --all-sessions` includes owner sessions and jobs in the repository's registered worktrees.

```sh
node "$C" sessions list --json
node "$C" send audit "Also check the empty-input case" --json
node "$C" sessions resume audit "Continue the review" --background --json
node "$C" sessions stop audit --json
```

Steering is acknowledged only after Codex accepts it against the currently active turn. A completed or unavailable turn cannot accept a message. `sessions resume` starts a new job record on the same Codex thread; collect the returned new job ID. Answering a paused job retains its job ID and thread. Stopped named sessions can be resumed after cancellation has finished.

`task --pause-and-ask` adds a brief contract: when blocked on a decision, the worker returns `{question, draftAnswer, facts, itemsHeld, state:"awaiting-answer"}`. Facts use `path:line@sha` references. The job pauses and emits `stop-report`. Resume with `answer JOB_OR_NAME "answer text"`, or `answer JOB_OR_NAME --file answer.txt`. With `--output-schema`, the runtime wraps the caller schema in an internal object transport so the model can return either a completed result or a stop report. Completed output is unwrapped and validated against the original schema; a stop report is separate from completion validation. Local JSON-pointer references are relocated safely; external references, schema IDs, and anchors are rejected for this combination. Review commands do not accept `--pause-and-ask`.

## Context and controlled writes

`--brief FILE` supplies the task brief; repeated `--instructions FILE` supplies project instructions; repeated `--preread FILE` attaches file contents with source paths. The job records the selected context paths.

```sh
node "$C" task --write --worktree /absolute/worktree/root \
  --lock-cmd './lock.sh' --unlock-cmd './unlock.sh' \
  --brief fix.md --instructions AGENTS.md --preread src/example.ts --json
```

`--worktree` must name a Git worktree root. `--lock-cmd` requires `--unlock-cmd`; a failing lock aborts execution. Acquisition intent is persisted before the command runs. Both commands receive `CODEX_JOB_LOCK_TOKEN` (unique to that work segment), `CODEX_JOB_OWNER_PID`, and `CODEX_JOB_WORKTREE`.

Lock commands must implement a token-aware protocol: acquisition atomically records the token, and release is idempotent, releases only that token's ownership, and cancels a pending acquisition even if it has not completed. Fence late acquisition by a surviving shell child using a released-token tombstone or an equivalent lock service guarantee. A bare `rm lockfile` is not a safe recovery protocol. Release can be replayed after a crash or failure; it must never release another worker's lock.

`changedFiles` snapshots run after acquisition and before release, including shell-written files. Pause/answer accumulates each segment's changes and excludes other workers' changes during the unlocked pause. It reports observed changes, not writes reverted before the segment ends. Snapshots stream file content and enforce a 10,000-entry / 64 MiB content budget; explicit worktree accounting fails rather than returning a misleading complete report. Optional accounting outside `--worktree` exposes `changedFilesError` when unavailable.

## Profiles and MCP

`--profile NAME` selects `profiles.NAME` from `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) or `$CODEX_HOME/NAME.config.toml`. Profiles can provide native Codex configuration, including `sandbox_mode` and `mcp_servers`. An explicit profile sandbox takes precedence over `--write`. Unknown profiles fail before execution.

`--mcp-config FILE` accepts TOML with an `[mcp_servers.NAME]` table, or JSON with an `mcp_servers`/`mcpServers` object. It replaces the known inherited server selection for this call: omitted inherited servers are disabled, provided servers are passed as thread configuration. An empty object disables known inherited servers. Result envelopes record selected server names and the effective profile. Private job files also retain the resolved configuration needed to run or resume the job; protect the plugin state directory as credential-bearing data. Public status/session output uses a metadata allowlist and excludes resolved configuration, requests, and executable hook/lock commands. Existing servers supplied by plugin/enterprise layers are subject to Codex's own configuration policy; configuration selection is not proof that a server successfully connected.

A profile may additionally define `networkAllowlist = ["api.example.com"]` (or `network_allowlist`). This enables Codex's network proxy domain enforcement for sandboxed command traffic and refuses runtimes without the feature. It rejects `danger-full-access` profiles. It does **not** constrain hosted web tools, apps, or MCP server network access. Read-only sandboxing continues to prohibit writes. See the [official network proxy behavior](https://learn.chatgpt.com/docs/agent-approvals-security) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Orchestration commands

- `compare --brief B --schema S --against COMMAND --json` runs Codex and the supplied peer command on the same brief/schema and returns structured field disagreements. The peer receives one JSON object on stdin containing `brief` and `schema`, and must write its JSON result to stdout. Both outputs must validate. Peer stdout and stderr share a 1 MiB limit; overflow terminates the peer process group and fails the comparison.
- `verify-claims CLAIMS.json --json` accepts claims with `{id,text,path,line,sha}` and checks the source at the pinned revision. Results have `{id,verdict,evidence}` with verdict `holds`, `false`, or `unverifiable`.
- `task --fanout N ...` enables supported Codex subagent tools, requests N children, and reports observed child results. Unsupported runtimes fail before launch. The companion counts distinct children cumulatively, including replacement and nested children; exceeding N fails with `fanout_limit_exceeded` and attempts to interrupt active work. Completion requires final results from successful completed turns for all N observed children, otherwise it fails with `fanout_incomplete`. Commentary and results from an earlier turn do not satisfy this requirement. Detection depends on runtime notifications, so extra work can start before the companion observes it; this is not a prepaid token budget. Model/tool availability still matters.
- Parent-turn usage is captured from Codex token notifications and exposed as `usage`, including `totalTokens` when reported. Child token usage is not added to that figure. It is token accounting, not a dollar-cost estimate. Quota exhaustion yields `error: "quota_exhausted"`, `retryAfter` when supplied by Codex, and exit status 75. Transient rate limits are not misclassified as quota exhaustion.

The `codex:codex-worker` subagent wraps this interface for callers that need only a validated result envelope. Bundled runtime dependencies ship with the plugin; users do not need to install npm packages in the plugin directory.
