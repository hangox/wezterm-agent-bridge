import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { BridgeClient } from "./client.js";
import { daemonInfoPath, defaultStateDir } from "./paths.js";
import { readJsonFile } from "./json-file.js";
import type { DaemonInfo } from "./types.js";
import { discoverWeztermSocket } from "./wezterm-socket.js";

export async function ensureDaemon(stateDir = defaultStateDir()): Promise<DaemonInfo> {
  await fs.promises.mkdir(stateDir, { recursive: true });
  const desiredSocket = process.env.WEZTERM_UNIX_SOCKET ?? await discoverWeztermSocket();
  if (desiredSocket) {
    process.env.WEZTERM_UNIX_SOCKET = desiredSocket;
  }
  // 安全边界：不再依据落盘的 daemon.json 里的 PID 自动 kill 任何进程。
  // daemon.json 是 stale（daemon 早就退出、文件没清理）时，PID 完全可能已经被
  // 操作系统回收、复用给一个跟 bridge 毫无关系的进程——`process.kill(那个PID)`
  // 会杀掉无关进程。即便 daemon 是真的健康在跑，也可能属于另一个 WezTerm GUI
  // 实例/另一个用户会话（比如两边都没设 WEZTERM_UNIX_SOCKET、恰好用了同一个
  // 默认 state dir），自动杀掉它同样不安全。
  //
  // 处理策略：
  // - 健康 + socket 匹配期望 → 直接复用，原有行为不变。
  // - 健康 + socket 不匹配期望 → 明确拒绝（throw），不自动杀、不自动切换，
  //   提示用户如果确实要跑多个实例，请用独立的 AGENT_BRIDGE_STATE_DIR。
  // - 不健康（进程已死/端口没人监听/鉴权对不上等）→ 视为失效状态，直接往下走
  //   "新建 daemon"；新 daemon 启动后会原子覆盖这个 stale 的 daemon.json，
  //   不需要、也不会尝试杀掉任何旧 PID。
  const existing = await readJsonFile<DaemonInfo>(daemonInfoPath(stateDir));
  if (existing) {
    const healthy = await isHealthy(existing);
    if (healthy) {
      if (socketMatches(existing, desiredSocket)) {
        return existing;
      }
      throw new Error(
        `已有一个健康的 bridge daemon 在跑（pid=${existing.pid}, port=${existing.port}），但它绑定的 ` +
          `WezTerm socket 跟这次期望的不一致（现有: ${existing.weztermUnixSocket ?? "(无)"}，期望: ${desiredSocket ?? "(无)"}）。` +
          `为避免误杀可能属于另一个 WezTerm 实例/另一用户会话的进程，不会自动终止它。` +
          `如果你确实需要在这台机器上同时使用多个不同 WezTerm 实例对应的 bridge daemon，` +
          `请给这次调用设置独立的 AGENT_BRIDGE_STATE_DIR 环境变量。`
      );
    }
    // 不健康：不 kill 任何 PID，直接当作 stale 状态处理，往下走新建 daemon 的流程。
  }

  const token = crypto.randomBytes(24).toString("hex");
  const entrypoint = process.argv[1];
  const spawnExec = process.execPath;
  // 安全要点：token 不能出现在子进程命令行参数里（会被 ps/Task Manager/进程列表等直接看到），
  // 必须只通过环境变量传递（子进程私有环境，不落进程参数表）。
  //
  // spawn 失败诊断：Node 的 child_process.spawn 在目标不可执行/找不到等情况下是
  // **异步** 'error' 事件，不监听会直接漏掉，外层只能看到超时、拿不到真实原因；
  // 这里监听下来供超时时一起报出，并且不再用 `String(lastError)` 这种对着一个
  // DaemonInfo 对象/undefined 取字符串、必然是无意义 "[object Object]" 的写法。
  let spawnError: Error | undefined;
  const child = childProcess.spawn(spawnExec, [
    entrypoint,
    "daemon",
    "--port",
    "0",
    "--state-dir",
    stateDir
  ], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENT_BRIDGE_TOKEN: token }
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();

  const deadline = Date.now() + 5000;
  let lastDaemonInfoSeen: DaemonInfo | undefined;
  while (Date.now() < deadline) {
    await sleep(100);
    if (spawnError) {
      break; // spawn 本身就失败了，没必要继续等满 5 秒
    }
    const info = await readJsonFile<DaemonInfo>(daemonInfoPath(stateDir));
    if (info && socketMatches(info, desiredSocket) && await isHealthy(info)) {
      return info;
    }
    lastDaemonInfoSeen = info;
  }
  const diagnostics = spawnError
    ? `spawn 本身报错: ${spawnError.message}`
    : `spawn 命令: ${spawnExec} ${entrypoint} daemon --port 0 --state-dir ${stateDir}；` +
      `轮询期间最后一次读到的 daemon.json: ${lastDaemonInfoSeen ? JSON.stringify(redactDaemonInfo(lastDaemonInfoSeen)) : "(始终不存在，说明 daemon 子进程从未成功写出这个文件)"}`;
  throw new Error(`bridge daemon 启动超时: ${diagnostics}`);
}

function socketMatches(info: DaemonInfo, desiredSocket: string | undefined): boolean {
  return !desiredSocket || info.weztermUnixSocket === desiredSocket;
}

/**
 * 诊断信息里绝不能直接 JSON.stringify 整个 DaemonInfo——它带着 token 字段
 * （types.ts 里明确定义），这条诊断信息最终会被外层错误信息打印到 stderr/
 * 抛出给调用方，token 就这样明文泄露出去了。这里显式列出允许暴露的非敏感字段
 * 白名单，不靠"字段名里有没有 token/secret 这种后缀"去猜——白名单本身就是
 * DaemonInfo 类型的子集，加新字段时如果忘了在这里显式加，TS 也不会报错，
 * 但至少不会意外泄露没被显式加进来的新字段。
 */
function redactDaemonInfo(info: DaemonInfo): Pick<DaemonInfo, "port" | "pid" | "startedAt" | "weztermUnixSocket"> {
  return {
    port: info.port,
    pid: info.pid,
    startedAt: info.startedAt,
    weztermUnixSocket: info.weztermUnixSocket
  };
}

async function isHealthy(info: DaemonInfo): Promise<boolean> {
  try {
    await new BridgeClient(info).health();
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
