/**
 * 将 Claude Code 生成的 POSIX spawn 命令转译为 PowerShell 7 语法。
 *
 * Claude Code 固定生成的格式：
 *   cd <cwd> && env KEY1=VAL1 KEY2=VAL2 ... <binary> <arg1> <arg2> ...
 *
 * 转译目标（PowerShell 7）：
 *   Set-Location <cwd>; <静默从临时文件加载全部 env 并 Remove-Item>; & <binary> <arg1> <arg2> ...
 *
 * 所有 KEY=VAL 一律不内联到返回的命令字符串里，全部走受保护的临时文件通道——
 * 这条返回值会被 wezterm send-text 真实"打印"进 pane（出现在 scrollback/截图里），
 * 内联任何一个变量值都等于把它明文暴露出去，所以不区分"敏感/非敏感"，全部保护。
 *
 * 边界（重要）：这只保护"能被识别出来的 env 赋值形状"——固定的
 * "cd X && env K=V ... binary" 形态会被安全转译；识别出"像是带 env 赋值但不是
 * 这个固定形态"（比如没有 cd 前缀的裸 "env K=V binary"、空白不标准的变体）会被
 * **拒绝**而不是原样转发；两者都不匹配、完全没有可识别 env 赋值迹象的命令才会
 * 原样转发。这不是通用的命令脱敏器——秘密如果以其它形式混进命令里（比如直接写进
 * 某个 --flag=xxx 参数值），这里识别不出来，不在保护范围内。见
 * tryTranslatePosixSpawnToPowershell 和 looksLikeItCarriesEnvAssignment 的详细注释。
 *
 * 仅在 Windows 上调用（由调用方判断 process.platform === 'win32'）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 之前这里用变量名后缀（_TOKEN/_SECRET/...）猜哪些变量"看起来像密钥"，只有命中的
 * 才走保护通道、其余内联可见。这个思路本身就不可靠：真实凭据变量名五花八门
 * （AWS_SECRET_ACCESS_KEY 结尾是 _KEY 不是 _SECRET、AWS_BEARER_TOKEN_BEDROCK 结尾是
 * _BEDROCK 不是 _TOKEN、OTEL_EXPORTER_OTLP_HEADERS 结尾是 _HEADERS 但常携带认证
 * header），任何后缀白名单都会漏。与其维护一份必然不完整的名单、然后对外宣称"敏感
 * 变量已隐藏"（实际有漏网之鱼），现在改成更简单也更可证明安全的做法：
 * **只要这条命令带有 env 赋值，全部 KEY=VALUE 都走临时文件保护通道，一个都不内联
 * 到可见命令文本里** ——不再需要判断"这个变量是不是敏感"，因为压根不给任何一个
 * 变量值出现在 pane 可见文本里的机会。见 doTranslate 里 `envVars.length > 0` 分支。
 */

export interface SecretEnvWriter {
  /** 把敏感 KV 写入一个仅当前用户可读的临时文件，返回该文件路径。 */
  write(vars: Array<{ key: string; value: string }>): string;
}

/**
 * 粗略判断一条命令"看起来带 env 赋值"——不要求匹配 Claude Code 那个固定 spawn
 * 格式，只是启发式扫两种常见形状：
 *   1. 命令里任意位置出现独立的 "env KEY=" 单词（前面是行首或 空白/;/&/| 分隔符），
 *      覆盖 "env TOKEN=xxx binary"（没有 cd 前缀）、"foo && env TOKEN=xxx binary"
 *      这类变体，也允许 env 和 KEY 之间有多个空白/tab（`\s+`），覆盖"格式对但
 *      空白不标准"的情况。
 *   2. 命令开头就是裸的 "KEY=VALUE"（POSIX 内联环境变量赋值简写，不带 env 关键字），
 *      例如 "TOKEN=xxx /bin/binary"。
 * 命中这两种之一、但又不满足下面 tryTranslatePosixSpawnToPowershell 里那个严格的
 * "cd X && env ..." 语法时，说明"这条命令大概率带敏感 env 赋值，但不是我们支持
 * 转译的那个具体变体"——这种情况必须拒绝，不能因为"没匹配上固定语法"就当成
 * "没有 env、可以安全原样转发"，那是两件不同的事。
 */
