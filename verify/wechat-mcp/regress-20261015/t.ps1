# 单工具回归调用封装：.\t.ps1 <exe别名> <tool> [参数 JSON 或 @文件] [-Label 说明]
# 画像目录固定隔离到 %TEMP%\lumii-regress-20261015\distill，不碰真实 ~/.lumii/wechat-distill。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Tool,
  [string]$ArgsJson = '{}',
  [string]$Label = '',
  [int]$Timeout = 240
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
$py = "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe"
$runner = Join-Path $PSScriptRoot 'regress_one.py'
$distill = "LUMII_WECHAT_DISTILL=$env:TEMP\lumii-regress-20261015\distill"
$argv = @('-u', $runner, '--exe', $Exe, '--env', $distill, '--timeout', "$Timeout")
if ($Label) { $argv += @('--label', $Label) }
if ($ArgsJson.StartsWith('@') -and -not [IO.Path]::IsPathRooted($ArgsJson.Substring(1))) {
  $ArgsJson = '@' + (Join-Path (Join-Path $PSScriptRoot 'args') $ArgsJson.Substring(1))
}
& $py @argv $Tool $ArgsJson
