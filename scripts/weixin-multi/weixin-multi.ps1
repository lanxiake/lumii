#requires -Version 5.1
<#
.SYNOPSIS
    Windows 微信 4.x 多开器：关闭单实例互斥体句柄后启动新的 Weixin.exe。

.DESCRIPTION
    微信通过命名互斥体 XWeChat_App_Instance_Identity_Mutex_Name 限制单实例。
    本工具枚举 Weixin.exe 的句柄，找到该互斥体并用 DUPLICATE_CLOSE_SOURCE 关闭，
    然后启动新的实例。不修改任何文件、不注入 DLL；关闭互斥体只影响“能否再开一个”，
    不影响已经运行的实例。

.PARAMETER Count
    要新启动的微信实例数。默认 1（在已有一个的前提下再多开一个）。

.PARAMETER ExePath
    手动指定 Weixin.exe。默认读 HKCU\Software\Tencent\Weixin\InstallPath。

.PARAMETER DataDir
    用 `/d <DataDir>` 启动，让微信把 xwechat_files 建在该目录下（账号数据隔离）。
    不同数据目录的实例不能同时在线，所以会先关闭当前所有微信实例。

.PARAMETER ListOnly
    只列出当前微信进程持有的单实例互斥体，不启动、不关闭。

.PARAMETER SelfTest
    自检：起一个隐藏的 powershell 子进程创建同名互斥体，验证句柄能被找到并关闭。

.PARAMETER Elevate
    先以管理员身份重启。仅当微信本身以管理员权限运行、普通权限拿不到句柄时才需要。

.EXAMPLE
    .\weixin-multi.ps1
    多开一个微信（会自动请求管理员权限）。

.EXAMPLE
    .\weixin-multi.ps1 -Count 2 -ListOnly
    先看看当前有几个互斥体句柄。
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 10)]
    [int]$Count = 1,

    [string]$ExePath,

    [string]$DataDir,

    [switch]$ListOnly,

    [string]$ListFiles,

    [switch]$SelfTest,

    [switch]$Elevate,

    [switch]$PrepareOnly,

    [switch]$AllMutants
)

$ErrorActionPreference = 'Stop'
$MutexNeedle = 'Instance_Identity_Mutex_Name'

# ---------------------------------------------------------------- 原生实现

$NativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WeixinMutex
{
    [StructLayout(LayoutKind.Sequential)]
    private struct HandleEntry
    {
        public IntPtr Object;
        public IntPtr UniqueProcessId;
        public IntPtr HandleValue;
        public uint GrantedAccess;
        public ushort CreatorBackTraceIndex;
        public ushort ObjectTypeIndex;
        public uint HandleAttributes;
        public uint Reserved;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returnLength);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr buffer, int length, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr srcProcess, IntPtr srcHandle, IntPtr dstProcess,
        out IntPtr dstHandle, uint access, bool inherit, uint options);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private const int SystemExtendedHandleInformation = 64;
    private const int ObjectTypeInformation = 2;
    private const int ObjectNameInformation = 1;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
    private const uint ProcessDupHandle = 0x0040;
    private const uint DuplicateSameAccess = 0x0002;
    private const uint DuplicateCloseSource = 0x0001;

    /// <summary>读取 UNICODE_STRING（OBJECT_*_INFORMATION 的第一个字段）。</summary>
    private static string ReadUnicodeString(IntPtr buffer)
    {
        int byteLength = Marshal.ReadInt16(buffer);
        IntPtr stringBuffer = Marshal.ReadIntPtr(buffer, IntPtr.Size);
        if (byteLength <= 0 || stringBuffer == IntPtr.Zero) return null;
        return Marshal.PtrToStringUni(stringBuffer, byteLength / 2);
    }

    private static string QueryObjectString(IntPtr handle, int infoClass)
    {
        int needed = 0;
        NtQueryObject(handle, infoClass, IntPtr.Zero, 0, out needed);
        if (needed <= 0) needed = 4096;
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            int status = NtQueryObject(handle, infoClass, buffer, needed, out needed);
            if (status != 0) return null;
            return ReadUnicodeString(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>关闭名称含 needle 的 Mutant 句柄；dryRun 时只查找。</summary>
    public static string[] CloseMutexes(int[] pids, string needle, bool dryRun)
    {
        return ScanHandles(pids, "Mutant", needle, !dryRun);
    }

    /// <summary>列出指定类型的句柄名（诊断用，不关闭）。</summary>
    public static string[] ListHandles(int[] pids, string typeName, string needle)
    {
        return ScanHandles(pids, typeName, needle, false);
    }

    private static string[] ScanHandles(int[] pids, string targetType, string needle, bool close)
    {
        var names = new List<string>();
        if (pids == null || pids.Length == 0) return names.ToArray();
        var pidSet = new HashSet<int>(pids);

        int length = 1 << 20;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        int returned = 0;
        try
        {
            int status;
            while ((status = NtQuerySystemInformation(SystemExtendedHandleInformation, buffer, length, out returned))
                   == StatusInfoLengthMismatch)
            {
                Marshal.FreeHGlobal(buffer);
                length = returned;
                buffer = Marshal.AllocHGlobal(length);
            }
            if (status != 0)
                throw new InvalidOperationException("NtQuerySystemInformation 失败：0x" + status.ToString("X8"));

            long handleCount = Marshal.ReadIntPtr(buffer).ToInt64();
            IntPtr entry = buffer + IntPtr.Size * 2;
            int entrySize = Marshal.SizeOf(typeof(HandleEntry));

            for (long i = 0; i < handleCount; i++, entry += entrySize)
            {
                HandleEntry item = (HandleEntry)Marshal.PtrToStructure(entry, typeof(HandleEntry));
                int pid = item.UniqueProcessId.ToInt32();
                if (!pidSet.Contains(pid)) continue;
                if (item.HandleValue == IntPtr.Zero || item.HandleValue == new IntPtr(-1)) continue;

                IntPtr process = OpenProcess(ProcessDupHandle, false, pid);
                if (process == IntPtr.Zero) continue;

                IntPtr duplicated;
                bool ok = DuplicateHandle(process, item.HandleValue, GetCurrentProcess(),
                    out duplicated, 0, false, DuplicateSameAccess);
                CloseHandle(process);
                if (!ok || duplicated == IntPtr.Zero) continue;

                try
                {
                    // 先问类型再问名字：直接对所有句柄查名字会在管道/文件句柄上卡住。
                    string typeName = QueryObjectString(duplicated, ObjectTypeInformation);
                    if (typeName == null || typeName != targetType) continue;
                    string objectName = QueryObjectString(duplicated, ObjectNameInformation);
                    if (objectName == null) continue;
                    // needle 为空表示不限（诊断用）
                    if (!string.IsNullOrEmpty(needle) &&
                        objectName.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;

                    names.Add(objectName);
                    if (!close) continue;

                    IntPtr process2 = OpenProcess(ProcessDupHandle, false, pid);
                    if (process2 == IntPtr.Zero) continue;
                    IntPtr closed;
                    if (DuplicateHandle(process2, item.HandleValue, GetCurrentProcess(),
                            out closed, 0, false, DuplicateCloseSource))
                    {
                        CloseHandle(closed);
                    }
                    CloseHandle(process2);
                }
                finally
                {
                    CloseHandle(duplicated);
                }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return names.ToArray();
    }
}
'@

if (-not ('WeixinMutex' -as [type])) {
    Add-Type -TypeDefinition $NativeSource -Language CSharp
}

# ---------------------------------------------------------------- 辅助

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WeixinExe {
    if ($ExePath) {
        if (-not (Test-Path -LiteralPath $ExePath)) { throw "找不到指定的微信：$ExePath" }
        return (Resolve-Path -LiteralPath $ExePath).Path
    }
    $keys = @(
        'HKCU:\Software\Tencent\Weixin',
        'HKLM:\SOFTWARE\Tencent\Weixin',
        'HKLM:\SOFTWARE\WOW6432Node\Tencent\Weixin'
    )
    foreach ($key in $keys) {
        $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if ($item -and $item.InstallPath) {
            $candidate = Join-Path $item.InstallPath 'Weixin.exe'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    throw '读不到微信安装路径。请用 -ExePath 指定 Weixin.exe。'
}

function Get-WeixinProcessIds {
    return @(Get-Process -Name 'Weixin' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

function Request-Elevation {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
    $arguments += @('-Count', $Count, '-Elevate')
    if ($ExePath) { $arguments += @('-ExePath', ('"' + $ExePath + '"')) }
    if ($DataDir) { $arguments += @('-DataDir', ('"' + $DataDir + '"')) }
    if ($ListOnly) { $arguments += '-ListOnly' }
    Write-Host '正在以管理员身份重新启动…' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
}

# ---------------------------------------------------------------- 自检

if ($SelfTest) {
    $mutexName = 'XWeChat_App_Instance_Identity_Mutex_Name'
    Write-Host "自检：在子进程中创建互斥体 $mutexName"
    $script = '$m = New-Object System.Threading.Mutex($false, ''' + $mutexName + '''); Start-Sleep -Seconds 30'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $child = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden `
        -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded)
    try {
        Start-Sleep -Milliseconds 1500
        $names = [WeixinMutex]::CloseMutexes(@($child.Id), $MutexNeedle, $false)
        if ($names.Length -eq 0) {
            Write-Host 'FAIL：没有找到子进程的互斥体句柄（可能需要管理员权限）' -ForegroundColor Red
            exit 1
        }
        Start-Sleep -Milliseconds 200
        $stillAlive = $false
        try {
            $probe = [System.Threading.Mutex]::OpenExisting($mutexName)
            $probe.Dispose()
            $stillAlive = $true
        } catch {
            $stillAlive = $false
        }
        if ($stillAlive) {
            Write-Host 'FAIL：句柄报告已关闭，但互斥体仍然存在' -ForegroundColor Red
            exit 1
        }
        Write-Host "PASS：找到并关闭了 $($names[0])" -ForegroundColor Green
        exit 0
    } finally {
        Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- 主流程

$isAdmin = Test-IsAdmin

if ($Elevate -and -not $isAdmin) {
    Request-Elevation
    exit 0
}

if ($PrepareOnly) {
    $pids = Get-WeixinProcessIds
    $names = [WeixinMutex]::CloseMutexes($pids, $MutexNeedle, $false)
    Write-Host ("已关闭 " + $names.Length + " 个单实例互斥体句柄")
    exit 0
}

if ($ListFiles) {
    $pids = Get-WeixinProcessIds
    Write-Host ("Weixin PID: " + ($pids -join ', '))
    foreach ($onePid in $pids) {
        $names = [WeixinMutex]::ListHandles(@($onePid), 'File', $ListFiles)
        foreach ($name in ($names | Sort-Object -Unique)) {
            Write-Host ("[$onePid] $name")
        }
    }
    exit 0
}

if ($ListOnly) {
    $pids = Get-WeixinProcessIds
    if ($pids.Count -eq 0) {
        Write-Host '当前没有 Weixin.exe 进程。'
        exit 0
    }
    $needle = if ($AllMutants) { '' } else { $MutexNeedle }
    $names = [WeixinMutex]::CloseMutexes($pids, $needle, $true)
    Write-Host ("Weixin PID: " + ($pids -join ', '))
    if ($names.Length -eq 0) {
        Write-Host '没有找到单实例互斥体句柄。' -ForegroundColor Yellow
    } else {
        $names | ForEach-Object { Write-Host "  $_" }
    }
    exit 0
}

$exe = Get-WeixinExe

# 指定数据目录：微信 4.x 的 /d 参数会把 xwechat_files 建在该目录下。
# 不同数据目录的两个实例无法同时在线（新实例会因已有 IPC 实例而退出），
# 所以这里先关闭所有实例，再启动目标槽位。
if ($DataDir) {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

    $mains = @(Get-Process -Name 'Weixin' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($mains.Count -gt 0) {
        Write-Host '正在关闭当前微信实例（不同数据目录不能同时在线）…'
        foreach ($p in $mains) { $p.CloseMainWindow() | Out-Null }
        Start-Sleep -Seconds 6
    }
    foreach ($p in @(Get-Process -Name 'Weixin' -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2

    Start-Process -FilePath $exe -ArgumentList @('/d', ('"' + $DataDir + '"')) | Out-Null
    $window = @()
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $window = @(Get-Process -Name 'Weixin' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
        if ($window.Count -gt 0) { break }
    }
    if ($window.Count -eq 0) {
        Write-Host "启动失败：20 秒内没有出现微信窗口。" -ForegroundColor Red
        exit 1
    }
    Write-Host ("已用数据目录启动：" + $DataDir) -ForegroundColor Green
    exit 0
}

# 启动节奏：每 1.2s 起一个；整个窗口内持续清互斥体，
# 保证新实例创建出的互斥体在下一次启动前被关掉。
$launched = 0
$closedTotal = 0
$nextLaunch = Get-Date
$deadline = (Get-Date).AddSeconds($Count * 1.5 + 4)

Write-Host "微信：$exe"
Write-Host "准备启动 $Count 个新实例…"

while ((Get-Date) -lt $deadline) {
    # 必须先清掉已有实例的互斥体，再启动下一个；反过来会让新进程直接撞上旧互斥体后退出。
    $pids = Get-WeixinProcessIds
    if ($pids.Count -gt 0) {
        $closed = [WeixinMutex]::CloseMutexes($pids, $MutexNeedle, $false)
        if ($closed.Length -gt 0) {
            $closedTotal += $closed.Length
            Write-Host ("  已关闭互斥体：" + ($closed -join ', ')) -ForegroundColor DarkGray
        }
    }

    if ($launched -lt $Count -and (Get-Date) -ge $nextLaunch) {
        Start-Process -FilePath $exe | Out-Null
        $launched++
        Write-Host "  已启动第 $launched 个"
        $nextLaunch = (Get-Date).AddSeconds(1.2)
    }

    Start-Sleep -Milliseconds 300
}

if ($closedTotal -eq 0) {
    Write-Host '没有找到单实例互斥体句柄。如果微信是以管理员身份运行的，请用 -Elevate 重试。' -ForegroundColor Yellow
}
Write-Host "完成：本次启动 $launched 个实例。" -ForegroundColor Green
exit 0
