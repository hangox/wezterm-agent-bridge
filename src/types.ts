export type SessionState = "STARTING" | "READY" | "CLOSED";

export interface BridgeSession {
  id: string;
  paneId: string;
  provider?: string;
  providerSessionId?: string;
  cwd?: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
}

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  weztermUnixSocket?: string;
}

export interface BridgeConfig {
  stateDir: string;
  token: string;
}
