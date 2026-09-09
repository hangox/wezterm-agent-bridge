// 假的 claude 外部可执行文件的实际记录逻辑（跨平台共用，被 claude / claude.cmd
// 这两个平台专属的极薄 shim 调用）：记录"真的被调用了"这件事本身、传进来的参数、
// 以及调用发生时能看到的关键环境变量快照，写到 MOCK_CLAUDE_RECORD_FILE 指定的
// JSON 文件里，供 Node 测试编排脚本读取断言。不做任何真实 AI 调用。
import fs from "node:fs";

const record = {
  called: true,
  args: process.argv.slice(2),
  env: {
    BASH_ENV: process.env.BASH_ENV ?? null,
    AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK: process.env.AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK ?? null,
    AGENT_BRIDGE_IT2_CMD_PATH: process.env.AGENT_BRIDGE_IT2_CMD_PATH ?? null,
    AGENT_BRIDGE_ORIGINAL_BASH_ENV: process.env.AGENT_BRIDGE_ORIGINAL_BASH_ENV ?? null,
    AGENT_BRIDGE_IN_PROVIDER: process.env.AGENT_BRIDGE_IN_PROVIDER ?? null,
    AGENT_BRIDGE_PARTIAL_MARKER: process.env.AGENT_BRIDGE_PARTIAL_MARKER ?? null
  }
};

const target = process.env.MOCK_CLAUDE_RECORD_FILE;
if (!target) {
  console.error("mock-claude: 缺少 MOCK_CLAUDE_RECORD_FILE 环境变量");
  process.exit(3);
}
fs.writeFileSync(target, JSON.stringify(record));
process.stdout.write("mock-claude-invoked\n");
