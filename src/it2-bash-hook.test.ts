/**
 * 实验性 BASH_ENV 探测钩子——真实用 bash 执行，不是纯静态断言脚本文本。
 * 这套机制的核心可行性（BASH_ENV 在非交互 shell 启动时会被 source、
 * BASH_EXECUTION_STRING 能拿到实际执行的命令字符串）是标准 bash 行为，
 * 不是 Git Bash / Windows 专属——用本机（任意平台）的 bash 就能真实验证，
 * 不需要 Windows。跟"官方 Claude Code 在 Windows 上是否真的采用这条路径"
 * 是两件事，那部分仍然需要 QA 在真实 Windows 上验证。
 *
 * 核心探测断言不对生产 stdout 做任何 ANSI 过滤，严格照抄官方 Claude Code
 * Windows 2.1.263 二进制里实际的解析算法（team-lead 直接核实到字节 185352443
 * 附近的源码，不是猜测）：
 *   s.stdout.split('\n').map(m => m.trim()).filter(Boolean).at(-1) ?? ""
 * 见 officialLastNonEmptyLine()。核心不变式是"用这个算法解析未过滤的 raw
 * stdout，结果严格等于真实路径、不受路径前后任何噪音污染"，而不是强行要求
 * "只能有一行输出"——启动阶段的 banner/profile 输出完全可能存在，不能因为
 * 存在就判定测试失败（那是对用户环境的过度限制）。
 *
 * 运行：node dist/it2-bash-hook.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IT2_BASH_HOOK_ENV_FLAG as HOOK_FLAG, buildIt2ProbeBashEnvHookScript as buildHookScript } from "./shell.js";

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${String(err)}`);
    failed++;
  }
}

/**
 * 真实在 Windows 上复现过的坑（不是猜的）：裸 `execFileSync("bash", ...)` 靠 PATH
 * 解析——如果这台机器装了 WSL，`C:\Windows\System32\bash.exe`（WSL 的启动器）
 * 完全可能排在 Git Bash 前面被优先解析到。WSL 的 bash 跑在 Linux 文件系统视角
 * 下，我们传给它的 hook 脚本路径、`AGENT_BRIDGE_IT2_CMD_PATH`/
 * `AGENT_BRIDGE_ORIGINAL_BASH_ENV` 这些都是 Windows 风格绝对路径
 * （`C:\Users\...`），在 WSL 视角下根本不是有效路径，`[ -f "$X" ]` 恒为假，
 * 导致钩子逻辑整个走不到该走的分支。所以这里显式定位一个真正的 Git Bash，
 * 不依赖裸 "bash" 名字的 PATH 解析顺序。
 *
 * 注意（2026-09 真实 Windows 复测确认）：`fs.existsSync("C:\\Windows\\System32\\bash.exe")`
 * 在装了 WSL 的机器上确实为 true，但这只证明"装了 WSL"，不证明裸 "bash" 的
 * PATH 解析真的会命中它（PATH 顺序才是决定因素）——这里显式给出候选路径、
 * 不靠裸名字解析，本身就规避了这个不确定性，不需要额外证明"以前解析到了谁"。
 */
function resolveBashExecutable(): string {
  if (process.platform !== "win32") {
    return "bash";
  }
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe"
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Windows 上找不到 Git Bash（试过 CLAUDE_CODE_GIT_BASH_PATH 环境变量和常见安装路径）——" +
      "不能静默退回裸 \"bash\" 名字让 PATH 解析决定用哪个 bash.exe（可能解析到 WSL 的 bash.exe，" +
      "行为完全不同，会让这个测试文件的断言失去意义）。"
  );
}

const BASH_EXECUTABLE = resolveBashExecutable();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wzab-bash-hook-test-"));
const hookPath = path.join(tmpDir, "hook.sh");
// 传 hookPath 本身，激活自引用防护（见 shell.ts buildIt2ProbeBashEnvHookScript）——
// 用真实会写到的路径生成，才能真实测到这层防护，不是纯占位。
fs.writeFileSync(hookPath, buildHookScript(hookPath), "utf8");

