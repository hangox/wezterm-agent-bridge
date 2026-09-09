#!/usr/bin/env node
import { runDaemon } from "./daemon.js";
import { doctor } from "./doctor.js";
import { runIt2 } from "./it2.js";
import { defaultStateDir } from "./paths.js";
import { printPowerShellInit, printShellEnv, printZshInit } from "./shell.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "daemon") {
    // token 只走环境变量，命令行不再接受 --token：argv 会原样出现在本进程的
    // 命令行参数里，本机其它用户可以从 ps / 任务管理器 / Process Explorer 等进程
    // 列表直接看到明文——这是审阅发现的真实公开入口，直接关闭，不留"手动调试可以
    // 绕过"的口子，也不需要再维护一份"用户会不会用 --token"的文档说明。
    if (args.includes("--token")) {
      throw new Error(
        "daemon 不再支持 --token 命令行参数（会把 token 暴露在本进程命令行参数里，" +
          "本机其它用户可能通过 ps/任务管理器看到）。请改用环境变量：" +
          "AGENT_BRIDGE_TOKEN=<token> wezterm-agent-bridge daemon --port <port>"
      );
    }
    await runDaemon({
      port: Number(readOption(args, "--port") ?? "0"),
      token: mustEnv("AGENT_BRIDGE_TOKEN"),
      stateDir: readOption(args, "--state-dir") ?? defaultStateDir()
    });
    return;
  }

  if (command === "it2") {
    await runIt2(args);
    return;
  }

  if (command === "shell-env") {
    const shell = readOption(args, "--shell") ?? "zsh";
    if (shell !== "zsh" && shell !== "powershell") {
      throw new Error("--shell 仅支持 zsh 或 powershell");
    }
    const provider = readOption(args, "--provider") ?? "claude";
    if (provider !== "claude") {
      throw new Error("--provider 当前仅支持 claude");
    }
    await printShellEnv(provider, shell);
    return;
  }

  if (command === "print-zsh-init") {
    printZshInit();
    return;
  }

  if (command === "print-powershell-init") {
    printPowerShellInit();
    return;
  }

  if (command === "init") {
    const target = args[0];
    if (target === "zsh") {
      printZshInstallSnippet();
      return;
    }
    if (target === "powershell") {
      printPowerShellInstallSnippet();
      return;
    }
    throw new Error("仅支持 init zsh 或 init powershell");
  }

  if (command === "doctor") {
    await doctor();
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${name} 缺少参数`);
  }
  return value;
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function printHelp(): void {
  process.stdout.write(`wezterm-agent-bridge

命令:
  daemon --port <port> [--state-dir <dir>]     # token 只能用环境变量传入：AGENT_BRIDGE_TOKEN=<token>。
                                                # 正常情况下这条命令由 ensure-daemon 自动拉起，不需要手动跑；
                                                # 不接受 --token 参数（会把 token 暴露在本进程命令行里）。
  it2 session <list|split|run|close|focus|read>
  shell-env --provider claude [--shell <zsh|powershell>]
  print-zsh-init
  print-powershell-init
  init zsh
  init powershell
  doctor
`);
}

function printZshInstallSnippet(): void {
  process.stdout.write(`# wezterm-agent-bridge
# 放在 ~/.zshrc 靠后位置，确保 miccs/run_claude/claude 等函数已加载完成。
if [[ -n "\${WEZTERM_PANE:-}" ]] && command -v wezterm-agent-bridge >/dev/null 2>&1; then
  eval "$(wezterm-agent-bridge print-zsh-init)"
fi
`);
}

function printPowerShellInstallSnippet(): void {
  process.stdout.write(`# wezterm-agent-bridge
# 放在 PowerShell profile 靠后位置，确保 claude 等用户函数已加载完成。
if ($env:WEZTERM_PANE -and (Get-Command wezterm-agent-bridge -ErrorAction SilentlyContinue)) {
  Invoke-Expression (& wezterm-agent-bridge print-powershell-init)
}
`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
