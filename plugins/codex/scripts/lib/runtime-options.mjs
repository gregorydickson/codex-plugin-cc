import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseToml } from "../vendor/runtime-deps.mjs";

function readConfig(file) {
  const source = fs.readFileSync(file, "utf8");
  const value = path.extname(file).toLowerCase() === ".json" ? JSON.parse(source) : parseToml(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Configuration must be an object: ${file}`);
  return value;
}

function merge(...objects) {
  const result = Object.create(null);
  for (const object of objects) for (const [key, value] of Object.entries(object ?? {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(result[key], value) : value;
  }
  return result;
}

function supportsFeature(name, cwd) {
  const result = spawnSync("codex", ["features", "list"], { cwd, encoding: "utf8", timeout: 5000 });
  return result.status === 0 && result.stdout.split(/\r?\n/).some((line) => line.startsWith(`${name} `));
}

/** Resolve opt-in profiles without mutating the user's Codex configuration. */
export function resolveRuntimeOptions(cwd, options = {}) {
  if (!options.profile && !options.mcpConfig && !options.fanout) return {};
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const userConfigPath = path.join(codexHome, "config.toml");
  const userConfig = fs.existsSync(userConfigPath) ? readConfig(userConfigPath) : {};
  const projectConfigPath = path.join(cwd, ".codex", "config.toml");
  const projectConfig = fs.existsSync(projectConfigPath) ? readConfig(projectConfigPath) : {};
  let profile = {};
  if (options.profile) {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.profile)) throw new Error("Invalid profile name.");
    const profilePath = path.join(codexHome, `${options.profile}.config.toml`);
    profile = fs.existsSync(profilePath) ? readConfig(profilePath) : userConfig.profiles?.[options.profile];
    if (!profile) throw new Error(`Unknown Codex profile: ${options.profile}`);
  }
  const config = merge(profile);
  // Passing a complete server table provides a per-call override, including disabled entries.
  const inheritedServers = merge(userConfig.mcp_servers, projectConfig.mcp_servers, profile.mcp_servers);
  let activeServers = Object.entries(inheritedServers).filter(([, server]) => server.enabled !== false).map(([name]) => name);
  if (options.mcpConfig) {
    const document = readConfig(path.resolve(cwd, options.mcpConfig));
    const servers = document.mcp_servers ?? document.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP configuration requires an mcp_servers object.");
    const overrides = merge(inheritedServers);
    for (const name of Object.keys(overrides)) overrides[name].enabled = false;
    for (const [name, server] of Object.entries(servers)) {
      if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error(`Invalid MCP server: ${name}`);
      overrides[name] = merge(server);
    }
    config.mcp_servers = overrides;
    activeServers = Object.entries(servers).filter(([, server]) => server.enabled !== false).map(([name]) => name);
  }
  const allowlist = profile.networkAllowlist ?? profile.network_allowlist;
  delete config.networkAllowlist;
  delete config.network_allowlist;
  if (allowlist !== undefined) {
    if (!Array.isArray(allowlist) || allowlist.some((host) => typeof host !== "string" || !host.trim())) throw new Error("Profile networkAllowlist must be an array of non-empty host names.");
    if (!supportsFeature("network_proxy", cwd)) throw new Error("This Codex version cannot enforce the profile network allow-list; update Codex.");
    config.features = merge(config.features, { network_proxy: { enabled: true, domains: Object.fromEntries(allowlist.map((host) => [host, "allow"])), allow_upstream_proxy: false } });
    config.sandbox_workspace_write = merge(config.sandbox_workspace_write, { network_access: true });
  }
  if (options.fanout !== undefined) {
    const count = Number(options.fanout);
    if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error("--fanout must be an integer between 1 and 32.");
    if (!supportsFeature("multi_agent", cwd)) throw new Error("This Codex version does not support multi-agent fan-out.");
    config.features = merge(config.features, { multi_agent: true });
    config.agents = merge(config.agents, { enabled: true, max_concurrent_threads_per_session: count });
  }
  const sandbox = profile.sandbox_mode ?? profile.sandbox ?? (options.write ? "workspace-write" : "read-only");
  delete config.sandbox;
  if (sandbox && !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error(`Unsupported sandbox profile: ${sandbox}`);
  if (allowlist !== undefined && sandbox === "danger-full-access") throw new Error("Network allow-lists require a sandboxed profile.");
  return { config, ...(sandbox ? { sandbox } : {}), activeServers: activeServers.sort(), effectiveProfile: options.profile ? { name: options.profile, sandbox: sandbox ?? "read-only", activeServers: activeServers.sort(), networkAllowlist: allowlist ?? null } : null };
}
