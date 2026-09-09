import { ensureDaemon } from "./ensure-daemon.js";
import { ensureIt2Shim } from "./shell.js";
import { spawnFile } from "./process.js";
import { discoverWeztermSocket } from "./wezterm-socket.js";

export async function doctor(): Promise<void> {
  const checks: Array<[string, () => Promise<string>]> = [
    ["node", async () => process.version],
    ["wezterm", async () => (await spawnFile("wezterm", ["--version"])).trim()],
    ["daemon", async () => {
      const info = await ensureDaemon();
      return `127.0.0.1:${info.port} pid=${info.pid}`;
    }],
    ["it2 shim", async () => ensureIt2Shim()],
    ["WEZTERM_PANE", async () => process.env.WEZTERM_PANE ?? "(当前 shell 不在 WezTerm pane 内)"],
    ["WEZTERM_UNIX_SOCKET", async () => process.env.WEZTERM_UNIX_SOCKET ?? await discoverWeztermSocket() ?? "(未发现可连接 socket)"]
  ];

  for (const [name, check] of checks) {
    try {
      process.stdout.write(`${name}: ${await check()}\n`);
    } catch (error) {
      process.stdout.write(`${name}: 失败 - ${(error as Error).message}\n`);
    }
  }
}
