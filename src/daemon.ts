import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Registry } from "./registry.js";
import { WeztermCli } from "./wezterm-cli.js";
import { tryTranslatePosixSpawnToPowershell, type SecretEnvWriter } from "./posix-to-powershell.js";
import { readRequestJson, writeJson, writeText, HttpError } from "./http-json.js";
import { daemonInfoPath } from "./paths.js";
import { writeJsonFile } from "./json-file.js";
import type { DaemonInfo } from "./types.js";

interface DaemonOptions {
  stateDir: string;
  token: string;
  port: number;
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  await fs.promises.mkdir(options.stateDir, { recursive: true });
  const registry = new Registry(options.stateDir);
  await registry.load();
  const wezterm = new WeztermCli();

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) {
        throw new HttpError("缺少 URL", 400);
      }
      const url = new URL(request.url, "http://127.0.0.1");
      // /health 也必须鉴权：跳过鉴权的话，任何本机进程随便打这个端口都能拿到
      // "200 + {ok:true}"，没法证明对方真的是"这个 state 对应的那个 bridge
      // daemon"——只监听在同一个随机端口这件事本身不构成身份证明（另一个完全
      // 无关的本地服务凑巧也在类似端口范围监听、返回类似结构的 JSON 完全可能）。
      assertToken(request, options.token);

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { ok: true, pid: process.pid });
        return;
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        writeJson(response, 200, { sessions: registry.list() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/session/register") {
        const body = await readRequestJson<{ paneId: string; provider?: string; cwd?: string }>(request);
        if (!body.paneId) {
          throw new HttpError("缺少 paneId", 400);
        }
        const session = registry.upsert({
          paneId: body.paneId,
          provider: body.provider,
          cwd: body.cwd,
          state: "READY"
        });
        await registry.save();
        writeJson(response, 200, { session });
        return;
      }

      if (request.method === "POST" && url.pathname === "/session/split") {
        const body = await readRequestJson<{
          source?: string;
          vertical?: boolean;
          cwd?: string;
        }>(request);
        // 优先用指定 source 的 wezterm pane-id；否则找第一个 READY session
        const sourcePaneId = resolveSourcePaneId(registry, body.source);
        const paneId = await wezterm.splitPane({
          sourcePaneId,
          vertical: body.vertical,
          cwd: body.cwd
        });
        // split 出来的新 pane 总生成新 UUID（新 pane = 新 wezterm pane-id，不会重复）
        const session = registry.upsert({
          paneId,
          cwd: body.cwd,
          state: "READY"
        });
        await registry.save();
        writeJson(response, 200, { session });
        return;
      }

      if (request.method === "POST" && url.pathname === "/session/run") {
        const body = await readRequestJson<{ session?: string; command: string }>(request);
        if (!body.command) {
          throw new HttpError("缺少 command", 400);
        }
        const paneId = requirePaneId(registry, body.session);
        // Windows: 把 Claude Code 的 POSIX spawn 命令转译为 PowerShell 语法
        // Mac/Linux: 原样发送（shell 本身就是 POSIX bash/zsh）
        let command = body.command;
        if (process.platform === "win32") {
          // tryTranslatePosixSpawnToPowershell 在"命令带 env 赋值但解析失败"时会直接
          // throw（不再退回明文兜底，见该函数注释）。这里故意不 catch——让它冒泡到
          // 外层请求 handler 的 try/catch，变成一次失败的 HTTP 响应；下面的
          // wezterm.sendText 绝不会在这种情况下被调用到，原始命令（可能含 token）
          // 也就绝不会被发到可见 pane 里。
          const translated = tryTranslatePosixSpawnToPowershell(command, makeSecretEnvWriter(options.stateDir));
          if (translated !== null) {
            // PowerShell 需要 \r（CR）才能触发执行；\n（LF）单独发会进入多行续行 >>
            command = translated.trimEnd() + "\r\n";
          }
        }
        await wezterm.sendText(paneId, command.endsWith("\n") ? command : `${command}\n`);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/session/read") {
        const body = await readRequestJson<{ session?: string; lines?: number }>(request);
        const paneId = requirePaneId(registry, body.session);
        const lines = clampLines(body.lines ?? 50);
        const text = await wezterm.getText(paneId, lines);
        writeText(response, 200, text);
        return;
      }

      if (request.method === "POST" && url.pathname === "/session/focus") {
        const body = await readRequestJson<{ session?: string }>(request);
        const paneId = requirePaneId(registry, body.session);
        await wezterm.activatePane(paneId);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/session/close") {
        const body = await readRequestJson<{ session?: string }>(request);
        if (!body.session) {
          writeJson(response, 200, { ok: true });
          return;
        }
        const paneId = registry.getPaneId(body.session);
        if (!paneId) {
          // session 不存在或已关闭，视为成功（幂等）
          writeJson(response, 200, { ok: true });
          return;
        }
        try {
          await wezterm.killPane(paneId);
        } finally {
          registry.close(body.session);
          await registry.save();
        }
        writeJson(response, 200, { ok: true });
        return;
      }

      writeJson(response, 404, { error: `未知接口: ${request.method} ${url.pathname}` });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      writeJson(response, statusCode, { error: (error as Error).message });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("daemon 监听地址异常");
  }
  const info: DaemonInfo = {
    port: address.port,
    token: options.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    weztermUnixSocket: process.env.WEZTERM_UNIX_SOCKET
  };
  await writeJsonFile(daemonInfoPath(options.stateDir), info, { secret: true });
}

/**
 * 敏感环境变量（token/secret/...）临时文件写在 daemon 自己的 stateDir 下，
 * 而不是依赖进程环境里可能没有的 AGENT_BRIDGE_STATE_DIR——daemon 明确知道自己的
 * stateDir（来自 --state-dir/options.stateDir），直接用它更可靠。
 */
function makeSecretEnvWriter(stateDir: string): SecretEnvWriter {
  return {
    write(vars) {
      const dir = path.join(stateDir, "secrets");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `wzab-secret-${crypto.randomBytes(8).toString("hex")}.json`);
      const payload: Record<string, string> = {};
      for (const { key, value } of vars) payload[key] = value;
      fs.writeFileSync(file, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      return file;
    }
  };
}

function assertToken(request: http.IncomingMessage, token: string): void {
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (actual !== token) {
    throw new HttpError("token 校验失败", 401);
  }
}

/**
 * 根据 session UUID 查找对应的 wezterm pane-id。
 * source 未指定时，退回到第一个 READY session。
 */
function resolveSourcePaneId(registry: Registry, source: string | undefined): string {
  if (source) {
    const paneId = registry.getPaneId(source);
    if (!paneId) {
      throw new HttpError(`source session 不存在: ${source}`, 404);
    }
    return paneId;
  }
  const session = registry.firstReady();
  if (!session) {
    throw new HttpError("没有可用 source session", 404);
  }
  return session.paneId;
}

/**
 * 根据 session UUID 查找 pane-id（必须存在）。
 * session 未指定时，退回到第一个 READY session。
 */
function requirePaneId(registry: Registry, sessionId: string | undefined): string {
  if (sessionId) {
    const paneId = registry.getPaneId(sessionId);
    if (!paneId) {
      throw new HttpError(`session 不存在: ${sessionId}`, 404);
    }
    return paneId;
  }
  const session = registry.firstReady();
  if (!session) {
    throw new HttpError("没有可用 session", 404);
  }
  return session.paneId;
}

function clampLines(lines: number): number {
  if (!Number.isFinite(lines)) {
    return 50;
  }
  return Math.max(1, Math.min(500, Math.trunc(lines)));
}
