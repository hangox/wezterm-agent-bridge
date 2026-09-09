/**
 * 真实回归测试（不是纯代码审查）：daemon 身份校验、超时保护、
 * ensureDaemon() 不再依据 stale PID 自动 kill、诊断信息不泄露 token。
 * 全程用 synthetic token（固定字符串），不发真实网络请求（只连
 * 127.0.0.1 本机端口），不启动真实 WezTerm/AI 模型调用。
 *
 * 因为这里会启动真实的 in-process http server（runDaemon 本身设计成
 * "启动后一直监听，不主动关闭"，跟真实生产用法一致），这个测试文件结尾会
 * 显式 process.exit()，不依赖 Node 事件循环自然清空。
 *
 * 运行：node dist/ensure-daemon-security.test.js
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDaemon } from "./daemon.js";
import { ensureDaemon } from "./ensure-daemon.js";
import { BridgeClient } from "./client.js";
import { daemonInfoPath } from "./paths.js";
import { writeJsonFile } from "./json-file.js";
import type { DaemonInfo } from "./types.js";

let passed = 0;
let failed = 0;

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${String(err)}`);
    failed++;
  }
}

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wzab-daemon-sec-test-"));
}

const SYNTHETIC_TOKEN = "synthetic-test-token-should-never-leak-abc123xyz";

/** 真实起一个 daemon（in-process，随机端口），返回真实 DaemonInfo。 */
async function startRealDaemon(stateDir: string, token = SYNTHETIC_TOKEN): Promise<DaemonInfo> {
  await runDaemon({ stateDir, token, port: 0 });
  const info = JSON.parse(fs.readFileSync(daemonInfoPath(stateDir), "utf8")) as DaemonInfo;
  return info;
}

/** 不经过 BridgeClient，直接发原始 HTTP 请求，方便测"没带 token 会怎样"这种场景。 */
function rawRequest(port: number, options: { path: string; token?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path,
        method: "GET",
        headers: options.token ? { authorization: `Bearer ${options.token}` } : {}
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

await run("daemon.ts /health 现在要求鉴权：不带 token 返回 401，不是之前的裸 200", async () => {
  const stateDir = tmpStateDir();
  const info = await startRealDaemon(stateDir);
  const noAuth = await rawRequest(info.port, { path: "/health" });
  assert.equal(noAuth.status, 401, `不带 token 应该 401，实际: ${noAuth.status} ${noAuth.body}`);
  const withAuth = await rawRequest(info.port, { path: "/health", token: SYNTHETIC_TOKEN });
  assert.equal(withAuth.status, 200);
  const parsed = JSON.parse(withAuth.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.pid, info.pid);
});

await run("client.ts health() 校验响应身份：pid 不匹配时必须 throw，不能只看 200 就当健康", async () => {
  // 造一个假 HTTP server，返回 200 + {ok:true} 但 pid 是错的，
  // 模拟"同端口恰好被另一个无关服务占用、也返回类似结构 JSON"这种场景。
  const fakeServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: 99999999 }));
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  const address = fakeServer.address();
  if (!address || typeof address === "string") throw new Error("监听地址异常");

  const fakeInfo: DaemonInfo = {
    port: address.port,
    token: SYNTHETIC_TOKEN,
    pid: 12345, // 期望的 pid，跟假 server 返回的 99999999 不一致
    startedAt: new Date().toISOString()
  };
  await assert.rejects(
    () => new BridgeClient(fakeInfo).health(),
    /pid|身份/,
    "pid 不匹配时 health() 应该 throw，且错误信息应该提到身份不匹配"
  );
  fakeServer.close();
});

await run("client.ts 请求超时：服务端永不响应时，health() 应该在有界时间内 reject，不会无限挂起", async () => {
  const hangingServer = http.createServer(() => {
    // 故意什么都不做：不 writeHead、不 end，模拟卡死/无响应的服务端。
  });
  await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
  const address = hangingServer.address();
  if (!address || typeof address === "string") throw new Error("监听地址异常");

  const fakeInfo: DaemonInfo = {
    port: address.port,
    token: SYNTHETIC_TOKEN,
    pid: 1,
    startedAt: new Date().toISOString()
  };
  const start = Date.now();
  await assert.rejects(() => new BridgeClient(fakeInfo).health(), /超时|timeout/i);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `health() 的超时应该明显短于 ensureDaemon 的 5 秒 deadline，实际耗时 ${elapsed}ms`);
  hangingServer.close();
});

