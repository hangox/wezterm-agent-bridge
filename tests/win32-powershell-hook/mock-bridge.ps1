# 假的 wezterm-agent-bridge 可执行文件，只处理 `shell-env --provider claude --shell powershell`
# 这一条命令，行为完全由环境变量控制——这样才能在不启动真实 daemon/不需要真实
# WezTerm/不需要真实凭据的情况下，精确构造各种场景（正常注入、失败退出码、
# 部分注入后抛错……）来测试 src/shell.ts 里 powershellProviderWrapper 生成的
# 真实产品包装器代码，而不是重写一份包装器自己测自己。
#
# 控制变量：
#   MOCK_SHELL_ENV_EXIT_CODE          退出码，默认 0
#   MOCK_SHELL_ENV_EMIT_HOOK_VARS     "1" 时额外输出设置 BASH_ENV/
#                                     AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK/
#                                     AGENT_BRIDGE_IT2_CMD_PATH/
#                                     AGENT_BRIDGE_ORIGINAL_BASH_ENV 这四行
#                                     $env:X = 'value'（模拟真实 printShellEnv
#                                     在实验开关打开时的注入内容）
#   MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX  拼进上面四个值里，方便断言区分不同调用
#   MOCK_SHELL_ENV_PARTIAL_THEN_THROW "1" 时先输出一行正常赋值、再输出一行
#                                     `throw '...'`，模拟"部分注入后抛错"
#   MOCK_SHELL_ENV_STDERR             如果设置，原样写到 stderr（用于验证
#                                     stdout/stderr 分离，且不该被当成待注入代码）

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RestArgs
)

if ($env:MOCK_SHELL_ENV_STDERR) {
  [Console]::Error.WriteLine($env:MOCK_SHELL_ENV_STDERR)
}

if ($RestArgs.Count -lt 1 -or $RestArgs[0] -ne "shell-env") {
  [Console]::Error.WriteLine("mock-bridge: 只支持 shell-env 子命令，实际收到: $($RestArgs -join ' ')")
  exit 2
}

$suffix = if ($env:MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX) { $env:MOCK_SHELL_ENV_HOOK_VALUE_SUFFIX } else { "default" }

# 真实 printShellEnv 总会至少输出 AGENT_BRIDGE_PORT/TOKEN/... 这些基线变量，
# 输出永远不会是空字符串——这里也输出一行占位赋值，保持跟真实行为一致，
# 避免 Invoke-Expression 收到空字符串（PowerShell 对此会直接报错，是这个
# mock 该模拟真实场景的问题，不是产品包装器代码的问题）。
Write-Output "`$env:AGENT_BRIDGE_MOCK_BASELINE = '1'"

if ($env:MOCK_SHELL_ENV_EMIT_HOOK_VARS -eq "1") {
  Write-Output "`$env:BASH_ENV = 'C:\mock-hook-$suffix.sh'"
  Write-Output "`$env:AGENT_BRIDGE_EXPERIMENTAL_IT2_BASH_HOOK = '1'"
  Write-Output "`$env:AGENT_BRIDGE_IT2_CMD_PATH = 'C:\mock-it2-$suffix.cmd'"
  Write-Output "`$env:AGENT_BRIDGE_ORIGINAL_BASH_ENV = 'C:\mock-original-bash-env-$suffix.sh'"
}

if ($env:MOCK_SHELL_ENV_PARTIAL_THEN_THROW -eq "1") {
  Write-Output "`$env:AGENT_BRIDGE_PARTIAL_MARKER = 'partial-$suffix'"
  Write-Output "throw '模拟 shell-env 输出的代码里途中出错（部分注入后抛错场景）'"
}

$exitCode = if ($env:MOCK_SHELL_ENV_EXIT_CODE) { [int]$env:MOCK_SHELL_ENV_EXIT_CODE } else { 0 }
exit $exitCode
