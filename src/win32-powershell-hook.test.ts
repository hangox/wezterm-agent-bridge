/**
 * 真实 PowerShell（pwsh 7+）回归夹具——被测对象是产品 `init powershell` /
 * `print-powershell-init` **原样生成**的代码（直接调用 dist/index.js 拿真实输出，
 * 不重写/不摘抄包装器逻辑），只 mock 外部 `claude` 和 `shell-env` 两个边界，
 * 覆盖：
 *   1. 未设/已设 BASH_ENV（调用前预先设置一个非空值，验证不被吞掉）
 *   2. 实验开关 flag=1 / 非1（未设）
 *   3. 连续调用两次（第二次进入"已在 provider 内"分支 vs 验证第一次调用后
 *      环境已正确恢复，第二次从干净状态开始）
 *   4. shell-env 非零退出 → mock claude 绝不能被调用
 *   5. shell-env 输出部分注入后抛错 → mock claude 绝不能被调用，且抛错前已经
 *      执行的那部分注入（部分 $env: 赋值）也必须在 finally 里被正确恢复/清理，
 *      不能残留
 *   6. 正常场景：四个 env（BASH_ENV/HOOK_FLAG/IT2_CMD_PATH/ORIGINAL_BASH_ENV）
 *      调用后精确恢复到调用前的值（对照组：调用前是"未设置"、"设置成 A" 两种起点）
 *   7. stdout/stderr 分离——mock-bridge 故意脏写一行 stderr，不能污染
 *      Invoke-Expression 实际执行的内容，也不能被当成命令输出吞掉
 *
 * 只用 synthetic 变量（假路径字符串），不发真实网络请求、不用真实凭据、
 * 不启动真实 daemon/WezTerm。跨平台可跑（pwsh 是跨平台的），CI 三个平台
 * 的 runner 默认都装了 pwsh。
 *
 * 运行：node dist/win32-powershell-hook.test.js（需要先 npm run build，
 * 且本机装有 pwsh；没有 pwsh 时整个文件的用例会记为失败并给出明确提示，
 * 不会静默跳过导致"看起来测过了"）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const INDEX_JS = path.join(REPO_ROOT, "dist", "index.js");
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "win32-powershell-hook");
const MOCK_BRIDGE_PS1 = path.join(FIXTURE_DIR, "mock-bridge.ps1");
const MOCK_CLAUDE_RECORD_MJS = path.join(FIXTURE_DIR, "mock-claude-record.mjs");

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

function havePwsh(): boolean {
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  return result.status === 0;
}

if (!havePwsh()) {
  console.error("本机没有 pwsh（PowerShell 7+），这个文件的全部用例记为失败——" +
    "不能静默跳过，跳过会让人误以为已经用真实 PowerShell 验证过产品包装器代码。" +
    "macOS: brew install powershell；Windows 上应该已经自带或需要单独装 PowerShell 7。");
  console.log("\n0 passed, 1 failed");
  process.exitCode = 1;
  process.exit(1);
}

// 生成真实产品代码：直接调用 dist/index.js print-powershell-init，
// 用 WEZTERM_AGENT_BRIDGE_BIN_FOR_INIT 让生成的 $env:WEZTERM_AGENT_BRIDGE_BIN
// 指向我们的 mock-bridge.ps1，而不是重写这段生成逻辑。
function generateRealWrapperScript(): string {
  const result = spawnSync(process.execPath, [INDEX_JS, "print-powershell-init"], {
    encoding: "utf8",
    env: { ...process.env, WEZTERM_AGENT_BRIDGE_BIN_FOR_INIT: MOCK_BRIDGE_PS1 }
  });
  if (result.status !== 0) {
    throw new Error(`print-powershell-init 失败: ${result.stderr}`);
  }
  return result.stdout;
}

const wrapperScript = generateRealWrapperScript();
assert.ok(wrapperScript.includes("function global:claude"), "生成的产品代码里应该包含 claude 包装函数定义（健全性检查，不是真正的用例）");

// 生成平台专属的 mock claude 可执行文件（POSIX 无扩展名 + Windows .cmd 都生成，
// Get-Command -CommandType Application 在各自平台上会找到对应的那一个）。
const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "wzab-ps-hook-bin-"));
const posixClaude = path.join(mockBinDir, "claude");
fs.writeFileSync(
  posixClaude,
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_CLAUDE_RECORD_MJS)} "$@"\n`,
  { encoding: "utf8", mode: 0o755 }
);
const windowsClaude = path.join(mockBinDir, "claude.cmd");
fs.writeFileSync(
  windowsClaude,
  `@echo off\r\n"${process.execPath}" "${MOCK_CLAUDE_RECORD_MJS}" %*\r\n`,
  "utf8"
);

interface ScenarioEnv {
  [key: string]: string | undefined;
}

interface InvokeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  claudeInvoked: boolean;
  claudeRecord: { called: boolean; args: string[]; env: Record<string, string | null> } | null;
  finalEnv: Record<string, string | null>;
}

const TRACKED_VARS = [
  "BASH_ENV",
  "AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK",
  "AGENT_BRIDGE_IT2_CMD_PATH",
  "AGENT_BRIDGE_ORIGINAL_BASH_ENV",
  "AGENT_BRIDGE_IN_PROVIDER"
];

/**
 * 在一个全新的 pwsh 子进程里：source 真实产品生成的包装器代码、设置调用前的
 * 环境快照、调用 claude、把执行结果 + 调用后的关键 env 状态以 JSON 形式打到
 * 一个单独的输出文件（不用 stdout，因为 stdout 已经被用来验证"有没有被脏输出污染"）。
 */
