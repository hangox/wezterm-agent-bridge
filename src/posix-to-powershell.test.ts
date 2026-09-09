/**
 * posix-to-powershell 转译函数单测
 * 运行：node dist/posix-to-powershell.test.js
 *
 * 安全设计（2026-09 收口后）：不再用变量名启发式猜"哪些 env 是敏感的"——
 * 那份后缀白名单必然不完整（真实凭据变量名五花八门，见下面专门的覆盖测试），
 * 与其对外宣称"敏感变量已隐藏"但实际漏网，现在改成：只要命令里带 env 赋值，
 * 全部 KEY=VALUE 都走 SecretEnvWriter（临时文件通道），一个都不内联到会被
 * wezterm send-text 真实"打印"到 pane 的可见命令文本里。这里的测试全部用
 * 桩 SecretEnvWriter，断言两件事：(a) 值绝不出现在返回的命令字符串里；
 * (b) secretWriter 收到的 KV 集合跟输入完全一致（不多不少、顺序一致）。
 */
import assert from "node:assert/strict";
import { tryTranslatePosixSpawnToPowershell } from "./posix-to-powershell.js";

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

/** 桩 SecretEnvWriter：记录每次调用收到的 vars，返回固定的假文件路径，不做真实 I/O。 */
function stubWriter(): { writer: { write(vars: Array<{ key: string; value: string }>): string }; calls: Array<{ key: string; value: string }>[] } {
  const calls: Array<{ key: string; value: string }>[] = [];
  return {
    calls,
    writer: {
      write(vars) {
        calls.push(vars);
        return "C:\\fake\\stub-secret-file.json";
      }
    }
  };
}

// --- 基础转译：cwd/binary/args 保留原样，env 全部路由到 secretWriter ---

run("真实样本（Windows 路径 + 多 envvar + 复杂 args）", () => {
  const { writer, calls } = stubWriter();
  const input =
    "cd 'C:\\Users\\testuser\\ai' && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1" +
    " ANTHROPIC_BASE_URL=https://example.com/anthropic" +
    " 'C:\\Users\\testuser\\.local\\bin\\claude-teammate.bat'" +
    " --agent-id reviewer@haiku-swarm-2026-05-14 --agent-name reviewer" +
    " --team-name haiku-swarm-2026-05-14 --agent-color green" +
    " --parent-session-id 18c3bd94-abc --dangerously-skip-permissions --model haiku";
  const result = tryTranslatePosixSpawnToPowershell(input, writer);
  assert.ok(result !== null);
  assert.equal(
    result,
    "Set-Location 'C:\\Users\\testuser\\ai'; " +
      "$__wzab_secret = Get-Content -Raw 'C:\\fake\\stub-secret-file.json' | ConvertFrom-Json; " +
      '$__wzab_secret.PSObject.Properties | ForEach-Object { Set-Item -Path "Env:$($_.Name)" -Value $_.Value }; ' +
      "Remove-Item 'C:\\fake\\stub-secret-file.json' -Force -ErrorAction SilentlyContinue; " +
      "& 'C:\\Users\\testuser\\.local\\bin\\claude-teammate.bat'" +
      " --agent-id reviewer@haiku-swarm-2026-05-14 --agent-name reviewer" +
      " --team-name haiku-swarm-2026-05-14 --agent-color green" +
      " --parent-session-id 18c3bd94-abc --dangerously-skip-permissions --model haiku"
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { key: "CLAUDECODE", value: "1" },
    { key: "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", value: "1" },
    { key: "ANTHROPIC_BASE_URL", value: "https://example.com/anthropic" }
  ]);
});

run("VAL 含 URL 与查询参数（= 和 & 在 VALUE 里）不内联，binary/args 保留原样", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell(
    "cd '/tmp/work' && env API_BASE=https://example.com/v1?key=abc&fmt=json '/usr/local/bin/claude' --task foo",
    writer
  );
  assert.ok(result !== null);
  assert.ok(!result!.includes("https://example.com/v1?key=abc&fmt=json"), "VALUE 不应出现在命令文本里");
  assert.ok(result!.includes("& '/usr/local/bin/claude' --task foo"));
  assert.deepEqual(calls[0], [{ key: "API_BASE", value: "https://example.com/v1?key=abc&fmt=json" }]);
});

