<#
.SYNOPSIS
    MtBot Service Manager
    重构版 Windows 客户端启动脚本

.DESCRIPTION
    启动 MtBot windows 项目（重构版）
    基于原 services.ps1 脚本修改，适配重构项目路径

.PARAMETER Action
    Action: start, stop, restart, status

.PARAMETER NoBuild
    Skip the build step when starting/restarting services

.EXAMPLE
    .\start.ps1 start           # Start Windows client
    .\start.ps1 start -NoBuild  # Start without building
    .\start.ps1 stop            # Stop Windows client
    .\start.ps1 restart         # Restart Windows client
    .\start.ps1 status          # Show service status
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet("start", "stop", "restart", "status")]
    [string]$Action,

    [switch]$NoBuild
)

# ============================================================================
# Configuration
# ============================================================================

# Script location - stored in windows-ai\docs
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Go up 2 levels to get to apps folder, then find the target project
$AppsDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$ProjectRoot = Split-Path -Parent $AppsDir

# Target service configuration for windows
$ServiceConfig = @{
    Name = "Windows Client"
    Key = "windows"
    WorkDir = "$ProjectRoot\apps\windows"
    StartCmd = "pnpm dev"
    Color = "Blue"
    Port = $null
    EnvFile = $null
    NeedsBuild = $false
    WindowTitle = "MtBot Windows"
}

# ============================================================================
# Helper functions
# ============================================================================

# Log output function
function Write-ServiceLog {
    param(
        [string]$ServiceName,
        [string]$Message,
        [string]$Color = "White"
    )
    $timestamp = Get-Date -Format "HH:mm:ss"
    Write-Host "[$timestamp] " -NoNewline -ForegroundColor DarkGray
    Write-Host "[$ServiceName] " -NoNewline -ForegroundColor $Color
    Write-Host $Message
}

# Get process by window title
function Get-ProcessByWindowTitle {
    param([string]$TitlePattern)
    return Get-Process | Where-Object { $_.MainWindowTitle -like "*$TitlePattern*" }
}

# ============================================================================
# Service functions
# ============================================================================

# Check prerequisites
function Test-Prerequisites {
    Write-ServiceLog "Check" "Checking prerequisites..." "Cyan"
    
    # Check if project directory exists
    if (-not (Test-Path $ServiceConfig.WorkDir)) {
        Write-ServiceLog "Error" "Project directory not found: $($ServiceConfig.WorkDir)" "Red"
        return $false
    }
    
    # Check if package.json exists
    $packageJson = "$($ServiceConfig.WorkDir)\package.json"
    if (-not (Test-Path $packageJson)) {
        Write-ServiceLog "Error" "package.json not found in project directory" "Red"
        return $false
    }
    
    # Check if node_modules exists
    $nodeModules = "$($ServiceConfig.WorkDir)\node_modules"
    if (-not (Test-Path $nodeModules)) {
        Write-ServiceLog "Check" "node_modules not found, installing dependencies..." "Yellow"
        if (-not (Install-Dependencies)) {
            return $false
        }
    }
    
    Write-ServiceLog "Check" "Prerequisites OK" "Green"
    return $true
}

# Install dependencies
function Install-Dependencies {
    Write-Host ""
    Write-ServiceLog "Install" "Running pnpm install..." "Magenta"
    
    $installStartTime = Get-Date
    
    # Run pnpm install using cmd.exe
    $result = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "pnpm install" -WorkingDirectory $ServiceConfig.WorkDir -NoNewWindow -PassThru -Wait
    
    $installDuration = (Get-Date) - $installStartTime
    $durationStr = "{0:N1}s" -f $installDuration.TotalSeconds
    
    if ($result.ExitCode -eq 0) {
        Write-ServiceLog "Install" "Dependencies installed successfully ($durationStr)" "Green"
        return $true
    } else {
        Write-ServiceLog "Install" "Failed to install dependencies (exit code: $($result.ExitCode), $durationStr)" "Red"
        return $false
    }
}