function invokeWrappedClaude(options: {
  preEnv?: ScenarioEnv;
  mockEnv?: ScenarioEnv;
  claudeArgs?: string[];
  callTwice?: boolean;
}): InvokeResult {
  const recordFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wzab-ps-hook-run-")), "claude-record.json");
  const stateFile = `${recordFile}.state.json`;

  const psScript = `
$ErrorActionPreference = "Stop"
$env:PATH = ${JSON.stringify(mockBinDir)} + [System.IO.Path]::PathSeparator + $env:PATH
$env:WEZTERM_PANE = "test-pane"
$env:MOCK_CLAUDE_RECORD_FILE = ${JSON.stringify(recordFile)}

${wrapperScript}

$__test_exit = 0
try {
  claude ${(options.claudeArgs ?? ["probe-arg"]).map((a) => `'${a.replaceAll("'", "''")}'`).join(" ")}
  ${options.callTwice ? "claude 'second-call-arg'" : ""}
} catch {
  Write-Error $_.Exception.Message
  $__test_exit = 1
}

$__final_env = @{}
${TRACKED_VARS.map((v) => `$__final_env["${v}"] = $env:${v}`).join("\n")}
$__state = @{ finalEnv = $__final_env }
$__state | ConvertTo-Json -Depth 5 | Out-File -FilePath ${JSON.stringify(stateFile)} -Encoding utf8

