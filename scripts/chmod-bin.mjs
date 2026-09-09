// 跨平台给 dist/index.js 加可执行位。
// shell 里的 `chmod +x` 在 Windows（cmd.exe / PowerShell 都没有内置 chmod）上会直接失败，
// 导致 `npm run build` 在 Windows 上根本跑不完——这里改用 Node 自己的 fs.chmod，
// POSIX 上真正加执行位，Windows 上 chmod 是 no-op（Windows 没有对等的执行位概念，
// bin 是靠文件关联 .js → node 解释器运行，不需要这个位）。
import fs from "node:fs";

const target = new URL("../dist/index.js", import.meta.url);

if (process.platform !== "win32") {
  try {
    fs.chmodSync(target, 0o755);
  } catch (error) {
    // dist/index.js 理论上刚被 tsc 生成，不应该不存在；容错但不吞掉真实错误信息。
    console.error(`chmod-bin: 加执行位失败: ${String(error)}`);
    process.exitCode = 1;
  }
}