run("VAL 含单引号：值原样交给 secretWriter（不需要 PowerShell 转义，因为根本不内联进命令文本）", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell("cd '/work' && env MSG=it's_done '/bin/binary' --flag", writer);
  assert.ok(result !== null);
  assert.ok(!result!.includes("it's_done") && !result!.includes("it''s_done"));
  assert.deepEqual(calls[0], [{ key: "MSG", value: "it's_done" }]);
});

run("多个 envvar（4 个）：全部原样进 secretWriter 一次调用，顺序一致", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell(
    "cd 'C:\\project' && env A=1 B=two C=3 D=four 'C:\\binary.exe' arg1 arg2",
    writer
  );
  assert.ok(result !== null);
  assert.ok(result!.includes("& 'C:\\binary.exe' arg1 arg2"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { key: "A", value: "1" },
    { key: "B", value: "two" },
    { key: "C", value: "3" },
    { key: "D", value: "four" }
  ]);
});

run("args 含 @ - / 等特殊字符：args 部分不受 env 保护通道影响，原样保留", () => {
  const { writer } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell(
    "cd '/work' && env KEY=val '/path/to/binary' --agent-id user@host-123 /flag /sub/path",
    writer
  );
  assert.ok(result !== null);
  assert.ok(result!.includes("& '/path/to/binary' --agent-id user@host-123 /flag /sub/path"));
});

run("非 POSIX spawn 格式 → 返回 null，不调用 secretWriter", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell("echo hello world", writer);
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

run("没有 env 赋值（cd && env 后面直接是 binary）：不调用 secretWriter，不产生空的加载片段", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell("cd '/work' && env '/bin/binary' --flag", writer);
  assert.ok(result !== null);
  assert.equal(calls.length, 0, "没有 env 赋值时不应调用 secretWriter");
  assert.ok(!result!.includes("ConvertFrom-Json"), "没有 env 赋值时不应生成加载片段");
  assert.equal(result, "Set-Location '/work'; & '/bin/binary' --flag");
});

// --- 覆盖面回归：曾经会被"敏感变量名后缀白名单"漏掉的真实凭据变量名，
//     现在因为"全部 env 都走保护通道"而不再依赖名单，天然覆盖 ---
run("AWS_SECRET_ACCESS_KEY（老后缀白名单会漏——结尾是 _KEY 不是 _SECRET）不出现在命令文本里", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell(
    "cd '/work' && env AWS_SECRET_ACCESS_KEY=fake-aws-secret-value '/bin/claude' --x",
    writer
  );
  assert.ok(result !== null);
  assert.ok(!result!.includes("fake-aws-secret-value"));
  assert.deepEqual(calls[0], [{ key: "AWS_SECRET_ACCESS_KEY", value: "fake-aws-secret-value" }]);
});

run("AWS_BEARER_TOKEN_BEDROCK（老后缀白名单会漏——结尾是 _BEDROCK 不是 _TOKEN）不出现在命令文本里", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell(
    "cd '/work' && env AWS_BEARER_TOKEN_BEDROCK=fake-bedrock-bearer '/bin/claude' --x",
    writer
  );
  assert.ok(result !== null);
  assert.ok(!result!.includes("fake-bedrock-bearer"));
  assert.deepEqual(calls[0], [{ key: "AWS_BEARER_TOKEN_BEDROCK", value: "fake-bedrock-bearer" }]);
});

run("OTEL_EXPORTER_OTLP_HEADERS（可能携带认证 header，老后缀白名单完全不会命中）不出现在命令文本里", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell(
    "cd '/work' && env OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20fake-otel-header '/bin/claude' --x",
    writer
  );
  assert.ok(result !== null);
  assert.ok(!result!.includes("fake-otel-header"));
  assert.deepEqual(calls[0], [{ key: "OTEL_EXPORTER_OTLP_HEADERS", value: "Authorization=Bearer%20fake-otel-header" }]);
});

run("裸 KEY / PLAIN 这种看起来完全不敏感的变量名，同样不内联（不再区分敏感/非敏感）", () => {
  const { writer, calls } = stubWriter();
  const result = tryTranslatePosixSpawnToPowershell("cd '/work' && env KEY=val PLAIN=visible '/bin/binary' --flag", writer);
  assert.ok(result !== null);
  assert.ok(!result!.includes("$env:KEY") && !result!.includes("'val'") && !result!.includes("'visible'"));
  assert.deepEqual(calls[0], [
    { key: "KEY", value: "val" },
    { key: "PLAIN", value: "visible" }
  ]);
});