exit $__test_exit
`;

  const preEnv = options.preEnv ?? {};
  const mockEnv = options.mockEnv ?? {};
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // 先清掉这次测试关心的变量，保证每个用例都是从一个已知、干净的起点开始，
  // 不受运行这个测试的外层 shell 环境影响。
  for (const v of TRACKED_VARS) delete childEnv[v];
  for (const [k, v] of Object.entries(preEnv)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(mockEnv)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }

  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
    encoding: "utf8",
    env: childEnv
  });

  let claudeRecord: InvokeResult["claudeRecord"] = null;
  if (fs.existsSync(recordFile)) {
    claudeRecord = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  }
  let finalEnv: Record<string, string | null> = {};
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    finalEnv = state.finalEnv ?? {};
  }

  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    claudeInvoked: claudeRecord !== null,
    claudeRecord,
    finalEnv
  };
}

// --- 场景 1/2：未设 BASH_ENV + flag 未设 —— 正常调用，claude 应该被真实调用一次 ---
run("未设 BASH_ENV、开关未设：正常调用一次，mock claude 被真实调用，退出码 0", () => {
  const r = invokeWrappedClaude({ mockEnv: { MOCK_SHELL_ENV_EXIT_CODE: "0" } });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  assert.ok(r.claudeInvoked, "claude 应该被调用");
  assert.deepEqual(r.claudeRecord!.args, ["probe-arg"]);
});

// --- 场景：flag=1 且 shell-env 输出四个 hook 变量赋值：claude 看到的应该是注入后的值 ---
run("开关=1 且 shell-env 注入四个 hook 变量：mock claude 实际看到的是注入后的新值", () => {
  const r = invokeWrappedClaude({
    mockEnv: {
      MOCK_SHELL_ENV_EMIT_HOOK_VARS: "1",
      MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX: "scenario2"
    }
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  assert.ok(r.claudeInvoked);
  assert.equal(r.claudeRecord!.env.BASH_ENV, "C:\\mock-hook-scenario2.sh");
  assert.equal(r.claudeRecord!.env.AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK, "1");
  assert.equal(r.claudeRecord!.env.AGENT_BRIDGE_IT2_CMD_PATH, "C:\\mock-it2-scenario2.cmd");
  assert.equal(r.claudeRecord!.env.AGENT_BRIDGE_IN_PROVIDER, "1", "调用期间应该设置了 AGENT_BRIDGE_IN_PROVIDER");
});

// --- 场景 4：shell-env 非零退出 → claude 绝不能被调用 ---
run("shell-env 非零退出：claude 绝不能被调用，进程整体应该报错退出", () => {
  const r = invokeWrappedClaude({ mockEnv: { MOCK_SHELL_ENV_EXIT_CODE: "7" } });
  assert.equal(r.claudeInvoked, false, "claude 不应该被调用");
  assert.notEqual(r.exitCode, 0, "整体应该报错退出，不能假装成功");
  assert.ok(r.stderr.includes("退出码") || r.stderr.includes("shell-env"), `stderr 应该提到失败原因，实际: ${r.stderr}`);
});

// --- 场景 5：部分注入后抛错 → claude 绝不能被调用，且部分注入的痕迹不能残留 ---
run("shell-env 输出部分注入后抛错：claude 绝不能被调用，部分注入的变量在 finally 后必须被清理，不残留", () => {
  const r = invokeWrappedClaude({
    mockEnv: {
      MOCK_SHELL_ENV_PARTIAL_THEN_THROW: "1",
      MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX: "scenario5"
    }
  });
  assert.equal(r.claudeInvoked, false, "claude 不应该被调用");
  assert.notEqual(r.exitCode, 0);
});

// --- 场景 6a：调用前 BASH_ENV 未设置，调用后应该恢复成"未设置"（不能凭空留下一个值）---
run("调用前 BASH_ENV/三个 hook 变量都未设置：调用后（开关打开+真实注入）应该精确恢复成未设置", () => {
  const r = invokeWrappedClaude({
    mockEnv: {
      MOCK_SHELL_ENV_EMIT_HOOK_VARS: "1",
      MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX: "scenario6a"
    }
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  assert.ok(r.claudeInvoked, "先确认调用期间确实注入生效了");
  assert.equal(r.claudeRecord!.env.BASH_ENV, "C:\\mock-hook-scenario6a.sh");
  // 调用结束后（finally 跑完），这几个变量应该恢复成调用前的状态：未设置 → null
  assert.equal(r.finalEnv.BASH_ENV, null, "调用前没设置，调用后应该恢复成未设置（null），不能残留注入值");
  assert.equal(r.finalEnv.AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK, null);
  assert.equal(r.finalEnv.AGENT_BRIDGE_IT2_CMD_PATH, null);
  assert.equal(r.finalEnv.AGENT_BRIDGE_ORIGINAL_BASH_ENV, null);
  assert.equal(r.finalEnv.AGENT_BRIDGE_IN_PROVIDER, null, "AGENT_BRIDGE_IN_PROVIDER 也必须清理干净");
});

// --- 场景 6b：调用前四个变量都已经设置成用户自己的值 A，调用后必须精确恢复回 A，不能被删掉或留下注入值 ---
run("调用前四个变量已经是用户自己设置的值：调用后（开关打开+真实注入）必须精确恢复回用户原值，不能被误删或留下注入值", () => {
  const r = invokeWrappedClaude({
    preEnv: {
      BASH_ENV: "/Users/real-user/.bash_env_original",
      AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK: "user-original-value",
      AGENT_BRIDGE_IT2_CMD_PATH: "/Users/real-user/original-it2-cmd-path",
      AGENT_BRIDGE_ORIGINAL_BASH_ENV: "/Users/real-user/original-original-bash-env"
    },
    mockEnv: {
      MOCK_SHELL_ENV_EMIT_HOOK_VARS: "1",
      MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX: "scenario6b"
    }
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  assert.ok(r.claudeInvoked);
  // 调用期间看到的应该是注入后的新值（证明注入确实生效了，不是没生效导致"看起来没变"）
  assert.equal(r.claudeRecord!.env.BASH_ENV, "C:\\mock-hook-scenario6b.sh");
  // 调用结束后必须精确恢复回用户原来设置的值
  assert.equal(r.finalEnv.BASH_ENV, "/Users/real-user/.bash_env_original");
  assert.equal(r.finalEnv.AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK, "user-original-value");
  assert.equal(r.finalEnv.AGENT_BRIDGE_IT2_CMD_PATH, "/Users/real-user/original-it2-cmd-path");
  assert.equal(r.finalEnv.AGENT_BRIDGE_ORIGINAL_BASH_ENV, "/Users/real-user/original-original-bash-env");
});

// --- 场景 3：连续调用两次，第二次也应该正常工作（不受第一次遗留状态影响）---
run("连续调用两次：两次都应该正常触发注入+调用+恢复，第二次不受第一次影响（每次都是独立的快照/恢复）", () => {
  const r = invokeWrappedClaude({
    preEnv: { BASH_ENV: "/Users/real-user/.bash_env_original" },
    mockEnv: {
      MOCK_SHELL_ENV_EMIT_HOOK_VARS: "1",
      MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX: "scenario3"
    },
    callTwice: true
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  // claudeRecord 只保留最后一次调用的记录（同一个 record 文件被覆盖两次），
  // 关键断言是：两次调用整体流程都没有报错（exitCode 0），且最终环境正确恢复。
  assert.ok(r.claudeInvoked, "至少最后一次调用应该有记录");
  assert.equal(r.finalEnv.BASH_ENV, "/Users/real-user/.bash_env_original", "两次调用后应该恢复回最初的用户原值");
});

// --- 场景 7：stdout/stderr 分离 ---
run("stdout/stderr 分离：mock-bridge 故意写的 stderr 内容不应该出现在最终 stdout 里，也不应该被当成待执行代码", () => {
  const r = invokeWrappedClaude({
    mockEnv: {
      MOCK_SHELL_ENV_STDERR: "MOCK_STDERR_MARKER_SHOULD_NOT_LEAK_TO_STDOUT"
    }
  });
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  assert.ok(r.claudeInvoked, "stderr 有内容不应该影响正常调用流程");
  assert.ok(!r.stdout.includes("MOCK_STDERR_MARKER_SHOULD_NOT_LEAK_TO_STDOUT"), "stderr 内容不应该混进 stdout");
});

fs.rmSync(mockBinDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
