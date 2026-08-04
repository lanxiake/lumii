# MtBot Windows 客户端一键打包脚本
#
# 用法:
#   .\scripts\build.ps1                      # 默认: 清理 + 构建 + 打包 NSIS x64
#   .\scripts\build.ps1 -SkipClean           # 跳过清理（增量构建）
#   .\scripts\build.ps1 -Target portable     # 打包便携版
#   .\scripts\build.ps1 -Target zip          # 打包 ZIP
#   .\scripts\build.ps1 -Arch ia32           # 打包 32 位
#   .\scripts\build.ps1 -Arch both           # 同时打包 x64 和 ia32
#   .\scripts\build.ps1 -All                 # 打包所有格式（nsis + portable + zip）

param(
    [switch]$SkipClean,
    [ValidateSet('nsis', 'portable', 'zip')]
    [string]$Target = 'nsis',
    [ValidateSet('x64', 'ia32', 'both')]
    [string]$Arch = 'x64',
    [switch]$All
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsRoot = Split-Path -Parent $ScriptDir
$ReleaseDir  = Join-Path $WindowsRoot 'release'
$OutDir      = Join-Path $WindowsRoot 'out'

# 国内镜像加速
$env:ELECTRON_MIRROR                    = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR   = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# ── 颜色输出工具 ──────────────────────────────────────────────

function Write-Step([string]$Msg) {
    Write-Host "`n[打包] " -ForegroundColor Cyan -NoNewline
    Write-Host $Msg
}

function Write-Ok([string]$Msg) {
    Write-Host '  ✓ ' -ForegroundColor Green -NoNewline
    Write-Host $Msg
}

function Write-Warn([string]$Msg) {
    Write-Host '  ⚠ ' -ForegroundColor Yellow -NoNewline
    Write-Host $Msg
}

function Write-Fail([string]$Msg) {
    Write-Host '  ✗ ' -ForegroundColor Red -NoNewline
    Write-Host $Msg
}

function Invoke-Step([string]$Cmd) {
    Write-Host "  `$ $Cmd" -ForegroundColor DarkGray
    Invoke-Expression $Cmd
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "命令失败 (exit $LASTEXITCODE): $Cmd"
    }
}

# ── 步骤 ──────────────────────────────────────────────────────

function Step-Clean {
    Write-Step '步骤 1/4: 清理旧构建产物'
    foreach ($dir in @($OutDir, $ReleaseDir)) {
        if (Test-Path $dir) {
            Remove-Item $dir -Recurse -Force
            Write-Ok "已清理 $(Split-Path -Leaf $dir)/"
        }
    }
    $CacheDir = Join-Path $WindowsRoot 'node_modules\.cache'
    if (Test-Path $CacheDir) {
        Remove-Item $CacheDir -Recurse -Force
        Write-Ok '已清理 node_modules/.cache/'
    }
    Write-Ok '清理完成'
}

function Step-Verify {
    Write-Step '步骤 2/4: 验证必要文件'
    $required = @(
        @{ Path = 'config\server-config.json'; Desc = '服务器配置' },
        @{ Path = 'assets\icon.ico';           Desc = '应用图标'   },
        @{ Path = 'electron-builder.json';     Desc = 'builder 配置' },
        @{ Path = 'build\license.txt';         Desc = '许可证文件' },
        @{ Path = 'build\installer.nsh';       Desc = 'NSIS 脚本'  }
    )
    $allGood = $true
    foreach ($item in $required) {
        $full = Join-Path $WindowsRoot $item.Path
        if (Test-Path $full) {
            Write-Ok "$($item.Desc): $($item.Path)"
        } else {
            Write-Warn "缺少 $($item.Desc): $($item.Path)"
            $allGood = $false
        }
    }
    $configPath = Join-Path $WindowsRoot 'config\server-config.json'
    if (Test-Path $configPath) {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        Write-Host "     API URL:     $($cfg.apiUrl)" -ForegroundColor DarkGray
        Write-Host "     Gateway URL: $($cfg.gatewayUrl)" -ForegroundColor DarkGray
    }
    if (-not $allGood) { Write-Warn '部分文件缺失，打包可能失败' }
    Write-Ok '验证完成'
}

function Step-Build {
    Write-Step '步骤 3/4: 构建项目 (electron-vite build)'
    Push-Location $WindowsRoot
    try { Invoke-Step 'npx electron-vite build' }
    finally { Pop-Location }
    Write-Ok '构建完成'
}

function Step-Package {
    Write-Step '步骤 4/4: 打包安装程序'

    Push-Location $WindowsRoot
    try {
        if ($All) {
            # 打包全部目标（使用 electron-builder.json 中定义的 win.target）
            Write-Host '  → 打包全部格式 (nsis + portable + zip) ...' -ForegroundColor DarkGray
            Invoke-Step 'npx electron-builder --win --config electron-builder.json'
        } else {
            $archList = if ($Arch -eq 'both') { @('x64', 'ia32') } else { @($Arch) }
            foreach ($a in $archList) {
                Write-Host "  → 打包 $Target ($a) ..." -ForegroundColor DarkGray
                Invoke-Step "npx electron-builder --win $Target --$a --config electron-builder.json"
            }
        }
    } finally {
        Pop-Location
    }

    # 列出产物
    Write-Host ''
    Write-Host '  打包产物:' -ForegroundColor Cyan
    if (Test-Path $ReleaseDir) {
        $files = Get-ChildItem $ReleaseDir -File |
                 Where-Object { $_.Extension -in @('.exe', '.zip', '.7z') } |
                 Sort-Object Name
        if ($files.Count -eq 0) {
            Write-Warn '未发现安装包文件'
        } else {
            foreach ($f in $files) {
                $sizeMB = [math]::Round($f.Length / 1MB, 1)
                Write-Ok "$($f.Name)  ($sizeMB MB)"
            }
        }
    }
    Write-Ok '打包完成'
}

# ── 主流程 ────────────────────────────────────────────────────

$startTime = Get-Date

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  MtBot Windows 客户端打包工具'          -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
if ($All) {
    Write-Host '  目标: 全部 (nsis + portable + zip)'
} else {
    Write-Host "  目标: $Target  架构: $Arch"
}
Write-Host "  清理: $(if ($SkipClean) { '跳过' } else { '是' })"
Write-Host '========================================' -ForegroundColor Cyan

try {
    if (-not $SkipClean) { Step-Clean }
    Step-Verify
    Step-Build
    Step-Package

    $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Green
    Write-Host "  ✓ 全部完成！耗时 ${elapsed}s"         -ForegroundColor Green
    Write-Host "  输出目录: $ReleaseDir"
    Write-Host '========================================' -ForegroundColor Green
    Write-Host ''
} catch {
    Write-Host ''
    Write-Fail "打包失败: $_"
    exit 1
}
