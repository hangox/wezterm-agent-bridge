# wezterm-agent-bridge

把 Claude Code 内置的 it2（iTerm2 兼容）pane 控制接口，桥接到 **原生 WezTerm pane** 上，让 Claude Code 的 Agent Team / `it2 session` 系列能力（拆分 pane、在 pane 里跑命令、关闭 pane、把光标切过去）在 WezTerm 里也能用。

## 这个项目不是什么

- **不是 LLM 代理/网关**，不转发、不代理任何模型请求。
- **不提供任何模型账号或 API Key**——认证信息（`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` 等）完全来自你自己的环境，本项目不生成、不上传这些值到任何远程服务。但要说清楚：本项目**会在本机临时处理**你启动 teammate 时用到的环境变量，才能把它们正确设置进新开的 pane（Windows 上具体是短暂写入一个本机临时文件、读完即删，见下文"敏感环境变量的处理"一节的完整细节和已知限制）——不是"完全不碰这些值"，是"只在本机处理、不上传、尽量不让它们出现在可见文本里"。
- **不替代、也不是 Claude Code 自身的多 agent 团队能力**：多 agent 团队协作（Team/Task/mailbox 这些协作语义）是 **Claude Code 自身**提供的能力；"agent-team" 是一个**第三方/社区维护**的 skill，在这之上提供 profile 切换、流程增强，不是 Claude Code 官方组件。本项目桥接的是 Claude Code 内置的 it2（iTerm2 兼容）pane 控制协议——`wezterm-agent-bridge` 只负责"这个 pane 在 WezTerm 里能不能被正常创建/控制"这一层终端适配，不依赖 agent-team、不要求你安装它，只是恰好也能配合它使用。
- **不依赖任何内部私有服务**：daemon 只监听 `127.0.0.1`，鉴权用本地随机生成的 token（`crypto.randomBytes`），状态文件写在本机的 state 目录（macOS/Linux: `~/.local/state/wezterm-agent-bridge/`；Windows: `%LOCALAPPDATA%\wezterm-agent-bridge\`）。

## 原理

Claude Code 判断"是否可以做 pane 拆分/读写"的依据是 `it2` 命令是否存在、以及 `ITERM_SESSION_ID`/`WEZTERM_UNIX_SOCKET` 等环境变量。本项目：

1. 在 `PATH` 里放一个 `it2` shim，把 Claude Code 发出的 it2 请求转发给本机一个小 daemon；
2. daemon 把这些请求翻译成对 WezTerm 自身 CLI/Unix socket 的调用（拆分 pane、发命令、关闭 pane、切焦点）；
3. 通过 shell 函数包装（zsh `claude` 函数 / PowerShell `claude` 函数），在你敲 `claude` 时临时注入 `ITERM_SESSION_ID`/`TERM_PROGRAM=iTerm.app` 等环境变量，让 Claude Code 误以为自己在 iTerm2 里。

## 依赖

| 依赖 | macOS/Linux | Windows |
|---|---|---|
| Node.js | 需要（用于运行本 CLI）；本轮实测版本 24 | 需要；本轮实测版本 24 |
| [WezTerm](https://wezterm.org/) | 需要，且要在 WezTerm pane 内使用 | 需要，且要在 WezTerm pane 内使用 |
| Shell | zsh（`init zsh` 注入） | **PowerShell 7**（`pwsh`，`init powershell` 注入；不是 Windows 自带的 PowerShell 5.1） |

## 安装

本项目**目前不发布到 npm 公共仓库**。从源码构建，或从 [GitHub Release](https://github.com/hangox/wezterm-agent-bridge/releases) 下载对应版本的打包 tgz 安装：

从源码构建：
```bash
git clone https://github.com/hangox/wezterm-agent-bridge.git
cd wezterm-agent-bridge
npm install
npm run build
npm install -g .
```

从 Release tgz 安装（下载后本地路径替换成实际文件名）：
```bash
npm install -g ./wezterm-agent-bridge-0.3.0.tgz
```

## 初始化（写入 shell 配置）

zsh（macOS/Linux）：
```bash
wezterm-agent-bridge init zsh >> ~/.zshrc
```

PowerShell 7（Windows）：
```powershell
wezterm-agent-bridge init powershell >> $PROFILE
```

两条命令都只是打印一段"如果在 WezTerm pane 内、且这个包装函数还没加载过，就注入环境变量并包一层 `claude` 函数"的片段，追加到你自己的 shell 配置**靠后**的位置（确保已有的 `claude` 函数/别名先加载完成，本项目才能包住它）。重启一个新的 WezTerm pane 生效。

## 体检 / doctor

```bash
wezterm-agent-bridge doctor
```

依次检查：`node` 版本、`wezterm --version`、本地 daemon 是否能启动（打印 `127.0.0.1:<port> pid=<pid>`）、it2 shim 是否已写入、当前是否在 `WEZTERM_PANE` 内、`WEZTERM_UNIX_SOCKET` 能否发现。每一项单独 `try/catch`，某一项失败只打印"失败 - 原因"，不影响后面几项继续跑（代码见 `src/doctor.ts`）。

> **doctor 全部通过 ≠ GUI/pane 已经验证过。** doctor 只检查这些底层依赖和 daemon 能否起来，不实际创建/操作任何 WezTerm 窗口或 pane。真正要确认"拆分 pane、发命令、关闭 pane"这些能力可用，需要在真实 WezTerm pane 里跑 `it2 session split`/`run`/`close` 并肉眼确认，doctor 通过只是"前置条件具备"，不是"功能已验收"。

## 创建 / 关闭 pane（底层命令，通常由 Claude Code 自动调用，不需要手动敲）

```bash
wezterm-agent-bridge it2 session list
wezterm-agent-bridge it2 session split -v [--cwd <dir>]
wezterm-agent-bridge it2 session run -s <id> <command...>
wezterm-agent-bridge it2 session close -s <id>
wezterm-agent-bridge it2 session focus -s <id>
wezterm-agent-bridge it2 session read -s <id> [-n <lines>]
```

`-s <id>` 指定目标 session（省略时用第一个 READY 状态的 session）；`run` 不需要 `--` 分隔符，`-s`/`-v`/`--cwd`/`-n` 之后的内容都会被当成要执行的命令。

## 手动启动 daemon（一般不需要，`doctor`/`shell-env` 会自动拉起）

```bash
AGENT_BRIDGE_TOKEN=<token> wezterm-agent-bridge daemon --port <port> [--state-dir <dir>]
```

token **只能**通过 `AGENT_BRIDGE_TOKEN` 环境变量传入；不支持 `--token` 命令行参数（曾经支持过，已移除）——命令行参数会原样出现在本进程的进程列表里，本机其它用户可以从 `ps`/任务管理器/Process Explorer 直接看到明文，所以这条路直接关掉了，不留"手动调试可以绕过"的口子。正常情况下这条命令由 `ensureDaemon` 自动拉起，你不需要手动跑它。

## 敏感环境变量的处理

Claude Code 派发 teammate 时会把一批环境变量（可能含 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`AWS_SECRET_ACCESS_KEY` 等真实凭据）放进启动命令。这批变量最终要发送到 WezTerm pane 才能生效，而 `wezterm cli send-text` 本质是把文本"打进"终端——出现在 scrollback、录屏、截图里都算暴露。两个平台的处理方式不同：

- **Windows（PowerShell 翻译路径）**：**不区分"敏感/非敏感"，只要这条命令带 env 赋值，全部 KEY=VALUE 都不会内联到发送给 pane 的可见命令文本里**——只有 `binary` 和它的 args 部分是可见的。所有变量统一写入一个当前用户目录下（`%LOCALAPPDATA%`/`%TEMP%`）的临时 JSON 文件，PowerShell 静默读取、逐项 `Set-Item` 设进 `$env:`、读完立即尝试 `Remove-Item` 删除该文件。这是尽力而为，不是加密存储：临时文件短暂存在于磁盘，进程内 mode 位在 Windows 上不生效，实际隔离依赖"这个目录本来就是当前系统账户私有的"；若 PowerShell 侧异常退出未删成，文件可能残留。
  - 识别到命令里"像是带 env 赋值"（含固定的 `cd X && env K=V ... binary` 形态、没有 `cd` 前缀的裸 `env K=V binary`、空白不标准的变体、开头直接 `KEY=VALUE` 的写法）但不满足受支持的固定转译语法时，**直接拒绝这次 `it2 session run` 请求**（daemon 返回 HTTP 错误），不会猜一个结果凑合发出去，也不会退回原始命令明文执行。完全没有识别出 env 赋值迹象的命令才会原样转发。
  - **边界说明（重要，不要读成更强的保证）**：这套保护只覆盖"能被启发式识别出来的 env 赋值形状"——固定的 `cd X && env K=V ... binary` 格式会被安全转译；"像是带 env 赋值但格式不对"的变体会被拒绝而不是放行。**这不是通用的命令脱敏器/秘密扫描器**：如果密钥以其它形式混进命令（比如直接写进某个 `--flag=xxx` 参数值里），这里识别不出来，不在保护范围内，会原样透传。
- **macOS/Linux**：当前实现按原样把命令发送给 WezTerm pane，**没有**额外的变量隐藏——启动命令里的所有 `KEY=VALUE`（含真实凭据）都会和其它命令文本一样出现在 pane 的 scrollback 里。如果你在意这点，建议让上游启动脚本通过 profile 文件里 `export`、而不是拼进一次性 spawn 命令的方式设置密钥。

## 给 Agent Team 外部 teammate 配置不同 model / provider

`wezterm-agent-bridge` 本身**不做任何 model 路由，不代理任何模型请求，也不提供/管理任何账号认证**——认证信息完全来自你自己的环境变量，本项目只负责把这些变量原样透传到新开的 pane（见上面"敏感环境变量的处理"一节的完整细节和边界）。

如果你在用 agent-team skill（**第三方/社区维护的多 agent 团队协作 skill，不是 Claude Code 官方组件**）的"外部进程"队友（真正独立的 `claude` 子进程/pane，而不是同进程内的 in-process Agent），实际拉起新 pane 时用的命令行由 **Claude Code CLI 自身**读取 `CLAUDE_CODE_TEAMMATE_COMMAND` 这个环境变量决定（这是当前构建里 CLI 自己的启动器机制，不是 agent-team skill 自己定义的约定；agent-team 作为第三方 skill 只是利用这个 CLI 已有的机制去支持"外部队友切换 profile"这个能力）——你可以把它指向你自己写的一个包装脚本（在里面先 `export ANTHROPIC_BASE_URL=...`/`ANTHROPIC_API_KEY=...` 再拉起 `claude`），从而让某些外部 teammate 走不同的 provider。这**不是**一份公开承诺跨版本稳定的 API——它是当前 CLI 构建里的实际行为，未来版本可能调整。`wezterm-agent-bridge` 只是保证"这个新 pane 在 WezTerm 里也能被正常创建/控制"，不参与、也不知道你具体配了什么 model 或 endpoint，**本项目自己没有自动识别/切换 provider 的能力**——所有 provider 切换逻辑都在你自己写的包装脚本里，本项目不内置这层。

## Windows：it2 探测的实验性修复（BASH_ENV 钩子）

Claude Code 在 Windows 上判断"能不能做 pane 拆分/读写"，走的是 `bash -lc 'command -v it2'`（Git Bash login shell）去解析 `it2` 命令的路径。Git Bash 报告出来的天然是 MSYS 风格 POSIX 路径（如 `/c/Users/.../it2`），官方代码原样拿这个字符串去做 Windows 原生进程调用会失败——这个字符串本身在 Windows 上就不是有效路径，跟 `it2` 文件是什么格式无关。

本项目提供一个**实验性、默认关闭**的绕过方案：利用 Git Bash 自身支持的 `BASH_ENV` 机制（bash 以非交互模式启动时会 source `$BASH_ENV` 指向的文件），在这个探测场景精确匹配时直接打印 it2 shim 的 Windows 原生绝对路径，短路掉真实的 `command -v` 解析。

**如何启用**（Windows + PowerShell 7 环境）：

1. 确认依赖已就绪：本机装了 Git Bash（`bash.exe`，路径可通过 `CLAUDE_CODE_GIT_BASH_PATH` 环境变量指定，未指定时会在常见安装路径查找），PowerShell 7（`pwsh`，不是系统自带的 5.1），且已经按上面"初始化"一节执行过 `wezterm-agent-bridge init powershell`。
2. 在 PowerShell profile 里、`init powershell` 注入的片段**之前**，设置环境变量打开这个实验开关：
   ```powershell
   $env:AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK = "1"
   ```
3. 重启一个新的 WezTerm pane，直接跑 `claude --teammate-mode iterm2`——包装函数（`printPowerShellInit` 生成的 `claude` 函数，见 `src/shell.ts`）检测到这个开关和 `--shell powershell` 组合时，会额外注入 `BASH_ENV` 指向探测钩子脚本，调用结束后在同一个包装函数的 `finally` 里精确恢复到调用前的值（不会污染你 shell 会话原来的 `BASH_ENV`/相关变量）。

> `--teammate-mode iterm2` 是 Claude Code CLI 自己的**隐藏参数**（`--help` 不列出，取值包括 `auto`/`tmux`/`iterm2`/`in-process`），不是本项目提供的功能，本项目不实现、也不解析它——要让 CLI 真正走 it2 探测路径需要你自己带上这个参数。这个参数名/取值是针对已验证的 Claude Code 2.1.263 构建确认的，隐藏参数**不保证未来版本延续同样的名字或行为**。

**当前验证状态（如实说明，不夸大）**：这个机制的核心可行性（`BASH_ENV` 会被 source、精确匹配探测场景后正确短路）已经过真实 bash 执行的自动化测试验证，也在真实 Windows 环境下用真实 Git Bash + 真实 `.cmd` 文件跑通过完整链路（钩子命中 → 官方解析算法拿到正确路径 → 真实执行 `session list` 成功）。**这仍然是一个实验性方案**：不代表已经等价于 Claude Code 官方对 Windows/iTerm2 兼容层的正式支持，也不保证覆盖所有 Git Bash/MSYS2 版本、所有 login shell 启动噪音场景；不用这个开关（默认状态）时，行为跟这套机制完全无关，不受任何影响。

## 测试状态

| 平台 | 实跑范围 | 结果 |
|---|---|---|
| macOS | 本机 `npm test`：shim 生成、敏感变量保护、daemon 安全（鉴权/超时/身份校验）、PowerShell 包装函数环境注入与恢复、BASH_ENV 探测钩子命中/不命中/异常路径 | 全部通过 |
| Windows | 同一套测试 + BASH_ENV 钩子命中场景的真实 raw stdout（官方最后非空行解析拿到正确原生路径，无 ANSI 污染）+ 真实执行 `session list` + WezTerm socket 自动发现 | 全部通过（本轮验证快照：53 passed / 0 failed） |
| Linux | 由 [GitHub Actions](https://github.com/hangox/wezterm-agent-bridge/actions) 验证（`.github/workflows/ci.yml` 三平台矩阵之一） | 当前结果见 CI（本文档不预报通过） |

"只截断 stdout、保留 stderr 供诊断"（`src/shell.ts` 命中分支用 `exec >/dev/null`，不带 `2>&1`）是源码层面的设计意图，目前还没有专门验证"命中分支内部真实产生 stderr、并确认它透传到调用方"的测试用例，是已知的验证空白。

测试套件随代码持续迭代，本文档不逐版本罗列通过数字，具体验证记录见对应版本的 Release notes 或提交历史。

### 真实运行截图（Windows，有界演示）

QA 在真实 Windows 机器上跑了一次有界的 agent-team + WezTerm 双队友演示（本项目提供底层 pane 桥接，agent-team 负责队友编排），留下以下真实截图（每张都核对过 sha256，不是示意图/摆拍）。三条结论要分开看，不要互相推论：**产品自动化测试（`npm test` 53/53）**、**这次真实演示里的开发/测试子任务通过**、**演示收尾时队友关闭流程未走完**是三件独立的事。

![两个队友同时存活，backendType 均为 iterm2](./docs/images/02-both-teammates-alive.png)

*测试完成后的某一时刻，`developer`/`tester` 两个队友同时存活，`backendType` 均为 `iterm2`（这条来自同步生成的 team config 记录，不是截图文字里直接显示的内容）——说明本项目的 it2 探测桥接对两个并发 pane 都生效。截图内 teammate 自报环境为 Node v24.11.1；这次演示还有一次在演示环境之外独立重跑，用的是 Node 24.15.0——两次都是 Node 24.x，本文档"依赖"一节只标注大版本号 24，不统一成某个具体小版本。左下角出现的 `Auto-update failed` 是 Claude Code CLI 自己的更新检查提示，原样保留在截图里，跟这次演示的测试结果是两回事，本文档不对它的失败原因做推断。*

![测试通过](./docs/images/03-tests-passed.png)

*`developer` 队友这次演示里跑的子任务（一个 TypeScript 加法函数）独立重跑 `node --test`：3 passed / 0 failed，退出码 0。这是这次演示里一个具体子任务的测试结果，不是本项目 `npm test` 那 53 个用例。*

![第一次关闭尝试后，developer 仍然存活](./docs/images/04-after-shutdown-attempt.png)

*第一次 `shutdown_request` 后：`tester` 已正常退出（不在队伍列表里了），`developer` 拒绝了这次关闭请求、继续保持 idle，未被强制 kill。这是过程中的一张截图，不是收尾的最终状态。*

![经澄清后再次尝试，developer 仍然拒绝关闭](./docs/images/04b-shutdown-still-rejected.png)

*在向 `developer` 澄清任务约束后再次发起 `shutdown_request`，`developer` 仍然拒绝（理由是"原始任务明确无条件禁止任何关闭、退出或 shutdown"），继续保持 idle。**这是本轮演示实际收尾时的最终状态**：`developer` 队友最终没有被成功关闭，只是被有意保留在 idle 状态作为现场证据，不是"整队已正常关闭"。这属于这一轮协作/提示词设计导致的负例（队友严格遵守了自己收到的原始约束），**不能据此归为已确认的 bridge 缺陷**——本项目的 `it2 session close`/daemon `/session/close` 负责的是"收到关闭指令后真正把 pane 关掉"这个执行动作，不负责、也不参与"模型要不要批准某次 `shutdown_request`"这个决策；这次卡住的是决策这一层（agent-team 协议 + 队友自己的判断），不是 pane 关闭的执行链路。*

> 这组截图演示的是"WezTerm pane + agent-team 队友编排"这个更大的使用场景在真实 Windows 上跑起来的样子，用来证明本项目提供的 pane 桥接在多队友并发场景下真实可用；不代表覆盖了本项目所有功能路径。开场时 leader 就绪、无队友的第一张截图（"01"）在真实操作中错过了时间窗，如实缺失，没有补造。

## 已知限制

- 只在你实际处于一个 WezTerm pane（`$WEZTERM_PANE` 非空）时生效；不在 WezTerm 里跑（比如普通终端、tmux）不会有任何行为改变。
- 目前只包装了 `claude` 这一个命令（`shell-env --provider claude`）。
- Windows 下必须是 PowerShell 7（`pwsh`），Windows 自带的 PowerShell 5.1 未测试、不保证兼容。
- WezTerm socket 的自动发现（`discoverWeztermSocket`）在找不到 `WEZTERM_UNIX_SOCKET` 环境变量时，会去 `~/.local/share/wezterm/` 下找 `gui-sock-*` 文件——**已在 Windows 上实机验证**：只要环境里有一个真实 `wezterm-gui.exe start` 拉起的实例，这条自动发现工作正常，不需要手动设置环境变量。它**只认 `wezterm-gui.exe` 生成的 `gui-sock-<pid>` 文件**：如果环境里只有一个独立的 `wezterm-mux-server.exe`（没有任何 GUI 实例），这个后台进程不会生成 `gui-sock-*` 文件，自动发现会找不到它，需要你自己手动设置 `WEZTERM_UNIX_SOCKET`。这是已知的发现范围限制，不是 bug，也不是 Windows session 隔离问题。

## License

MIT，见 [LICENSE](./LICENSE)。