# Build function
function Invoke-Build {
    Write-Host ""
    Write-ServiceLog "Build" "Building windows project..." "Magenta"
    
    $buildStartTime = Get-Date
    
    # Run pnpm build using cmd.exe
    $result = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "pnpm build" -WorkingDirectory $ServiceConfig.WorkDir -NoNewWindow -PassThru -Wait
    
    $buildDuration = (Get-Date) - $buildStartTime
    $durationStr = "{0:N1}s" -f $buildDuration.TotalSeconds
    
    if ($result.ExitCode -eq 0) {
        Write-ServiceLog "Build" "Build succeeded ($durationStr)" "Green"
        return $true
    } else {
        Write-ServiceLog "Build" "Build FAILED (exit code: $($result.ExitCode), $durationStr)" "Red"
        return $false
    }
}

# Start service
function StartService {
    $name = $ServiceConfig.Name
    $color = $ServiceConfig.Color
    
    Write-Host ""
    Write-ServiceLog $name "Starting..." $color
    
    # Check prerequisites (including node_modules)
    if (-not (Test-Prerequisites)) {
        return $false
    }
    
    # Double check node_modules exists
    $nodeModules = "$($ServiceConfig.WorkDir)\node_modules"
    if (-not (Test-Path $nodeModules)) {
        Write-ServiceLog $name "ERROR: node_modules still missing after install attempt" "Red"
        return $false
    }
    
    # Check if already running
    $existingWindows = Get-ProcessByWindowTitle $ServiceConfig.WindowTitle
    if ($existingWindows) {
        Write-ServiceLog $name "Service already running (PID: $($existingWindows[0].Id))" "Yellow"
        return $true
    }
    
    # Start service in new PowerShell window using cmd to run pnpm dev
    # Using cmd because pnpm dev uses cmd-specific syntax
    $command = "Set-Location '$($ServiceConfig.WorkDir)'; $([char]36)Host.UI.RawUI.WindowTitle = '$($ServiceConfig.WindowTitle)'; cmd /c 'pnpm dev'"
    
    $startInfo = @{
        FilePath = "powershell.exe"
        ArgumentList = @("-NoExit", "-Command", $command)
        WorkingDirectory = $ServiceConfig.WorkDir
    }
    
    Start-Process @startInfo
    
    # Wait for process to start
    Start-Sleep -Seconds 3
    
    # Verify it started
    $newWindows = Get-ProcessByWindowTitle $ServiceConfig.WindowTitle
    $electronProcs = Get-Process | Where-Object { $_.ProcessName -like "*electron*" }
    
    if ($newWindows) {
        Write-ServiceLog $name "Started successfully (PID: $($newWindows[0].Id))" "Green"
        return $true
    } elseif ($electronProcs) {
        Write-ServiceLog $name "Started successfully (Electron PID: $($electronProcs[0].Id))" "Green"
        return $true
    } else {
        Write-ServiceLog $name "Started (check new window for status)" "Green"
        return $true
    }
}

