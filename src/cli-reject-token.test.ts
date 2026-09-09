/**
 * 集成测试：`daemon --token <token>` 必须被拒绝，且拒绝时不回显 token 值。
 * 用真实子进程跑编译后的 CLI（node dist/index.js），不 mock main() 内部逻辑——
 * 这是唯一能真实验证"进程退出码非0 + stderr 不包含 token 明文"的方式
 * （单元测试 mock 不掉"这条 error message 会被 process.stderr.write 真实打印出去"这件事）。
 * 运行：node dist/cli-reject-token.test.js（需要先 npm run build）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.join(__dirname, "index.js"); // dist/index.js（同目录，编译后）

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

const SECRET_MARKER = "should-never-be-echoed-back-xyz789";

run("daemon --token <token> 被拒绝：非0退出码，且 stderr 不回显 token 明文", () => {
  const result = spawnSync(
    process.execPath,
    [CLI_ENTRY, "daemon", "--port", "0", "--token", SECRET_MARKER],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.notEqual(result.status, 0, "应以非0退出码失败（不应该真的起daemon）");
  const stderr = result.stderr ?? "";
  const stdout = result.stdout ?? "";
  assert.ok(!stderr.includes(SECRET_MARKER), `stderr 不应回显 token 明文，实际 stderr: ${stderr}`);
  assert.ok(!stdout.includes(SECRET_MARKER), `stdout 不应回显 token 明文，实际 stdout: ${stdout}`);
  assert.ok(stderr.includes("AGENT_BRIDGE_TOKEN"), "错误信息应指引用户改用环境变量");
});

run("daemon 不传 --token、也不设 AGENT_BRIDGE_TOKEN 环境变量：同样报错，不是静默用空 token 启动", () => {
  const result = spawnSync(process.execPath, [CLI_ENTRY, "daemon", "--port", "0"], {
    encoding: "utf8",
    timeout: 10_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "AGENT_BRIDGE_TOKEN"))
  });
  assert.notEqual(result.status, 0, "缺少 token 来源时应失败退出");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
