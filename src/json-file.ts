import fs from "node:fs";
import path from "node:path";

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeJsonFile(file: string, value: unknown, options?: { secret?: boolean }): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // secret: true 用于包含 token 等敏感字段的文件（如 daemon.json）——
  // POSIX 上收紧到仅 owner 可读写（0600），防止同机其它本地用户读到 bridge 认证 token。
  // Windows 没有对等的 POSIX mode 位概念（依赖 ACL），这里的 mode 在 win32 上会被忽略，
  // 但 state 目录默认落在 %LOCALAPPDATA% 下，本身就是当前用户私有目录。
  const mode = options?.secret ? 0o600 : 0o644;
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  if (options?.secret && process.platform !== "win32") {
    await fs.promises.chmod(tmp, 0o600);
  }
  await fs.promises.rename(tmp, file);
}
