import http from "node:http";
import type { DaemonInfo, BridgeSession } from "./types.js";

// 各类请求的默认超时（ms）。ensureDaemon() 的启动轮询整体只给 5 秒 deadline，
// 里面每次 isHealthy() 调用如果没有自己的超时，一次卡住的 TCP 连接/无响应服务端
// 就能让轮询循环远超预期地卡住——health 用短超时，配合频繁轮询；写操作
// （run/split 等可能真的要等 wezterm CLI 子进程跑完）给更宽松但仍然有界的超时，
// 不能是"无限等"。
const HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10000;

export class BridgeClient {
  constructor(private readonly info: DaemonInfo) {}

  /**
   * 健康检查：不只是"能连上、拿到200"，还要求响应体确实是这个 daemon 自己
   * （ok===true 且 pid 跟 daemon.json 里记录的一致）——同一个随机端口只是巧合
   * 被其它本地服务占用、返回一个恰好也是200的JSON，不能被误判成"我们的daemon
   * 健康"。/health 现在也要求鉴权（见 daemon.ts），拿不到200本身就说明不是
   * 同一个token的daemon，走不到这里。
   */
  async health(): Promise<void> {
    const text = await this.requestText("GET", "/health", undefined, HEALTH_TIMEOUT_MS);
    // 只从响应体里类型安全地取 ok/pid 这两个我们自己关心的字段，绝不把整个
    // parsed 对象（不受信任的响应体，理论上可以是任意 JSON）序列化进错误信息——
    // 假冒/被攻破的服务端完全可以在响应体里塞任意内容（比如回显它收到的
    // Authorization header），JSON.stringify(parsed) 会把这些一并泄露到错误信息/
    // 日志里。这里只摘要 ok 和 pid 各自的类型化取值。
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("health 响应不是合法 JSON（不匹配这个 daemon 的身份）");
    }
    const ok = isRecord(parsed) && parsed.ok === true;
    const pid = isRecord(parsed) && typeof parsed.pid === "number" ? parsed.pid : undefined;
    if (!ok || pid !== this.info.pid) {
      throw new Error(`health 响应不匹配这个 daemon 的身份（期望 pid=${this.info.pid}，实际 ok=${ok}, pid=${pid ?? "(非数字或缺失)"}）`);
    }
  }

  async sessions(): Promise<BridgeSession[]> {
    const data = await this.requestJson<{ sessions: BridgeSession[] }>("GET", "/sessions");
    return data.sessions;
  }

  async register(input: { paneId: string; provider?: string; cwd?: string }): Promise<BridgeSession> {
    const data = await this.requestJson<{ session: BridgeSession }>("POST", "/session/register", input);
    return data.session;
  }

  async split(input: { source?: string; vertical?: boolean; cwd?: string }): Promise<BridgeSession> {
    const data = await this.requestJson<{ session: BridgeSession }>("POST", "/session/split", input);
    return data.session;
  }

  async run(input: { session?: string; command: string }): Promise<void> {
    await this.requestJson("POST", "/session/run", input);
  }

  async focus(input: { session?: string }): Promise<void> {
    await this.requestJson("POST", "/session/focus", input);
  }

  async close(input: { session?: string }): Promise<void> {
    await this.requestJson("POST", "/session/close", input);
  }

  async read(input: { session?: string; lines?: number }): Promise<string> {
    return this.requestText("POST", "/session/read", input);
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await this.requestText(method, path, body);
    return JSON.parse(text) as T;
  }

  private requestText(method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      // 硬性总时限：不用 http.request 的 `timeout` option（那只是 socket 层的
      // 空闲超时——服务端只要持续、哪怕极慢地滴几个字节续期，空闲计时器就一直
      // 被重置，永远不会触发；一个恶意/故障的服务端可以用这种"慢滴血"方式让
      // 请求实质上无限期挂起）。这里改用独立的 setTimeout 定时器 + AbortController，
      // 不管中途有没有收到数据，从请求发出那一刻起满 timeoutMs 就强制中止。
      const controller = new AbortController();
      let timedOut = false;
      const deadlineTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const settle = (fn: () => void) => {
        clearTimeout(deadlineTimer);
        fn();
      };
      // 真实测出来的坑：signal 触发 abort 后，Node 的 http 模块自己合成一个
      // `AbortError: The operation was aborted` 扔给 'error' 监听者，不会带上我们
      // 想要的"请求超时"字样（哪怕 controller.abort(customReason) 传了自定义
      // reason，实际拿到的 error 对象文本也不一定包含它）。用上面这个 timedOut
      // 标记，在 reject 时区分"这是我们自己的总时限触发的"还是"真的是别的网络错误"，
      // 保证抛出的错误信息里始终有"超时"字样，调用方/测试能可靠匹配。
      const rejectWithContext = (error: Error) => {
        if (timedOut) {
          reject(new Error(`请求超时（总时限 >${timeoutMs}ms，不是空闲超时）: ${method} ${path}`));
        } else {
          reject(error);
        }
      };

      const request = http.request({
        hostname: "127.0.0.1",
        port: this.info.port,
        path,
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.info.token}`,
          ...(payload ? {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload)
          } : {})
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          settle(() => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((response.statusCode ?? 500) >= 400) {
              reject(new Error(text.trim() || `HTTP ${response.statusCode}`));
            } else {
              resolve(text);
            }
          });
        });
        response.on("error", (error) => settle(() => rejectWithContext(error)));
      });
      request.on("error", (error) => settle(() => rejectWithContext(error)));
      if (payload) {
        request.end(payload);
      } else {
        request.end();
      }
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