function looksLikeItCarriesEnvAssignment(cmd: string): boolean {
  if (/(^|[\s;&|])env\s+[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) {
    return true;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*=\S/.test(cmd.trim());
}

/**
 * 尝试将 POSIX spawn 命令转译为 PowerShell。三种结果：
 * - 返回 PowerShell 命令：识别为 Claude Code 固定的 "cd X && env ..." spawn 格式，
 *   且解析成功，所有 env 赋值都已路由到保护通道。
 * - 抛错：识别出"看起来带 env 赋值"（见 looksLikeItCarriesEnvAssignment），但要么
 *   不满足固定语法（比如没有 cd 前缀、分隔符不标准），要么满足粗筛但严格按位置
 *   解析失败——这两种都不允许"猜一个结果凑合发出去"，必须拒绝。
 * - 返回 null：**完全没有**识别出 env 赋值迹象的命令，原样转发。
 *
 * 重要边界（不要读成"更强的保证"）：这个函数只覆盖"能被我们的启发式识别出来的
 * env 赋值形状"，不是通用的命令脱敏器/秘密扫描器——一条手工敲的、既不含
 * "env KEY=" 也不是"KEY=VALUE"开头、但确实通过其它方式（比如把 token 直接写进
 * 某个 --flag=xxx 参数里）携带了秘密的命令，这里识别不出来，会原样透传。
 * 这里提供的是"识别出的自动 spawn env 注入路径不泄露"，不是"任意手工命令都会被
 * 脱敏"——README 需要同样明确写这一点，不能让用户以为这是通用防泄露墙。
 *
 * 安全边界（2026-09 收紧）：以前解析失败时会退回"把原始命令整段塞进
 * `bash -l -c '<原样>'` 再发出去"的兜底——如果原始命令带 token 之类的
 * env 赋值，这条兜底会把它们原封不动地重新打进会被 wezterm send-text
 * 真实"打印"到 pane（进而进 scrollback/截图）的文本里。现在改成：一旦
 * 识别出带 env 赋值迹象，后续只有"成功保护"和"拒绝"两种结果，没有"退回
 * 明文兜底"这个选项。调用方（daemon.ts /session/run）必须把这里抛出的
 * 错误当作请求失败处理，不能吞掉后继续 sendText 原始命令。
 *
 * @param secretWriter 可选依赖注入，默认使用真实文件系统（0600 临时文件）；
 *   单测用桩实现验证"敏感变量不进入可见命令文本"，不做真实 I/O。
 */
export function tryTranslatePosixSpawnToPowershell(
  cmd: string,
  secretWriter: SecretEnvWriter = defaultSecretEnvWriter
): string | null {
  const isFixedShape = cmd.startsWith("cd ") && cmd.includes(" && env ");
  if (isFixedShape) {
    // 命中固定形态之后，doTranslate 的任何解析失败都直接向上抛，不吞、不兜底、不猜测回退。
    return doTranslate(cmd, secretWriter);
  }
  if (looksLikeItCarriesEnvAssignment(cmd)) {
    // 识别出"像是带 env 赋值"但不是我们支持转译的固定形态——例如没有 cd 前缀的
    // 裸 "env KEY=VAL binary"、connector 处空白不标准的变体、或者裸 "KEY=VALUE" 前缀。
    // 我们没有为这些变体实现安全转译，拒绝而不是猜测性地原样发出去。
    throw new Error(
      "检测到疑似 env 赋值格式，但不是受支持的自动 spawn 固定形态（cd <cwd> && env " +
        "KEY=VAL ... <binary> ...）。为避免可能把明文 env 值发到可见 pane，拒绝这次请求，" +
        "不会原样转发。"
    );
  }
  // 完全没有识别出 env 赋值迹象，原样转发——这不是"证明这条命令不含秘密"，
  // 只是"我们的启发式没识别出来"，见上面函数注释里的边界说明。
  return null;
}

function doTranslate(cmd: string, secretWriter: SecretEnvWriter): string {
  let pos = 3; // 跳过 "cd "

  // 1. 解析 cwd（保留 raw 用于 Set-Location）
  const cwdToken = parseToken(cmd, pos);
  pos = cwdToken.end;

  // 2. 期望 " && env "
  const connector = " && env ";
  if (!cmd.startsWith(connector, pos)) {
    throw new Error(`期望 "${connector}" at pos ${pos}`);
  }
  pos += connector.length;

  // 3. 循环吃 KEY=VAL token
  const envVars: Array<{ key: string; value: string }> = [];
  while (pos < cmd.length) {
    // skip spaces
    while (pos < cmd.length && cmd[pos] === " ") pos++;
    if (pos >= cmd.length) break;

    // 尝试匹配 KEY=（KEY 匹配标识符规则）
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(cmd.slice(pos));
    if (!keyMatch) break; // 首个非 KEY=VAL token → binary

    const key = keyMatch[1];
    pos += key.length + 1; // 跳过 "KEY="

    // 解析 VAL（可能是单引号字符串或无空格序列）
    const valToken = parseToken(cmd, pos);
    envVars.push({ key, value: valToken.value });
    pos = valToken.end;
  }

  // 4. 剩余是 binary + args（保留原始格式，含引号）
  while (pos < cmd.length && cmd[pos] === " ") pos++;
  const binaryAndArgs = cmd.slice(pos).trim();
  if (!binaryAndArgs) {
    throw new Error("缺少 binary");
  }

  // 5. 拼 PowerShell 命令 —— 全部 env 赋值都走临时文件保护通道，一个都不内联到
  //    这条会被 wezterm send-text 真实"打印"到 pane（进而进 scrollback/截图）的
  //    命令文本里。不区分"敏感/非敏感"：这是刻意的——变量名启发式必然有漏网之鱼
  //    （见上面注释），"全部都保护"才是可证明的安全范围，而不是"我们尽量猜"。
  const parts: string[] = [`Set-Location ${cwdToken.raw}`];
  if (envVars.length > 0) {
    const secretFile = secretWriter.write(envVars);
    // 静默读取 + 逐项 Set-Item，全程不 Write-Host/echo 任何值；读完立即删除临时文件。
    parts.push(
      `$__wzab_secret = Get-Content -Raw '${secretFile}' | ConvertFrom-Json`,
      `$__wzab_secret.PSObject.Properties | ForEach-Object { Set-Item -Path "Env:$($_.Name)" -Value $_.Value }`,
      `Remove-Item '${secretFile}' -Force -ErrorAction SilentlyContinue`
    );
  }
  parts.push(`& ${binaryAndArgs}`);

  return parts.join("; ");
}

/**
 * 默认的敏感变量写盘实现：写到 AGENT_BRIDGE_STATE_DIR（未设置则退回系统临时目录）
 * 下的随机文件名，POSIX 上 0600（仅 owner 可读写）；Windows 无对等 mode 位，
 * 但落在每用户私有的 %LOCALAPPDATA%/%TEMP% 下。读取方（PowerShell 那端）读完即删，
 * 这里只负责创建，不负责等待删除——即便 PowerShell 侧异常退出没删成，文件本身
 * 也只在本地、仅当前用户可读的目录里短暂存在，不是长期留存的秘密。
 */
const defaultSecretEnvWriter: SecretEnvWriter = {
  write(vars) {
    const dir = process.env.AGENT_BRIDGE_STATE_DIR ?? os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `wzab-secret-${crypto.randomBytes(8).toString("hex")}.json`);
    const payload: Record<string, string> = {};
    for (const { key, value } of vars) payload[key] = value;
    fs.writeFileSync(file, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    return file;
  }
};

/**
 * 解析一个 token：单引号字符串（'' 是 ' 转义）或无空格序列。
 * 跳过前导空格。
 * 返回 { value: 解码值, raw: 原始字符串（含引号）, end: 解析结束位置 }
 */
function parseToken(s: string, pos: number): { value: string; raw: string; end: number } {
  while (pos < s.length && s[pos] === " ") pos++;

  if (s[pos] === "'") {
    let raw = "'";
    let value = "";
    pos++;
    while (pos < s.length) {
      if (s[pos] === "'" && s[pos + 1] === "'") {
        // '' → 转义的单引号
        raw += "''";
        value += "'";
        pos += 2;
      } else if (s[pos] === "'") {
        raw += "'";
        pos++;
        break;
      } else {
        raw += s[pos];
        value += s[pos];
        pos++;
      }
    }
    return { value, raw, end: pos };
  }

  // 无引号：读到空格
  let raw = "";
  let value = "";
  while (pos < s.length && s[pos] !== " ") {
    raw += s[pos];
    value += s[pos];
    pos++;
  }
  return { value, raw, end: pos };
}
