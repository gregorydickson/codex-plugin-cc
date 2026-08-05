---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script accepts `--wait` and `--background`, but `handleReviewCommand` never branches on `--background` — it always calls `runForegroundCommand`. Claude Code's `Bash(..., run_in_background: true)` is the ONLY thing that detaches the run. Unlike `task`, there is no detached worker, so the review dies with that shell: collecting it is not optional.
- `/codex:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:

`review --background` detaches its own worker and returns IMMEDIATELY with a job id. Run it in the **FOREGROUND**. Do NOT wrap it in `Bash(..., run_in_background: true)`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --background "$ARGUMENTS"
```

- Ensure `--background` is present in the forwarded arguments; add it if the user did not type it, and never pass it twice.
- **Two layers of detachment is a bug, not redundancy.** If you also background the shell, that shell exits about a second later — when the dispatch returns, not when the review finishes — so the harness reports the task complete and collecting it yields the launch banner instead of the review. One layer, and it is the worker.
- Capture the `review-<id>` job id from the dispatch output and tell the user what it is.

Collection is REQUIRED — a dispatch you never collect is a failed review, not a backgrounded one:

- Poll to a terminal phase by **inverting** the terminal test. The phase vocabulary includes at least `queued`, `running`, `reviewing`, and `done`; enumerating in-progress phases breaks out early and loses the run. Loop *unless* the phase is terminal, and keep the loop under the caller's Bash timeout:

  ```bash
  JOB=review-...
  for _ in $(seq 1 25); do
    node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$JOB" --json 2>/dev/null \
      | grep -qE '"(phase|status)"[[:space:]]*:[[:space:]]*"(done|failed|error|cancelled|timeout|completed)"' && break
    sleep 20
  done
  ```

- Fetch the output with `... result "$JOB"` and return it **verbatim**, exactly as in the foreground flow. Do not summarize it, and do not fix anything it reports.
- These runs are slow — a substantial review has been observed still working at 58 minutes. A non-terminal phase means **still running**, not failed. Never report that Codex failed for a run that is merely in progress.
- **If `result` says `No job found`, do not conclude the run is lost — read the job record off disk.** The broker reaps records once a pid dies, but the completed result persists:

  ```bash
  # The data dir is <plugin>-<marketplace>, so NEVER hardcode the marketplace
  # name -- a rename or reinstall changes it and the lookup silently finds
  # nothing. Outside Claude Code (no CLAUDE_PLUGIN_DATA) the companion falls
  # back to $TMPDIR/codex-companion.
  D="$(ls -d "$HOME/.claude/plugins/data/codex-"*/state "${TMPDIR:-/tmp}/codex-companion" 2>/dev/null | head -1)"
  ls -t "$D"/*/jobs/review-*.json 2>/dev/null | head -5
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); r=d.get('result') or {}; print(d['id'], d['status'], d['phase']); print(r.get('rawOutput',''))" <file>
  ```

- Only after `status`, `result`, and the on-disk job record have all been checked may you report a failure — and then say what each one returned rather than reporting silence as "Codex found nothing."
- If you run out of turn before the review is terminal, do not leave a bare "started in the background" stub. Give the user the job id and the exact recovery command (`codex-companion.mjs result <job-id>`), so the run is not silently discarded. The worker outlives this session, so a later session can still collect it.
