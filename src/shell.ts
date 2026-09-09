import fs from "node:fs";
import path from "node:path";
import { BridgeClient } from "./client.js";
import { ensureDaemon } from "./ensure-daemon.js";
import { defaultStateDir, shimDir } from "./paths.js";
import { discoverWeztermSocket } from "./wezterm-socket.js";

type ShellKind = "zsh" | "powershell";

/**
 * 实验性原型（默认关闭，未经生产验证，不作为 SEA 的替代方案默认对外宣称）：
 * 官方 Claude Code 在 Windows 上探测 it2 时会用
 * `bash -lc 'command -v it2'` 这种 login shell 去解析路径，Git Bash 报告出来的
 * 永远是 MSYS 风格的 POSIX 路径（`/c/Users/.../it2`），官方代码原样拿去做 Windows
 * 原生进程执行会失败（这个路径本身在 Windows 上就是无效字符串，跟 it2 文件本身是
 * 什么格式完全无关）。
 *
 * 这里换个思路：不改 it2 文件本身，而是用 Git Bash 自己支持的 BASH_ENV 机制
 * （bash 以非交互模式启动时，会先 source `$BASH_ENV` 指向的文件）——生成一个
 * 私有的、只在本次 claude 调用窗口内生效的 BASH_ENV 脚本：只有当 bash 实际执行的
 * 命令字符串（`$BASH_EXECUTION_STRING`）精确等于 `command -v it2`、且本 bridge
 * 显式打开了开关时，才验证真实 it2.cmd 存在、打印它的 Windows 原生绝对路径后
 * 直接退出这个探测 shell；其它任何命令必须完全走 Git Bash 原有行为（链入调用方
 * 原来的 BASH_ENV，如果有的话）。不改用户全局 profile，调用结束后在
 * powershellProviderWrapper 的 finally 里恢复原状。
 *
 * 默认关闭：只有显式设置 AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK=1 才会启用这套
 * 机制，避免在没有真实验证之前变成事实上的默认行为。
 */
export const IT2_BASH_HOOK_ENV_FLAG = "AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK";

/**
 * 纯函数：生成 BASH_ENV 探测钩子脚本的内容，不做 I/O——方便单测直接用真实 bash
 * 执行这段脚本文本做功能验证，不需要先跑一遍 ensureIt2ProbeBashEnvHook 的文件
 * 写入流程，也保证测试用的脚本内容跟生产代码实际生成的完全一致（同一个函数）。
 *
 * @param selfPath 这个脚本自己最终会被写到的路径。用于自引用防护（见下面注释）——
 *   不传时（比如纯内容单测）跳过这层防护，行为不受影响。
 */