await run("client.ts 总时限（不是空闲超时）：服务端持续'慢滴血'式发数据（每次都续期空闲计时器）也必须按总时限强制超时，不能被无限拖住", async () => {
  // 关键：这个 server 一直在发数据（没有真正卡死），如果超时机制退化成"空闲超时"
  // （每次收到数据就重置计时器），这个请求永远不会超时——必须是"从请求发出起
  // 满 timeoutMs 就必须强制结束"的硬性总时限。这里故意让服务端持续发送、但
  // 永远不 res.end()（body 长度不确定，客户端会一直等 'end' 事件），验证总时限
  // 依然生效。
  const slowDripServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const interval = setInterval(() => {
      res.write(" "); // 每次只发一个字节，持续"续期"传统空闲超时，但从不 end()
    }, 300);
    res.on("close", () => clearInterval(interval));
  });
  await new Promise<void>((resolve) => slowDripServer.listen(0, "127.0.0.1", resolve));
  const address = slowDripServer.address();
  if (!address || typeof address === "string") throw new Error("监听地址异常");

  const fakeInfo: DaemonInfo = {
    port: address.port,
    token: SYNTHETIC_TOKEN,
    pid: 1,
    startedAt: new Date().toISOString()
  };
  const start = Date.now();
  await assert.rejects(() => new BridgeClient(fakeInfo).health(), /超时|timeout/i);
  const elapsed = Date.now() - start;
  // health 的超时是 2000ms；持续每 300ms 发一个字节的话，纯空闲超时机制永远不会
  //触发（每 300ms 就续期一次，远小于 2000ms 空闲阈值），只有总时限机制才会在
  // 大约 2000ms 左右强制掐断——断言一个合理的时间窗口，既不能太快（说明可能是
  // 别的错误路径而不是真的等到总时限）也不能远超 2000ms（说明真的被慢滴血拖住了）。
  assert.ok(elapsed >= 1800 && elapsed < 4000, `应该在总时限附近强制超时，实际耗时 ${elapsed}ms`);
  slowDripServer.closeAllConnections?.();
  slowDripServer.close();
});

await run("client.ts health() 身份不匹配错误信息：不能把整个（不受信任的）响应体序列化进错误信息，哪怕响应体里塞了敏感字段", async () => {
  const sensitiveMarker = "SHOULD-NEVER-LEAK-reflected-authorization-header-value";
  const reflectingServer = http.createServer((req, res) => {
    // 模拟一个恶意/故障服务端：把请求带的 Authorization 头原样塞进响应体里，
    // 混着一个明显错误的 pid，测试我们的错误信息处理绝不能把这坨不受信任的
    // 响应体整个转述出去。
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      pid: 424242,
      reflectedAuthorizationHeader: req.headers.authorization ?? sensitiveMarker,
      anotherSensitiveField: sensitiveMarker
    }));
  });
  await new Promise<void>((resolve) => reflectingServer.listen(0, "127.0.0.1", resolve));
  const address = reflectingServer.address();
  if (!address || typeof address === "string") throw new Error("监听地址异常");

  const fakeInfo: DaemonInfo = {
    port: address.port,
    token: SYNTHETIC_TOKEN,
    pid: 1, // 跟服务端返回的 424242 不一致，触发身份不匹配错误路径
    startedAt: new Date().toISOString()
  };
  let caught: Error | undefined;
  try {
    await new BridgeClient(fakeInfo).health();
  } catch (error) {
    caught = error as Error;
  }
  assert.ok(caught, "pid 不匹配应该 throw");
  assert.ok(!caught!.message.includes(SYNTHETIC_TOKEN), "错误信息不应该包含 Bearer token 本身");
  assert.ok(!caught!.message.includes(sensitiveMarker), `错误信息不应该包含响应体里的敏感字段，实际信息: ${caught!.message}`);
  assert.ok(!caught!.message.includes("reflectedAuthorizationHeader"), "错误信息不应该把整个响应体结构转述出来");
  assert.ok(caught!.message.includes("424242"), "但非敏感的、类型安全摘要出来的 pid 应该还在，方便排查");
  reflectingServer.close();
});

