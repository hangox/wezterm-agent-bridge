import { spawnFile } from "./process.js";

export class WeztermCli {
  constructor(private readonly bin = process.env.AGENT_BRIDGE_WEZTERM_BIN ?? "wezterm") {}

  async listJson(): Promise<unknown> {
    const output = await this.run(["cli", "list", "--format", "json"]);
    return JSON.parse(output || "[]");
  }

  async splitPane(input: {
    sourcePaneId: string;
    vertical?: boolean;
    cwd?: string;
  }): Promise<string> {
    const args = ["cli", "split-pane", "--pane-id", input.sourcePaneId];
    args.push(input.vertical ? "--right" : "--bottom");
    if (input.cwd) {
      args.push("--cwd", input.cwd);
    }
    return (await this.run(args)).trim();
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await this.run(["cli", "send-text", "--pane-id", paneId, "--no-paste", text]);
  }

  async getText(paneId: string, lines: number): Promise<string> {
    return this.run(["cli", "get-text", "--pane-id", paneId, "--start-line", `-${lines}`]);
  }

  async activatePane(paneId: string): Promise<void> {
    await this.run(["cli", "activate-pane", "--pane-id", paneId]);
  }

  async killPane(paneId: string): Promise<void> {
    await this.run(["cli", "kill-pane", "--pane-id", paneId]);
  }

  private async run(args: string[]): Promise<string> {
    return spawnFile(this.bin, args);
  }
}