export function buildIt2ProbeBashEnvHookScript(selfPath?: string): string {
  const selfGuard = selfPath
    ? `  if [ "\${AGENT_BRIDGE_ORIGINAL_BASH_ENV}" = ${shellQuote(selfPath)} ]; then
    # 防御性检查：如果 AGENT_BRIDGE_ORIGINAL_BASH_ENV 指向
    # 的正是这个钩子脚本自己（比如恢复逻辑没做对、嵌套调用把上一层还没恢复的
    # BASH_ENV 当成了"原始值"），source 自己没有实际意义（. 不会重新触发
    # BASH_ENV 机制，不会死循环，但语义上是自引用、没必要执行），直接跳过。
    :
  else
`
    : "  ";
  const closeGuard = selfPath ? "  fi\n" : "";
  return `# wezterm-agent-bridge 私有 BASH_ENV 探测钩子（实验性，2026-09）
# 只在这两个条件同时成立时短路：(1) 本 bridge 显式打开了开关；
# (2) bash 实际执行的命令字符串精确等于 "command -v it2"。
# 命中就验证真实 it2.cmd 存在、打印它的 Windows 原生绝对路径后退出这个探测 shell；
# 否则不做任何事，链入调用方原来的 BASH_ENV（如果有），保证其它任何命令、
# 退出码、Unicode 路径完全不受影响——这个文件只服务这一个精确匹配的探测场景。
#
# 真实 Windows 上定位到的行为（不是猜的）：Git Bash（MSYS2）login shell 在处理
# 显式 \`exit\` 时，自己会往 stdout 追加一段清屏/光标归位的 ANSI 转义序列
# （\\x1B[H\\x1B[2J\\x1B[3J），跟这个 hook 脚本本身的逻辑无关——纯粹是 login shell
# 遇到 exit 的收尾行为，任何 "bash -lc '...; exit 0'" 都会触发，不局限于这个探测
# 场景。这里下面这次 exit 0 同样会触发它，如果不处理，混进 stdout 的这段噪音会
# 跟在路径后面，让"整个探测的原生 stdout"不再是一个干净的、只含路径的输出——
# 官方实际解析算法（2026-09 直接核实 Claude Code Windows 2.1.263 二进制字节
# 185352443 附近源码确认，不是猜测）：
#   s.stdout.split('\\n').map(m => m.trim()).filter(Boolean).at(-1) ?? ""
# 即"取最后一条非空 trim 行"，这一层没有做任何 ANSI 清洗——如果这次 exit 触发的
# login shell 收尾 ANSI 噪音（\\x1B[H\\x1B[2J\\x1B[3J，跟 hook 逻辑本身无关，见上）
# 混进被捕获的 stdout、且出现在路径之后，会被 .at(-1) 当成"最后一条非空行"选中，
# 覆盖掉真实路径。这里不去猜测/依赖官方解析细节，直接让这次 exit 前、这个探测
# shell 自己贡献的 stdout 部分绝对干净：打印路径后立即把当前 shell 自己的 stdout
# （只有 stdout，fd 1）重定向到 /dev/null 再 exit——login shell 收尾时可能产生的
# 任何输出（包括这段 ANSI 序列）都会流向 /dev/null，不会出现在调用方实际捕获到的
# stdout 里。
#
# 故意不重定向 stderr（fd 2）：这个 exec 只截断这一次精确匹配的探测 probe 自身的
# 后续 stdout，不是要把这个 shell 变成完全静默——如果 exit 前后有真实错误需要
# 诊断（比如别的钩子逻辑或环境本身在退出路径上出问题），stderr 应该继续可见，
# 不能被这次修复顺带吞掉。普通命令（不匹配这个精确探测场景）完全不受这段代码
# 影响，走的是下面第二个 if 分支，跟这里无关。
#
# printf 用 '\\n%s\\n' 而不是 '%s\\n'：前导换行是防御性写法，避免路径行意外跟
# 运行到这里之前可能已经产生的、还没被消费的其它输出（比如 login shell 的
# 启动阶段横幅/profile 输出）粘连在同一行——官方按"最后非空行"取值，只要路径
# 本身独占一整行、且之后没有新的非空内容覆盖它，前面出现多少行别的内容都不影响
# 解析结果。
if [ "\${${IT2_BASH_HOOK_ENV_FLAG}:-}" = "1" ] && [ "\${BASH_EXECUTION_STRING:-}" = "command -v it2" ]; then
  if [ -n "\${AGENT_BRIDGE_IT2_CMD_PATH:-}" ] && [ -f "\${AGENT_BRIDGE_IT2_CMD_PATH}" ]; then
    printf '\\n%s\\n' "\${AGENT_BRIDGE_IT2_CMD_PATH}"
    exec >/dev/null
    exit 0
  fi
fi

if [ -n "\${AGENT_BRIDGE_ORIGINAL_BASH_ENV:-}" ] && [ -f "\${AGENT_BRIDGE_ORIGINAL_BASH_ENV}" ]; then
${selfGuard}  . "\${AGENT_BRIDGE_ORIGINAL_BASH_ENV}"
${closeGuard}fi
`;
}

/**
 * 生成钩子脚本文件。原子写入（先写临时文件、rename 覆盖）——避免同名文件被多个
 * 并发调用同时读写时出现"读到一半写"的截断窗口；mode 0600 是 POSIX 侧的尽力而为
 * （Windows 上这个 mode 位基本不生效，真正的访问控制要靠 NTFS ACL，这里不假装
 * 它能在 Windows 上起到等价保护作用，只是跟仓库其它同类临时文件写入方式保持一致）。
 */
