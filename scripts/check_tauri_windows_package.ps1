$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$NsisDir = Join-Path $ProjectRoot "target/release/bundle/nsis"
$Installer = Get-ChildItem -LiteralPath $NsisDir -Filter "GachaSimulate_$($Package.version)_x64-setup.exe" -File | Select-Object -First 1
if (-not $Installer) {
  throw "Missing Tauri NSIS installer under $NsisDir"
}

$SourceFfmpeg = Join-Path $ProjectRoot "build/ffmpeg/win32-x64/bin/ffmpeg.exe"
$FfmpegLock = Get-Content -LiteralPath (Join-Path $ProjectRoot "build/ffmpeg/win32-x64/materials/source-lock.json") -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $SourceFfmpeg -PathType Leaf)) {
  throw "Missing self-built FFmpeg binary at $SourceFfmpeg"
}

$UninstallRegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
if (Test-Path -LiteralPath $UninstallRegPath) {
  $ExistingInstall = Get-ChildItem -LiteralPath $UninstallRegPath -ErrorAction SilentlyContinue | Where-Object {
    $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    ($_.PSChildName -eq "GachaSimulate") -or ($props -and $props.PSObject.Properties["DisplayName"] -and $props.DisplayName -eq "GachaSimulate")
  }
  if ($ExistingInstall) {
    throw "Refusing to run NSIS smoke install while an existing per-user GachaSimulate installation is registered under HKCU Uninstall. Run in a clean user profile or uninstall first."
  }
}

$InstallRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gachasimulate-tauri-install-" + [guid]::NewGuid().ToString("N"))
$SmokeData = Join-Path ([System.IO.Path]::GetTempPath()) ("gachasimulate-tauri-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $SmokeData -Force | Out-Null

$OriginalPath = $env:Path
try {
  # Silent fresh per-user install into isolated directory
  $Proc = Start-Process -FilePath $Installer.FullName -ArgumentList @("/S", "/D=$InstallRoot") -Wait -PassThru
  if ($Proc.ExitCode -ne 0) {
    throw "NSIS silent install failed with exit code $($Proc.ExitCode)"
  }

  $AppExe = Join-Path $InstallRoot "GachaSimulate.exe"
  $WorkerExe = Join-Path $InstallRoot "gachasimulate-worker.exe"
  $FfmpegExe = Join-Path $InstallRoot "ffmpeg/bin/ffmpeg.exe"
  $LicenseDir = Join-Path $InstallRoot "licenses"

  foreach ($Path in @($AppExe, $WorkerExe, $FfmpegExe)) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
      throw "Missing installed Tauri artifact: $Path"
    }
  }
  if ((Get-FileHash -LiteralPath $FfmpegExe -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $SourceFfmpeg -Algorithm SHA256).Hash) {
    throw "Installed FFmpeg differs from self-built source binary: $SourceFfmpeg"
  }

  & node (Join-Path $PSScriptRoot "application_licenses.mjs") --verify $LicenseDir --include-rust
  if ($LASTEXITCODE -ne 0) {
    throw "Installed application license verification failed."
  }

  # Isolated PATH smoke checks on installed FFmpeg and installed gachasimulate-worker
  $env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
  $FfmpegVersion = & $FfmpegExe -version 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "Installed FFmpeg smoke failed with exit code $LASTEXITCODE`:`n$FfmpegVersion"
  }
  $ExpectedFfmpegVersion = [regex]::Escape($FfmpegLock.ffmpeg.version)
  if ($FfmpegVersion -notmatch "(?m)^ffmpeg version $ExpectedFfmpegVersion(?:[\s-]|$)") {
    throw "Installed FFmpeg reports unexpected version: $FfmpegVersion"
  }

  # Analyze 1D large-total fixture (9007199254740993) with installed worker under isolated PATH
  $LargeFixture = Join-Path $ProjectRoot "crates/gachasimulate-gsr/fixtures/large-total-9007199254740993.gsr"
  $AnalysisJson = & $WorkerExe analyze --input $LargeFixture
  if ($LASTEXITCODE -ne 0) {
    throw "Installed worker analyze failed with exit code $LASTEXITCODE"
  }
  $Analysis = $AnalysisJson | ConvertFrom-Json
  if ($Analysis.totals.result -ne "9007199254740993") {
    throw "Installed worker returned unexpected large total: $($Analysis.totals.result)"
  }

  # Launch installed Tauri GUI binary with isolated data dir and verify clean startup + graceful exit
  if (-not ("GachaWin32Probe" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class GachaWin32Probe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  public static IntPtr FindVisibleWindowByTitle(uint targetPid, string expectedTitle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid && IsWindowVisible(hWnd)) {
        var sb = new StringBuilder(256);
        GetWindowText(hWnd, sb, sb.Capacity);
        if (sb.ToString() == expectedTitle) {
          found = hWnd;
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
  }

  $PreviousDataDir = $env:GACHASIMULATE_DATA_DIR
  $env:GACHASIMULATE_DATA_DIR = $SmokeData
  $AppProc = $null
  try {
    $AppProc = Start-Process -FilePath $AppExe -PassThru
    $MainHwnd = [IntPtr]::Zero
    $WindowDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $WindowDeadline) {
      $AppProc.Refresh()
      if ($AppProc.HasExited) {
        throw "Installed GachaSimulate.exe exited prematurely with exit code $($AppProc.ExitCode)"
      }
      $MainHwnd = [GachaWin32Probe]::FindVisibleWindowByTitle([uint32]$AppProc.Id, "GachaSimulate")
      if ($MainHwnd -ne [IntPtr]::Zero) {
        break
      }
      Start-Sleep -Milliseconds 200
    }
    Start-Sleep -Seconds 1
    $AppProc.Refresh()
    if ($AppProc.HasExited) {
      throw "Installed GachaSimulate.exe exited prematurely with exit code $($AppProc.ExitCode)"
    }
    if ($MainHwnd -eq [IntPtr]::Zero) {
      Stop-Process -Id $AppProc.Id -Force -ErrorAction SilentlyContinue
      throw "Installed GachaSimulate.exe never opened a visible 'GachaSimulate' main window within 15 seconds"
    }
    $Posted = [GachaWin32Probe]::PostMessage($MainHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    if (-not $Posted) {
      Stop-Process -Id $AppProc.Id -Force -ErrorAction SilentlyContinue
      throw "Failed to post WM_CLOSE to installed GachaSimulate.exe main window ($MainHwnd)"
    }
    if (-not $AppProc.WaitForExit(10000)) {
      Stop-Process -Id $AppProc.Id -Force -ErrorAction SilentlyContinue
      throw "Installed GachaSimulate.exe did not exit within 10s after WM_CLOSE"
    }
    if ($AppProc.ExitCode -ne 0) {
      throw "Installed GachaSimulate.exe exited with non-zero code $($AppProc.ExitCode)"
    }
    $StrayWorkers = @(Get-Process -Name "gachasimulate-worker" -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path -eq $WorkerExe } catch { $false }
    })
    if ($StrayWorkers.Count -gt 0) {
      throw "Stray installed gachasimulate-worker process remained after app exit."
    }
  }
  finally {
    if ($null -eq $PreviousDataDir) {
      Remove-Item Env:GACHASIMULATE_DATA_DIR -ErrorAction SilentlyContinue
    } else {
      $env:GACHASIMULATE_DATA_DIR = $PreviousDataDir
    }
  }

  # Restore PATH to run Milestone 2 E2E integration suite directly against the installed worker binary
  $env:Path = $OriginalPath
  $PreviousWorkerEnv = $env:GACHASIMULATE_INSTALLED_WORKER
  $env:GACHASIMULATE_INSTALLED_WORKER = $WorkerExe
  try {
    & cargo test -p gachasimulate-tauri --test milestone2_e2e -- --nocapture
    if ($LASTEXITCODE -ne 0) {
      throw "Milestone 2 E2E suite failed against installed worker."
    }
  }
  finally {
    if ($null -eq $PreviousWorkerEnv) {
      Remove-Item Env:GACHASIMULATE_INSTALLED_WORKER -ErrorAction SilentlyContinue
    } else {
      $env:GACHASIMULATE_INSTALLED_WORKER = $PreviousWorkerEnv
    }
  }

  Write-Output "PASS: Tauri NSIS fresh install verified ($($Installer.Name)); installed app launch/exit, worker E2E, FFmpeg, licenses, and 9007199254740993 analysis smoke succeeded."
}
finally {
  $env:Path = $OriginalPath
  $UninstallExe = Join-Path $InstallRoot "uninstall.exe"
  if (Test-Path -LiteralPath $UninstallExe -PathType Leaf) {
    try {
      Start-Process -FilePath $UninstallExe -ArgumentList @("/S") -Wait -PassThru | Out-Null
    } catch { }
  }
  Start-Sleep -Milliseconds 300
  if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $SmokeData) { Remove-Item -LiteralPath $SmokeData -Recurse -Force -ErrorAction SilentlyContinue }
}
