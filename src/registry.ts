import crypto from "node:crypto";
import { registryPath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import type { BridgeSession } from "./types.js";

export class Registry {
  private sessions = new Map<string, BridgeSession>();
  // 反向索引：wezterm pane-id → 会话 UUID（用于幂等注册同一 pane）
  private paneIdToSessionId = new Map<string, string>();

  constructor(private readonly stateDir: string) {}

  async load(): Promise<void> {
    const data = await readJsonFile<BridgeSession[]>(registryPath(this.stateDir));
    this.sessions.clear();
    this.paneIdToSessionId.clear();
    for (const session of data ?? []) {
      if (session.state !== "CLOSED") {
        // 迁移旧格式 "wezterm:<pane-id>" → 真正 UUID
        const id = session.id.startsWith("wezterm:") ? crypto.randomUUID() : session.id;
        const migrated: BridgeSession = id === session.id ? session : { ...session, id };
        this.sessions.set(id, migrated);
        this.paneIdToSessionId.set(session.paneId, id);
      }
    }
  }

  list(): BridgeSession[] {
    return [...this.sessions.values()].filter((session) => session.state !== "CLOSED");
  }

  get(id: string): BridgeSession | undefined {
    return this.sessions.get(id);
  }

  /** 返回 WezTerm pane-id，用于调用 wezterm cli。找不到时返回 undefined。 */
  getPaneId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.paneId;
  }

  /** 返回第一个 READY 状态的 session，无则返回 undefined。 */
  firstReady(): BridgeSession | undefined {
    return [...this.sessions.values()].find((s) => s.state === "READY");
  }

  upsert(input: {
    paneId: string;
    provider?: string;
    cwd?: string;
    state?: BridgeSession["state"];
    providerSessionId?: string;
  }): BridgeSession {
    // 幂等：同一 wezterm pane 复用已有 UUID，避免 ITERM_SESSION_ID 变化
    const existingId = this.paneIdToSessionId.get(input.paneId);
    const id = existingId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    const session: BridgeSession = {
      id,
      paneId: input.paneId,
      provider: input.provider ?? existing?.provider,
      providerSessionId: input.providerSessionId ?? existing?.providerSessionId,
      cwd: input.cwd ?? existing?.cwd,
      state: input.state ?? existing?.state ?? "READY",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.sessions.set(id, session);
    this.paneIdToSessionId.set(input.paneId, id);
    return session;
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    this.sessions.set(id, {
      ...session,
      state: "CLOSED",
      updatedAt: new Date().toISOString()
    });
    this.paneIdToSessionId.delete(session.paneId);
  }

  async save(): Promise<void> {
    await writeJsonFile(registryPath(this.stateDir), [...this.sessions.values()]);
  }
}
