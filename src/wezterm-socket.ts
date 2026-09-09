import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnFile } from "./process.js";

export async function discoverWeztermSocket(): Promise<string | undefined> {
  const envSocket = process.env.WEZTERM_UNIX_SOCKET;
  if (envSocket && await canUseSocket(envSocket)) {
    return envSocket;
  }

  const dir = path.join(os.homedir(), ".local", "share", "wezterm");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const sockets = entries
    .filter((entry) => entry.name.startsWith("gui-sock-"))
    .map((entry) => path.join(dir, entry.name));

  const stats = await Promise.all(sockets.map(async (socket) => {
    try {
      const stat = await fs.promises.stat(socket);
      return { socket, mtimeMs: stat.mtimeMs };
    } catch {
      return undefined;
    }
  }));

  const candidates = stats
    .filter((item): item is { socket: string; mtimeMs: number } => item !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    if (await canUseSocket(candidate.socket)) {
      return candidate.socket;
    }
  }
  return undefined;
}

async function canUseSocket(socket: string): Promise<boolean> {
  const previous = process.env.WEZTERM_UNIX_SOCKET;
  process.env.WEZTERM_UNIX_SOCKET = socket;
  try {
    await spawnFile("wezterm", ["cli", "list", "--format", "json"]);
    return true;
  } catch {
    return false;
  } finally {
    if (previous) {
      process.env.WEZTERM_UNIX_SOCKET = previous;
    } else {
      delete process.env.WEZTERM_UNIX_SOCKET;
    }
  }
}
