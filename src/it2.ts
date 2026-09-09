import { BridgeClient } from "./client.js";
import { ensureDaemon } from "./ensure-daemon.js";
import { discoverWeztermSocket } from "./wezterm-socket.js";

export async function runIt2(argv: string[]): Promise<void> {
  const [domain, action, ...rest] = argv;
  if (domain !== "session" || !action) {
    throw new Error("仅支持 it2 session <list|split|run|close|focus|read>");
  }
  if (action !== "list") {
    const socket = await discoverWeztermSocket();
    if (!socket) {
      // discoverWeztermSocket 的自动发现只扫描 wezterm-gui.exe（GUI 实例）留下的
      // gui-sock-* 文件；独立跑的 wezterm-mux-server.exe（不带任何 GUI 窗口的后台
      // mux 进程）不会生成这种文件，走的是它自己的默认 socket，这里发现不了它
      // ——这是已知的发现范围限制，不是随机性 bug（2026-09 用真实 Windows 环境的
      // 内部/外部会话对照验证过：命名管道通信本身没有被跨会话阻断，纯粹是"这台机器
      // 当前没有 gui-sock-* 这种命名的 socket 文件可扫"）。
      throw new Error(
        "未发现可连接的 WezTerm socket。已知范围限制：自动发现只能找到正在运行的 " +
          "wezterm-gui.exe 实例（它才会生成 gui-sock-* 文件）；如果这台机器上只有独立的 " +
          "wezterm-mux-server.exe 在跑、没有任何 GUI 窗口实例，自动发现找不到它，属预期行为。" +
          "请确认：(1) 有至少一个 WezTerm GUI 窗口正在运行；(2) 已设置 WEZTERM_UNIX_SOCKET " +
          "环境变量指向正确的 socket，或在该 GUI 实例创建的 pane 内执行本命令。"
      );
    }
    process.env.WEZTERM_UNIX_SOCKET = socket;
  }
  const client = new BridgeClient(await ensureDaemon());

  if (action === "list") {
    const sessions = await client.sessions();
    for (const session of sessions) {
      if (session.state !== "CLOSED") {
        process.stdout.write(`${session.id}\n`);
      }
    }
    return;
  }

  if (action === "split") {
    const parsed = parseSessionOptions(rest);
    const session = await client.split({
      source: parsed.session,
      vertical: parsed.vertical,
      cwd: parsed.cwd
    });
    process.stdout.write(`Created new pane: ${session.id}\n`);
    return;
  }

  if (action === "run") {
    const parsed = parseSessionOptions(rest, { collectCommand: true });
    if (!parsed.command) {
      throw new Error("it2 session run 缺少 command");
    }
    await client.run({ session: parsed.session, command: parsed.command });
    return;
  }

  if (action === "close") {
    const parsed = parseSessionOptions(rest);
    await client.close({ session: parsed.session });
    return;
  }

  if (action === "focus") {
    const parsed = parseSessionOptions(rest);
    await client.focus({ session: parsed.session });
    return;
  }

  if (action === "read") {
    const parsed = parseSessionOptions(rest);
    process.stdout.write(await client.read({ session: parsed.session, lines: parsed.lines }));
    return;
  }

  throw new Error(`不支持的 it2 session 子命令: ${action}`);
}

function parseSessionOptions(argv: string[], options: { collectCommand?: boolean } = {}): {
  session?: string;
  cwd?: string;
  lines?: number;
  vertical?: boolean;
  command?: string;
} {
  const parsed: ReturnType<typeof parseSessionOptions> = {};
  const command: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (options.collectCommand && command.length > 0) {
      command.push(arg);
      continue;
    }
    if (arg === "-s") {
      parsed.session = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--cwd") {
      parsed.cwd = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "-n") {
      parsed.lines = Number(requireValue(argv, index, arg));
      index += 1;
    } else if (arg === "-v") {
      parsed.vertical = true;
    } else if (arg === "-f") {
      // iTerm2 force close 语义；WezTerm CLI close 本身不弹确认。
    } else if (options.collectCommand) {
      command.push(arg);
    }
  }
  if (command.length > 0) {
    parsed.command = command.join(" ");
  }
  return parsed;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${option} 缺少参数`);
  }
  return value;
}
