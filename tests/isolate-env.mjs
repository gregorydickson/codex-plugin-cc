import process from "node:process";

// A Claude Code session exports these into every shell. Inherited, they point the
// tests' job state at the live plugin data directory and bind jobs to that session.
for (const name of [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PROJECT_DIR",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE"
]) {
  delete process.env[name];
}