async function ensureIt2ProbeBashEnvHook(stateDir: string): Promise<string> {
  const hookPath = path.join(stateDir, "it2-probe-bash-env.sh");
  await fs.promises.mkdir(stateDir, { recursive: true });
  const tmpPath = `${hookPath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmpPath, buildIt2ProbeBashEnvHookScript(hookPath), { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(tmpPath, hookPath);
  return hookPath;
}

export async function printShellEnv(provider: string, shell: ShellKind = "zsh"): Promise<void> {
  const socket = await discoverWeztermSocket();
  if (socket) {
    process.env.WEZTERM_UNIX_SOCKET = socket;
  }
  const info = await ensureDaemon();
  const shims = await ensureIt2Shim();
  const paneId = process.env.WEZTERM_PANE;
  let sessionId = process.env.AGENT_BRIDGE_SESSION_ID;
  if (paneId) {
    const session = await new BridgeClient(info).register({
      paneId,
      provider,
      cwd: process.cwd()
    });
    sessionId = session.id;
  }

  const exports: Record<string, string> = {
    AGENT_BRIDGE_PORT: String(info.port),
    AGENT_BRIDGE_TOKEN: info.token,
    AGENT_BRIDGE_STATE_DIR: defaultStateDir(),
    AGENT_BRIDGE_SHIM_DIR: shims,
    AGENT_BRIDGE_PROVIDER: provider,
    PATH: `${shims}${path.delimiter}${process.env.PATH ?? ""}`,
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "3.5.0",
    LC_TERMINAL: "iTerm2"
  };
  if (socket) {
    exports.WEZTERM_UNIX_SOCKET = socket;
  }
  if (sessionId) {
    exports.AGENT_BRIDGE_SESSION_ID = sessionId;
    exports.ITERM_SESSION_ID = `w0t0p0:${sessionId}`;
  }

  // 实验性 BASH_ENV 探测钩子：只在 Windows + PowerShell 会话、且显式打开开关时启用。
  if (process.platform === "win32" && shell === "powershell" && process.env[IT2_BASH_HOOK_ENV_FLAG] === "1") {
    const hookPath = await ensureIt2ProbeBashEnvHook(defaultStateDir());
    exports[IT2_BASH_HOOK_ENV_FLAG] = "1";
    exports.AGENT_BRIDGE_IT2_CMD_PATH = path.join(shims, "it2.cmd");
    // 保存调用方原来的 BASH_ENV（可能本来就没设），供 hook 脚本链入、
    // 也供 powershellProviderWrapper 在 finally 里恢复。空字符串代表"原来没设置"。
    exports.AGENT_BRIDGE_ORIGINAL_BASH_ENV = process.env.BASH_ENV ?? "";
    exports.BASH_ENV = hookPath;
  }

  for (const [key, value] of Object.entries(exports)) {
    if (shell === "powershell") {
      process.stdout.write(`$env:${key} = ${powershellQuote(value)}\n`);
    } else {
      process.stdout.write(`export ${key}=${zshQuote(value)};\n`);
    }
  }
}

export function printZshInit(): void {
  const bin = commandForInit();
  process.stdout.write(`# wezterm-agent-bridge zsh 注入片段
# 放在用户 zshrc 加载完成之后执行，才能包住已有的 claude shell function。
if [[ -n "\${WEZTERM_PANE:-}" && -z "\${WEZTERM_AGENT_BRIDGE_ZSH_LOADED:-}" ]]; then
  export WEZTERM_AGENT_BRIDGE_ZSH_LOADED=1
  export WEZTERM_AGENT_BRIDGE_BIN=${zshQuote(bin)}

  if (( $+functions[claude] )); then
    functions -c claude __wezterm_agent_bridge_original_claude
  fi

  function claude() {
    if [[ -n "\${AGENT_BRIDGE_IN_PROVIDER:-}" ]]; then
      if (( $+functions[__wezterm_agent_bridge_original_claude] )); then
        __wezterm_agent_bridge_original_claude "$@"
      else
        command claude "$@"
      fi
      return $?
    fi

    eval "$("$WEZTERM_AGENT_BRIDGE_BIN" shell-env --provider claude)"
    AGENT_BRIDGE_IN_PROVIDER=1
    if (( $+functions[__wezterm_agent_bridge_original_claude] )); then
      __wezterm_agent_bridge_original_claude "$@"
    else
      command claude "$@"
    fi
    local bridge_status=$?
    unset AGENT_BRIDGE_IN_PROVIDER
    return $bridge_status
  }
fi
`);
}

export function printPowerShellInit(): void {
  const bin = commandForInit();
  process.stdout.write(`# wezterm-agent-bridge PowerShell 注入片段
# 放在用户 PowerShell profile 靠后位置执行，才能包住已有的 claude function。
if ($env:WEZTERM_PANE -and -not $env:WEZTERM_AGENT_BRIDGE_POWERSHELL_LOADED) {
  $env:WEZTERM_AGENT_BRIDGE_POWERSHELL_LOADED = "1"
  $env:WEZTERM_AGENT_BRIDGE_BIN = ${powershellQuote(bin)}
${powershellProviderWrapper("claude")}
}
`);
}

export interface ShimFile {
  /** 文件名（不含目录），相对 shim 目录。 */
  name: string;
  content: string;
  /** POSIX 文件权限 mode；未指定时用 writeFile 默认（cmd/ps1 不需要执行位）。 */
  mode?: number;
}

/**
 * 纯函数：给定平台 + node 可执行文件路径 + shim 要转发到的入口命令，算出应该
 * 写哪些 shim 文件、内容是什么——不做任何 I/O，方便单测直接断言内容/文件集合，
 * 不需要真实 Windows/Git Bash 环境，也不需要碰真实用户 state 目录。
 *
 * - win32：三件套 `it2`（Git Bash 用，`command -v it2` 探测的正是这个无扩展名文件——
 *   2026-09 之前这里漏了这一个，只生成了 cmd/ps1，是 Git Bash 下 `command -v it2`
 *   必然 NOT_FOUND 的根因）、`it2.cmd`（cmd.exe）、`it2.ps1`（PowerShell）。
 * - 非 win32：只有 `it2` 一个（POSIX shell 用），跟历史行为一致。
 */
export function buildIt2ShimFiles(platform: NodeJS.Platform, nodeExecPath: string, shimCommand: string): ShimFile[] {
  const posixShim: ShimFile = {
    name: "it2",
    content: `#!/bin/sh
exec ${shellQuote(nodeExecPath)} ${shellQuote(shimCommand)} it2 "$@"
`,
    mode: 0o755
  };
  if (platform !== "win32") {
    return [posixShim];
  }
  return [
    posixShim,
    {
      name: "it2.cmd",
      content: `@echo off\r\n"${nodeExecPath}" "${shimCommand}" it2 %*\r\n`
    },
    {
      name: "it2.ps1",
      content: `& ${powershellQuote(nodeExecPath)} ${powershellQuote(shimCommand)} it2 @args\r\nexit $LASTEXITCODE\r\n`
    }
  ];
}

/**
 * 生成 it2 shim（Windows 上是 it2/it2.cmd/it2.ps1 三件套，其它平台只有 it2 一个）
 * 到 shim 目录，返回该目录路径。
 *
 * Windows 上 it2 探测走的是 Git Bash 的 `command -v` + BASH_ENV 探测钩子（见本文件
 * `printShellEnv`/`buildIt2ProbeBashEnvHookScript`），不依赖这里生成的 it2 本身是
 * 什么格式；it2/it2.cmd/it2.ps1 三件套仍然保留，供 Git Bash 直接执行（it2）、
 * cmd.exe（it2.cmd）、PowerShell（it2.ps1）各自使用。
 */
export async function ensureIt2Shim(): Promise<string> {
  const dir = shimDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const files = buildIt2ShimFiles(process.platform, process.execPath, commandForShim());
  for (const file of files) {
    const target = path.join(dir, file.name);
    await fs.promises.writeFile(target, file.content, { encoding: "utf8", ...(file.mode !== undefined ? { mode: file.mode } : {}) });
    if (file.mode !== undefined) {
      // POSIX 上真正生效（0755，Git Bash/shell 直接执行需要）；Windows 上 mode 位
      // 基本不影响实际可执行性（NTFS 没有对等概念，it2 在 Windows 上的可执行性
      // 由 command.cmd/ps1 或 BASH_ENV 探测钩子处理，不依赖这个 chmod）。
      await fs.promises.chmod(target, file.mode);
    }
  }
  return dir;
}

function entrypointPath(): string {
  return process.argv[1];
}

function commandForInit(): string {
  return process.env.WEZTERM_AGENT_BRIDGE_BIN_FOR_INIT ?? "wezterm-agent-bridge";
}

function commandForShim(): string {
  return process.env.WEZTERM_AGENT_BRIDGE_BIN_FOR_SHIM ?? entrypointPath();
}

function zshQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function powershellProviderWrapper(provider: string): string {
  const externalVariable = `__wezterm_agent_bridge_external_${provider}`;
  const originalFunction = `__wezterm_agent_bridge_original_${provider}`;
  return `
  $script:${externalVariable} = (Get-Command ${provider} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source

  if (Test-Path Function:\\${provider}) {
    Copy-Item Function:\\${provider} Function:\\${originalFunction}
  }

  function global:${provider} {
    if ($env:AGENT_BRIDGE_IN_PROVIDER) {
      if (Test-Path Function:\\${originalFunction}) {
        ${originalFunction} @args
      } elseif ($script:${externalVariable}) {
        & $script:${externalVariable} @args
      } else {
        throw "找不到原始 ${provider} 命令"
      }
      return
    }

    # 调用前先用本地变量（不是环境变量）快照这几个会被注入的 env，
    # 保证 finally 里能精确恢复到调用前的原值，不受本次是否异常、是否启用
    # 实验性 BASH_ENV 钩子影响；shell-env 的注入和实际调用都纳入 try，
    # 任何一步失败都会走到 finally 做恢复。
    $__wzab_snapshot_bash_env = $env:BASH_ENV
    $__wzab_snapshot_hook_flag = $env:${IT2_BASH_HOOK_ENV_FLAG}
    $__wzab_snapshot_it2_cmd_path = $env:AGENT_BRIDGE_IT2_CMD_PATH
    $__wzab_snapshot_original_bash_env = $env:AGENT_BRIDGE_ORIGINAL_BASH_ENV
    try {
      $__wzab_env = (& $env:WEZTERM_AGENT_BRIDGE_BIN shell-env --provider ${provider} --shell powershell | Out-String)
      if ($LASTEXITCODE -ne 0) {
        throw "wezterm-agent-bridge shell-env 失败（退出码 $LASTEXITCODE），未注入环境，不继续调用 ${provider}"
      }
      Invoke-Expression $__wzab_env
      $env:AGENT_BRIDGE_IN_PROVIDER = "1"
      if (Test-Path Function:\\${originalFunction}) {
        ${originalFunction} @args
      } elseif ($script:${externalVariable}) {
        & $script:${externalVariable} @args
      } else {
        throw "找不到原始 ${provider} 命令"
      }
    } finally {
      Remove-Item Env:\\AGENT_BRIDGE_IN_PROVIDER -ErrorAction SilentlyContinue
      if ($null -ne $__wzab_snapshot_bash_env) { $env:BASH_ENV = $__wzab_snapshot_bash_env } else { Remove-Item Env:\\BASH_ENV -ErrorAction SilentlyContinue }
      if ($null -ne $__wzab_snapshot_hook_flag) { $env:${IT2_BASH_HOOK_ENV_FLAG} = $__wzab_snapshot_hook_flag } else { Remove-Item Env:\\${IT2_BASH_HOOK_ENV_FLAG} -ErrorAction SilentlyContinue }
      if ($null -ne $__wzab_snapshot_it2_cmd_path) { $env:AGENT_BRIDGE_IT2_CMD_PATH = $__wzab_snapshot_it2_cmd_path } else { Remove-Item Env:\\AGENT_BRIDGE_IT2_CMD_PATH -ErrorAction SilentlyContinue }
      if ($null -ne $__wzab_snapshot_original_bash_env) { $env:AGENT_BRIDGE_ORIGINAL_BASH_ENV = $__wzab_snapshot_original_bash_env } else { Remove-Item Env:\\AGENT_BRIDGE_ORIGINAL_BASH_ENV -ErrorAction SilentlyContinue }
    }
  }`;
}