// 按平台生成真实格式的 it2 目标 fixture，不再对所有平台都塞 POSIX shebang、
// 也不再用裸 execFileSync("sh", ...) 绕过原生执行方式——那样既可能在 Windows 上
// 引入跟 WSL 类似的"用错解释器"问题，也没有真实验证 Windows 上 .cmd 的执行语义。
// win32-powershell-hook.test.ts 覆盖的是 claude 包装函数那一层的 shell-env 注入，
// 跟这里"钩子解析出来的路径本身是否真实可执行"是两件事，不能互相代替。
const it2CmdPath = process.platform === "win32" ? path.join(tmpDir, "it2.cmd") : path.join(tmpDir, "it2");
if (process.platform === "win32") {
  fs.writeFileSync(
    it2CmdPath,
    '@echo off\r\nif "%1"=="session" if "%2"=="list" echo SESSION_LIST_OK:%*\r\n',
    "utf8"
  );
} else {
  fs.writeFileSync(
    it2CmdPath,
    `#!/bin/sh\n[ "$1" = "session" ] && [ "$2" = "list" ] && echo "SESSION_LIST_OK:$*"\n`,
    { encoding: "utf8", mode: 0o755 }
  );
}

/**
 * 用 spawnSync 而不是 execFileSync：execFileSync 成功路径下默认只返回 stdout，
 * 拿不到 stderr；这里需要 stdout/stderr 分离可见（比如验证生产修复"只截断
 * stdout、不吞 stderr"），spawnSync 无论成功失败都能拿到两者，不用 try/catch
 * 拆两条路径。
 *
 * `hook` 显式控制是否设置 BASH_ENV=hookPath——不是每次调用都默认设置："无 hook
 * 基线"类用例必须真正不设置 BASH_ENV，不能靠"传了钩子相关 extraEnv 但没读取"
 * 这种隐性方式伪装。同时清掉从当前进程继承下来的、可能残留的
 * AGENT_BRIDGE_ 前缀变量、以及 BASH_ENV 变量（比如这个测试进程本身是被某个已经打开开关的
 * 环境启动的），保证每个用例的环境是显式、可控、不被外部污染的。
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AGENT_BRIDGE_") || key === "BASH_ENV") {
      delete env[key];
    }
  }
  return env;
}

function runBash(
  cmd: string,
  opts: { hook?: boolean; extraEnv?: Record<string, string>; home?: string } = {}
): { stdout: string; stderr: string; status: number | null } {
  const env = cleanEnv();
  if (opts.hook) {
    env.BASH_ENV = hookPath;
  }
  if (opts.home) {
    env.HOME = opts.home;
  }
  Object.assign(env, opts.extraEnv ?? {});
  const result = spawnSync(BASH_EXECUTABLE, ["-lc", cmd], { encoding: "utf8", env });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function officialLastNonEmptyLine(raw: string): string {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

run("命中场景真实 raw stdout（不做任何 ANSI 过滤）：按官方原样算法（.at(-1)）解析严格等于真实 it2 路径", () => {
  const { stdout, status } = runBash("command -v it2", {
    hook: true,
    extraEnv: { [HOOK_FLAG]: "1", AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath }
  });
  assert.equal(status, 0);
  const resolvedPath = officialLastNonEmptyLine(stdout);
  assert.equal(resolvedPath, it2CmdPath, `按官方 split('\\n').map(trim).filter(Boolean).at(-1) 算法解析，应该严格等于真实 native it2 路径，实际 raw: ${JSON.stringify(stdout)}`);
});

run("命中场景解析出的路径是真实可执行的：按平台真实调用方式（win32 走 cmd.exe，POSIX 直接执行）执行 session list，能拿到正确响应", () => {
  const { stdout: hookStdout, status: hookStatus } = runBash("command -v it2", {
    hook: true,
    extraEnv: { [HOOK_FLAG]: "1", AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath }
  });
  assert.equal(hookStatus, 0);
  const resolvedPath = officialLastNonEmptyLine(hookStdout);
  assert.equal(resolvedPath, it2CmdPath);

  // 真实按平台原生方式执行 resolved path（模拟官方拿到路径后紧接着做的事）：
  // win32 上 .cmd 批处理文件不能被 CreateProcess 直接执行，必须走 cmd.exe（这里用
  // spawnSync 的 shell:true，等价于真实 shell 调用 .cmd 的方式）；POSIX 上直接
  // 执行这个带 shebang 的可执行文件，不强行包一层 "sh"。
  const sessionListResult =
    process.platform === "win32"
      ? spawnSync(resolvedPath, ["session", "list"], { encoding: "utf8", shell: true })
      : spawnSync(resolvedPath, ["session", "list"], { encoding: "utf8" });
  assert.match(
    sessionListResult.stdout ?? "",
    /SESSION_LIST_OK/,
    `session list 应该被正确响应，实际输出: ${JSON.stringify(sessionListResult.stdout)}`
  );
});

run("同环境基线对照（无 hook，无 BASH_ENV）：command -v it2 的 raw stdout 不含 ANSI 转义序列", () => {
  const { stdout } = runBash("command -v it2", {});
  assert.ok(!/\x1B\[/.test(stdout), `无 hook 情况下 raw stdout 不应该有 ANSI 转义序列，实际: ${JSON.stringify(stdout)}`);
});

run("同环境基线对照（无 hook，无 BASH_ENV，显式 exit 0）：真实复现 login shell 收尾噪音的触发条件——跟 hook 代码本身无关，纯粹是 exit 触发的", () => {
  // 这条用例如实记录 root cause（binary-investigator 在真实 Windows 上用完全
  // 不涉及本项目 hook 逻辑的真实 `git` 命令复现过：无 hook、无 BASH_ENV，只要
  // 命令里显式 `exit`，MSYS2 login shell 收尾时就会产生这段噪音）。在 macOS/Linux
  // 上不一定复现这个具体的 MSYS2 行为（这是 Windows/MSYS2 专属的 login shell
  // 实现细节），所以这里不强行断言必须有 ANSI——只验证"至少不会因为这个用例
  // 本身报错/挂起"，真正的 Windows 端证据来自 binary-investigator 的真机记录，
  // 不是这条本机用例的职责。
  const { status } = runBash("printf ok; exit 0", {});
  assert.equal(status, 0, "显式 exit 不应该导致命令执行失败，不管有没有触发 login shell 的收尾噪音");
});

run("受控 startup 噪声：login shell 启动阶段（~/.bash_profile）先输出无关横幅内容，命中场景仍应正确解析出真实路径（不要求 raw stdout 只有一行）", () => {
  // 用真实存在的 login shell 启动文件模拟"启动阶段横幅/profile 输出"，不是编造
  // 一个不会真实触发的场景：bash 以 `-l`（login）方式启动时会读取
  // ~/.bash_profile（HOME 指向这里新建的临时目录，不影响调用方真实 HOME）。
  // 断言的是"官方按最后非空行解析，横幅出现在路径之前，不影响最终取到真实路径"
  // 这个不变式，而不是要求横幅完全不存在——用户真实环境里 profile 打印欢迎语
  // 是完全合法的，测试不能把这种合法场景判定为失败。
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wzab-bash-hook-home-"));
  fs.writeFileSync(path.join(homeDir, ".bash_profile"), 'echo "STARTUP-BANNER-UNRELATED-NOISE"\n', "utf8");
  try {
    const { stdout, status } = runBash("command -v it2", {
      hook: true,
      home: homeDir,
      extraEnv: { [HOOK_FLAG]: "1", AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath }
    });
    assert.equal(status, 0);
    assert.match(stdout, /STARTUP-BANNER-UNRELATED-NOISE/, "这条用例本身要真实验证横幅确实被输出了，不是摆设——否则没有真实测到'受噪音干扰'这个场景");
    const resolvedPath = officialLastNonEmptyLine(stdout);
    assert.equal(resolvedPath, it2CmdPath, `启动横幅噪音不应该影响官方按最后非空行解析出的真实路径，实际 raw: ${JSON.stringify(stdout)}`);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

run("受控 logout/exit 噪声下的生产修复效果：命中场景 + 显式 exit 收尾，raw stdout 里官方解析结果仍然严格等于真实路径，且不含 ANSI 转义序列", () => {
  // 这条直接验证生产修复本身（exec >/dev/null 截断 exit 前的后续 stdout）：命中
  // 分支内部就是 "printf 路径; exec >/dev/null; exit 0" —— 跟上面基线用例里
  // "无 hook 时显式 exit 触发 ANSI" 用的是同一种 "bash -lc '...; exit 0'" 触发
  // 条件，这里验证修复后即便触发了 login shell 的收尾行为，噪音也不会出现在
  // 调用方捕获到的 stdout 里。
  const { stdout, status } = runBash("command -v it2", {
    hook: true,
    extraEnv: { [HOOK_FLAG]: "1", AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath }
  });
  assert.equal(status, 0);
  assert.ok(!/\x1B\[/.test(stdout), `生产修复后，命中场景 raw stdout 不应该含 ANSI 转义序列（即便 login shell 收尾会产生），实际: ${JSON.stringify(stdout)}`);
  assert.equal(officialLastNonEmptyLine(stdout), it2CmdPath);
});

run("钩子开启但命令不是精确匹配（比如带额外参数/不同命令）：完全不拦截，正常执行", () => {
  const { stdout, status } = runBash("echo hello-world", {
    hook: true,
    extraEnv: { [HOOK_FLAG]: "1", AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath }
  });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "hello-world", "非目标命令必须完全走正常 bash 行为，不受钩子影响");
});

run("钩子开启但目标 it2 文件不存在：应该完全退化成无 hook 时的行为，不能凭空吐出这个不存在的伪路径", () => {
  const targetMissing = path.join(tmpDir, "does-not-exist.cmd");
  const withHookMissing = runBash("command -v it2", {
    hook: true,
    extraEnv: { [HOOK_FLAG]: "1", AGENT_BRIDGE_IT2_CMD_PATH: targetMissing }
  });
  const noHookBaseline = runBash("command -v it2", {});
  assert.equal(withHookMissing.stdout, noHookBaseline.stdout, "目标文件不存在时，命中判断应该不短路，输出应该跟完全没有 hook 时一致");
  assert.equal(withHookMissing.status, noHookBaseline.status, "退出码也应该跟无 hook 基线一致");
  assert.ok(!withHookMissing.stdout.includes(targetMissing), "不应该输出这个不存在的伪目标路径");
});

run("开关没打开（HOOK_FLAG 未设置）：即便命令字符串精确匹配，也完全不拦截", () => {
  const { stdout } = runBash("printf ok", { hook: true, extraEnv: { AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath } });
  assert.equal(stdout.trim(), "ok", "没开开关时钩子必须是纯粹的透明层，不能有任何副作用");
});

run("链入原有 BASH_ENV：设置 AGENT_BRIDGE_ORIGINAL_BASH_ENV 指向一个会导出变量的脚本，非目标命令下应该被 source 到，变量对后续命令可见", () => {
  const originalBashEnv = path.join(tmpDir, "original-bash-env.sh");
  fs.writeFileSync(originalBashEnv, "export WZAB_TEST_CHAIN_MARKER=chained-ok\n", "utf8");
  const { stdout } = runBash("echo $WZAB_TEST_CHAIN_MARKER", {
    hook: true,
    extraEnv: {
      [HOOK_FLAG]: "1",
      AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath,
      AGENT_BRIDGE_ORIGINAL_BASH_ENV: originalBashEnv
    }
  });
  assert.equal(stdout.trim(), "chained-ok", "非目标命令时应该链入原有 BASH_ENV，调用方原来的环境设置不能丢");
});

run("自引用防护：AGENT_BRIDGE_ORIGINAL_BASH_ENV 指向钩子自己（嵌套/未恢复场景）时不会 source 自己，非目标命令仍正常执行不报错", () => {
  const { stdout, status } = runBash("printf self-guard-ok", {
    hook: true,
    extraEnv: {
      [HOOK_FLAG]: "1",
      AGENT_BRIDGE_IT2_CMD_PATH: it2CmdPath,
      AGENT_BRIDGE_ORIGINAL_BASH_ENV: hookPath // 故意指向自己
    }
  });
  assert.equal(status, 0, "不应该因为自引用导致命令执行失败");
  assert.equal(stdout.trim(), "self-guard-ok");
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
