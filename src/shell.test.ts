/**
 * buildIt2ShimFiles 纯函数单测——不做真实 I/O、不碰真实用户 state 目录、
 * 不需要真实 Windows/Git Bash 环境。只断言"给定平台，应该生成哪些文件、
 * 内容是什么"，跟"这些内容在真实 Git Bash/PowerShell/cmd.exe 里到底能不能跑"
 * 是两件事——后者需要 binary-investigator 在真实 Windows 上验证，这里的单测
 * 范围明确只到"生成逻辑本身正确"为止。
 * 运行：node dist/shell.test.js
 */
import assert from "node:assert/strict";
import { buildIt2ShimFiles } from "./shell.js";

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

const NODE_EXEC_WIN = "C:\\Program Files\\nodejs\\node.exe";
const SHIM_CMD_WIN = "C:\\Users\\testuser\\.local\\bin\\wezterm-agent-bridge\\dist\\index.js";
const NODE_EXEC_POSIX = "/usr/local/bin/node";
const SHIM_CMD_POSIX = "/usr/local/lib/node_modules/wezterm-agent-bridge/dist/index.js";

run("win32：生成三件套 it2 + it2.cmd + it2.ps1（这是本轮修复的核心——之前漏了 it2 本身）", () => {
  const files = buildIt2ShimFiles("win32", NODE_EXEC_WIN, SHIM_CMD_WIN);
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, ["it2", "it2.cmd", "it2.ps1"]);
});

run("win32：it2（无扩展名 POSIX shim）内容是 #!/bin/sh + exec，且带可执行 mode", () => {
  const files = buildIt2ShimFiles("win32", NODE_EXEC_WIN, SHIM_CMD_WIN);
  const it2 = files.find((f) => f.name === "it2")!;
  assert.ok(it2.content.startsWith("#!/bin/sh\n"));
  assert.equal(it2.mode, 0o755, "必须带可执行 mode，这是 Git Bash command -v 探测的前提之一");
  assert.equal(
    it2.content,
    `#!/bin/sh
exec '${NODE_EXEC_WIN}' '${SHIM_CMD_WIN}' it2 "$@"
`
  );
});

run("win32：it2.cmd 内容正确转发参数（%*）且不带可执行 mode（cmd.exe 不需要 POSIX x 位）", () => {
  const files = buildIt2ShimFiles("win32", NODE_EXEC_WIN, SHIM_CMD_WIN);
  const cmd = files.find((f) => f.name === "it2.cmd")!;
  assert.equal(cmd.content, `@echo off\r\n"${NODE_EXEC_WIN}" "${SHIM_CMD_WIN}" it2 %*\r\n`);
  assert.equal(cmd.mode, undefined);
});

run("win32：it2.ps1 内容正确转发参数（@args）、正确设置退出码，路径经 PowerShell 单引号转义", () => {
  const files = buildIt2ShimFiles("win32", NODE_EXEC_WIN, SHIM_CMD_WIN);
  const ps1 = files.find((f) => f.name === "it2.ps1")!;
  assert.equal(
    ps1.content,
    `& '${NODE_EXEC_WIN}' '${SHIM_CMD_WIN}' it2 @args\r\nexit $LASTEXITCODE\r\n`
  );
  assert.equal(ps1.mode, undefined);
});

run("win32：路径含单引号时 it2.ps1 正确转义成两个单引号（PowerShell 规范），不产生语法错误的字符串", () => {
  const trickyPath = "C:\\Users\\o'brien\\node.exe";
  const files = buildIt2ShimFiles("win32", trickyPath, SHIM_CMD_WIN);
  const ps1 = files.find((f) => f.name === "it2.ps1")!;
  assert.ok(ps1.content.includes("o''brien"), `PowerShell 单引号转义应把 ' 变成 ''，实际: ${ps1.content}`);
  assert.ok(!ps1.content.includes("o'brien'"), "不应该出现未转义的单引号导致字符串提前截断");
});

run("win32：路径含空格时三个 shim 都能正确包裹（cmd.cmd 用双引号、ps1/it2 用单引号），不会因为空格拆成多个 token", () => {
  const spacedNode = "C:\\Program Files\\nodejs\\node.exe";
  const spacedShim = "C:\\Program Files\\wezterm agent bridge\\dist\\index.js";
  const files = buildIt2ShimFiles("win32", spacedNode, spacedShim);
  const cmd = files.find((f) => f.name === "it2.cmd")!;
  const ps1 = files.find((f) => f.name === "it2.ps1")!;
  const it2 = files.find((f) => f.name === "it2")!;
  assert.ok(cmd.content.includes(`"${spacedNode}"`) && cmd.content.includes(`"${spacedShim}"`));
  assert.ok(ps1.content.includes(`'${spacedNode}'`) && ps1.content.includes(`'${spacedShim}'`));
  assert.ok(it2.content.includes(`'${spacedNode}'`) && it2.content.includes(`'${spacedShim}'`));
});

run("非 win32（POSIX：darwin/linux）：只生成 it2 一个文件，跟历史行为一致，不额外生成 cmd/ps1", () => {
  const files = buildIt2ShimFiles("darwin", NODE_EXEC_POSIX, SHIM_CMD_POSIX);
  assert.deepEqual(
    files.map((f) => f.name),
    ["it2"]
  );
  assert.equal(files[0].mode, 0o755);
  assert.equal(
    files[0].content,
    `#!/bin/sh
exec '${NODE_EXEC_POSIX}' '${SHIM_CMD_POSIX}' it2 "$@"
`
  );

  const linuxFiles = buildIt2ShimFiles("linux", NODE_EXEC_POSIX, SHIM_CMD_POSIX);
  assert.deepEqual(
    linuxFiles.map((f) => f.name),
    ["it2"]
  );
});

run("POSIX：路径含单引号时正确转义为 '\\'' （POSIX shell 规范），不会截断字符串", () => {
  const trickyPath = "/Users/o'brien/bin/node";
  const files = buildIt2ShimFiles("darwin", trickyPath, SHIM_CMD_POSIX);
  const it2 = files[0];
  assert.ok(it2.content.includes("o'\\''brien"), `POSIX 单引号转义应是 '\\''，实际: ${it2.content}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
