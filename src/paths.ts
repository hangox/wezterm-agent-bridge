import os from "node:os";
import path from "node:path";

export function defaultStateDir(): string {
  if (process.env.AGENT_BRIDGE_STATE_DIR) {
    return process.env.AGENT_BRIDGE_STATE_DIR;
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "wezterm-agent-bridge");
  }
  return path.join(os.homedir(), ".local", "state", "wezterm-agent-bridge");
}

export function daemonInfoPath(stateDir = defaultStateDir()): string {
  return path.join(stateDir, "daemon.json");
}

export function registryPath(stateDir = defaultStateDir()): string {
  return path.join(stateDir, "sessions.json");
}

export function shimDir(stateDir = defaultStateDir()): string {
  return path.join(stateDir, "shims");
}