// --- 负向测试：命令带 env 赋值但解析失败时，必须拒绝（throw），
//     绝不能退回"把原始命令整段塞进 bash 兜底再发出去"这种会重新暴露
//     env 原文（含 token）的行为。旧版本这里有 GIT_BASH_FALLBACK，已删除。

run("cwd 内容意外吞掉了 connector（解析结构错位）：必须 throw，不产生任何返回值，且错误信息不回显原始命令/密钥", () => {
  const { writer, calls } = stubWriter();
  const secretMarker = "should-never-leak-unterminated-quote-xyz";
  const input = `cd 'C:\\Users\\test${secretMarker} && env TOKEN=${secretMarker} '/bin/binary'`;
  assert.throws(
    () => tryTranslatePosixSpawnToPowershell(input, writer),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretMarker), `错误信息不应包含原始命令/密钥内容，实际: ${err.message}`);
      return true;
    }
  );
  assert.equal(calls.length, 0, "解析失败时不应写任何 secret 文件");
});

run("粗筛命中但严格解析失败（\"&& env\" 子串只出现在 cwd 引号内部，闭合引号后并不是真正的 connector）：必须 throw 拒绝，不回退明文", () => {
  const { writer, calls } = stubWriter();
  // cmd.includes(" && env ") 这个粗筛只做子串匹配：这条命令里 " && env " 确实作为
  // 字面文本出现在带引号的 cwd 内部，让粗筛通过；但严格按位置解析时，cwd 引号闭合后
  // 紧跟的是 "/bin/binary --flag"，根本不是 " && env " connector —— 应该在这里被
  // 正确拒绝，而不是误判成合法格式去翻译（这条命令本身也没有 env 赋值可保护，
  // 但拒绝而不是"猜一个错的结构去跑"本身就是正确行为，避免后面的 binary/args 被
  // 拼错导致更难排查的问题）。
  const input = "cd 'weird && env value' /bin/binary --flag";
  assert.throws(
    () => tryTranslatePosixSpawnToPowershell(input, writer),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

run("cd X && env（env 赋值和 binary 都缺失）：必须 throw 拒绝，不返回空壳命令", () => {
  const { writer } = stubWriter();
  assert.throws(() => tryTranslatePosixSpawnToPowershell("cd '/work' && env ", writer));
});

run("裸 \"env KEY=VAL binary\"（没有 cd 前缀，不是固定形态但确实带 env 赋值）：必须 throw 拒绝，不当成\"无 env\"原样透传", () => {
  const { writer, calls } = stubWriter();
  const secretMarker = "should-never-leak-bare-env-no-cd-prefix";
  const input = `env ANTHROPIC_AUTH_TOKEN=${secretMarker} /bin/claude --flag`;
  assert.throws(
    () => tryTranslatePosixSpawnToPowershell(input, writer),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretMarker), `错误信息不应回显密钥，实际: ${err.message}`);
      return true;
    }
  );
  assert.equal(calls.length, 0, "不应该走到 secretWriter，因为整条请求都被拒绝");
});

run("cd/env 之间空白不标准（多空格/tab，\" && env \" 单空格粗筛匹配不上）：仍需识别出带 env 赋值并 throw 拒绝，不能因为粗筛没命中就当无 env", () => {
  const { writer, calls } = stubWriter();
  const secretMarker = "should-never-leak-nonstandard-whitespace";
  const input = `cd  '/work'  &&  env  TOKEN=${secretMarker}  /bin/binary`;
  assert.throws(
    () => tryTranslatePosixSpawnToPowershell(input, writer),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretMarker));
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

run("普通不含 env 的手工命令（不匹配 \"cd X && env ...\" 粗筛）：保持现有行为，原样返回 null 不报错", () => {
  const { writer, calls } = stubWriter();
  // 明确覆盖"普通不含env的手工命令可以保持现有行为"边界：
  // 这类命令根本没有 env 赋值可暴露，null（原样转发）是安全的，不应该被误伤成报错。
  const result = tryTranslatePosixSpawnToPowershell("ls -la '/some path with spaces' && echo done", writer);
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