# Stop service
function StopService {
    $name = $ServiceConfig.Name
    $color = $ServiceConfig.Color
    
    Write-Host ""
    Write-ServiceLog $name "Stopping..." $color
    
    $stopped = $false
    $killedPids = @{}
    
    # Find and close by window title
    $windows = Get-ProcessByWindowTitle $ServiceConfig.WindowTitle
    foreach ($win in $windows) {
        Write-ServiceLog $name "Closing window PID: $($win.Id)" $color
        
        # Kill child processes first
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($win.Id)" -ErrorAction SilentlyContinue |
            ForEach-Object { 
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                $killedPids[$_.ProcessId] = $true
            }
        
        # Kill the main process
        Stop-Process -Id $win.Id -Force -ErrorAction SilentlyContinue
        $killedPids[$win.Id] = $true
        $stopped = $true
    }
    
    # Check for Electron processes
    $electronProcs = Get-Process | Where-Object { $_.ProcessName -like "*electron*" }
    
    foreach ($proc in $electronProcs) {
        if (-not $killedPids.ContainsKey($proc.Id)) {
            Write-ServiceLog $name "Killing Electron process PID: $($proc.Id)" $color
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            $killedPids[$proc.Id] = $true
            $stopped = $true
        }
    }
    
    # Check for node processes
    $nodeProcs = Get-Process | Where-Object { $_.ProcessName -eq "node" }
    
    foreach ($proc in $nodeProcs) {
        if (-not $killedPids.ContainsKey($proc.Id)) {
            try {
                $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
                if ($procInfo -and $procInfo.CommandLine) {
                    $cmdLine = $procInfo.CommandLine
                    if (($cmdLine -like "*$($ServiceConfig.WorkDir)*") -or 
                        ($cmdLine -like "*electron-vite*")) {
                        Write-ServiceLog $name "Killing Node process PID: $($proc.Id)" $color
                        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                        $killedPids[$proc.Id] = $true
                        $stopped = $true
                    }
                }
            } catch {
                # Ignore errors
            }
        }
    }
    
    if ($stopped) {
        Write-ServiceLog $name "Stopped" "Green"
    } else {
        Write-ServiceLog $name "Not running" "Yellow"
    }
    
    return $stopped
}

# Get service status
function GetStatus {
    $name = $ServiceConfig.Name
    
    $status = @{
        Name = $name
        Running = $false
        PID = $null
    }
    
    # Check by window title
    $windows = Get-ProcessByWindowTitle $ServiceConfig.WindowTitle
    if ($windows) {
        $status.Running = $true
        $firstWin = if ($windows -is [array]) { $windows[0] } else { $windows }
        $status.PID = $firstWin.Id
    } else {
        # Check for electron processes
        $electronProcs = Get-Process | Where-Object { $_.ProcessName -like "*electron*" }
        if ($electronProcs) {
            $status.Running = $true
            $status.PID = $electronProcs[0].Id
        }
    }
    
    return $status
}

# Show status
function Show-Status {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "           MtBot Windows Status                      " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  Service                          | Status   | PID              " -ForegroundColor Cyan
    Write-Host "----------------------------------------------------------------" -ForegroundColor Cyan
    
    $status = GetStatus
    
    $nameStr = $status.Name.PadRight(32)
    $statusStr = if ($status.Running) { "Running".PadRight(8) } else { "Stopped".PadRight(8) }
    $pidStr = if ($status.PID) { $status.PID.ToString().PadRight(16) } else { "-".PadRight(16) }
    
    $statusColor = if ($status.Running) { "Green" } else { "Red" }
    
    Write-Host "  $nameStr| $statusStr| $pidStr" -ForegroundColor White
    
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Project Path: $($ServiceConfig.WorkDir)" -ForegroundColor DarkGray
    Write-Host ""
}

# ============================================================================
# Main logic
# ============================================================================

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "         MtBot Windows Service Manager               " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

switch ($Action) {
    "start" {
        # Build if needed (unless -NoBuild)
        if (-not $NoBuild) {
            $buildOk = Invoke-Build
            if (-not $buildOk) {
                Write-Host "Build failed. Aborting start." -ForegroundColor Red
                exit 1
            }
            Write-Host ""
        }
        
        StartService
        Write-Host ""
        Show-Status
    }
    
    "stop" {
        StopService
        Write-Host ""
        Show-Status
    }
    
    "restart" {
        Write-Host "Restarting windows service..." -ForegroundColor Magenta
        Write-Host ""
        
        # Stop first
        StopService
        Start-Sleep -Seconds 2
        
        # Build if needed
        if (-not $NoBuild) {
            $buildOk = Invoke-Build
            if (-not $buildOk) {
                Write-Host "Build failed. Aborting restart." -ForegroundColor Red
                exit 1
            }
            Write-Host ""
        }
        
        # Then start
        StartService
        Write-Host ""
        Show-Status
    }
    
    "status" {
        Show-Status
    }
}

Write-Host "Done" -ForegroundColor Green
Write-Host ""