await run("ensureDaemon()：已有健康 daemon 但 socket 不匹配 → 明确拒绝，不自动杀、不自动新建，原 daemon 调用后依然健康在跑", async () => {
  const stateDir = tmpStateDir();
  const info = await startRealDaemon(stateDir);
  // 手工在 daemon.json 里写一个 weztermUnixSocket，模拟"这个 daemon 绑定了某个
  // WezTerm 实例"；然后通过 WEZTERM_UNIX_SOCKET 显式期望一个不同的 socket
  // （desiredSocket 优先读这个环境变量——不设的话 !desiredSocket 恒真，
  // socketMatches 会直接放行，测不到不匹配分支，所以这里必须显式设置）。
  const infoWithSocket: DaemonInfo = { ...info, weztermUnixSocket: "/tmp/real-wezterm-socket-A" };
  await writeJsonFile(daemonInfoPath(stateDir), infoWithSocket);

  const originalDesiredSocketEnv = process.env.WEZTERM_UNIX_SOCKET;
  process.env.WEZTERM_UNIX_SOCKET = "/tmp/different-wezterm-socket-B";
  try {
    await assert.rejects(
      () => ensureDaemon(stateDir),
      /不会自动终止|AGENT_BRIDGE_STATE_DIR/,
      "socket 不匹配时应该明确拒绝，错误信息应该提到不会自动终止、以及独立 state dir 的建议"
    );
  } finally {
    if (originalDesiredSocketEnv === undefined) delete process.env.WEZTERM_UNIX_SOCKET;
    else process.env.WEZTERM_UNIX_SOCKET = originalDesiredSocketEnv;
  }

  // 关键：原 daemon 进程必须还活着、还健康——拒绝逻辑绝不能顺手把它杀了。
  const stillHealthy = await rawRequest(info.port, { path: "/health", token: SYNTHETIC_TOKEN });
  assert.equal(stillHealthy.status, 200, "原 daemon 在这次 ensureDaemon() 调用后应该依然健康，没有被误杀");
});

await run("ensureDaemon()：daemon.json 是 stale（进程早已不在/端口没人监听）时，超时诊断信息不能泄露 token", async () => {
  const stateDir = tmpStateDir();
  // 构造一个 stale daemon.json：端口没有任何东西监听（不健康），但 token 是
  // 我们要追踪的 synthetic 值——这个文件应该被当作失效状态处理，绝不能被
  // JSON.stringify 整个丢进错误信息里。
  const staleInfo: DaemonInfo = {
    port: 1, // 保留端口，几乎不可能真的监听着东西，必然连接失败/不健康
    token: SYNTHETIC_TOKEN,
    pid: 999999, // 几乎不可能是真实存在的进程
    startedAt: new Date().toISOString()
  };
  await writeJsonFile(daemonInfoPath(stateDir), staleInfo);

  // entrypoint 指向一个真实存在但会立刻报错退出、绝不会成功写出新 daemon.json 的
  // 脚本，逼真模拟"新 daemon 也起不来，只能超时"这条路径，同时不会真的等 5 秒
  // 那么久——因为 spawn 本身没问题（真实 node），只是子进程秒退，daemon.json
  // 停留在最初那份 stale 内容上，轮询期间反复读到的都是含 token 的旧文件。
  const brokenEntrypoint = path.join(stateDir, "broken-entrypoint-does-not-export-daemon.js");
  fs.writeFileSync(brokenEntrypoint, "process.exit(1);\n", "utf8");

  const originalArgv1 = process.argv[1];
  process.argv[1] = brokenEntrypoint;
  try {
    let caught: Error | undefined;
    try {
      await ensureDaemon(stateDir);
    } catch (error) {
      caught = error as Error;
    }
    assert.ok(caught, "应该抛出超时错误");
    assert.ok(!caught!.message.includes(SYNTHETIC_TOKEN), `错误信息绝不能包含 token 明文，实际信息: ${caught!.message}`);
    assert.ok(caught!.message.includes("999999") || caught!.message.includes("bridge daemon 启动超时"), "错误信息应该仍然带上 pid 等非敏感诊断信息");
  } finally {
    process.argv[1] = originalArgv1;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
// 见文件头注释：runDaemon 启动的真实 server 会一直监听，不显式退出的话这个
// 测试脚本永远不会自然结束。
process.exit(process.exitCode ?? 0);
