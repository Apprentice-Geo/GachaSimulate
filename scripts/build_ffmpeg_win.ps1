[CmdletBinding()]
param(
  [string]$MsysRoot = "C:\msys64",
  [Parameter(Mandatory = $true)][string]$X264Source,
  [Parameter(Mandatory = $true)][string]$FfmpegArchive,
  [Parameter(Mandatory = $true)][string]$ZlibArchive,
  [ValidateRange(1, 1024)][int]$Jobs = [Environment]::ProcessorCount
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-RequiredPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet("Leaf", "Container")][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $PathType = if ($Kind -eq "Leaf") { "Leaf" } else { "Container" }
  if (-not (Test-Path -LiteralPath $Path -PathType $PathType)) {
    throw "$Description is missing at '$Path'. See scripts/README.md for the pinned offline prerequisite."
  }
  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Read-Msys2PackageDatabase {
  param([Parameter(Mandatory = $true)][string]$DatabaseRoot)

  $Packages = [ordered]@{}
  foreach ($Description in Get-ChildItem -LiteralPath $DatabaseRoot -Filter "desc" -File -Recurse) {
    $Lines = @(Get-Content -LiteralPath $Description.FullName)
    $NameMarker = [Array]::IndexOf($Lines, "%NAME%")
    $VersionMarker = [Array]::IndexOf($Lines, "%VERSION%")
    if ($NameMarker -lt 0 -or $NameMarker + 1 -ge $Lines.Count -or $VersionMarker -lt 0 -or $VersionMarker + 1 -ge $Lines.Count) {
      continue
    }
    $Packages[$Lines[$NameMarker + 1]] = $Lines[$VersionMarker + 1]
  }
  return $Packages
}

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $Output = & $Executable @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE`:`n$Output"
  }
  return $Output.TrimEnd()
}

function Assert-SystemPeImports {
  param(
    [Parameter(Mandatory = $true)][string]$MaterialsPath,
    [Parameter(Mandatory = $true)][string[]]$Programs
  )

  $AllowedWindowsDlls = @(
    "advapi32.dll", "bcrypt.dll", "crypt32.dll", "gdi32.dll", "kernel32.dll",
    "msvcrt.dll", "ntdll.dll", "ole32.dll", "oleaut32.dll", "psapi.dll",
    "secur32.dll", "shell32.dll", "shlwapi.dll", "ucrtbase.dll", "user32.dll",
    "userenv.dll", "version.dll", "winmm.dll", "ws2_32.dll"
  )
  foreach ($Program in $Programs) {
    $ImportFile = Join-Path $MaterialsPath "$Program-pe-imports.txt"
    $Imports = @(Get-Content -LiteralPath $ImportFile | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim().ToLowerInvariant() })
    if ($Imports.Count -eq 0) {
      throw "PE import inspection returned no DLLs for $Program.exe."
    }
    foreach ($Import in $Imports) {
      if ($Import -match '^(api-ms-win-|ext-ms-win-).+\.dll$' -or $AllowedWindowsDlls -contains $Import) {
        continue
      }
      throw "$Program.exe imports non-system DLL '$Import'. Static UCRT64 output must not depend on MSYS2 or MinGW runtime DLLs."
    }
  }
}

function Assert-IsolatedExecution {
  param([Parameter(Mandatory = $true)][string]$BinPath)

  $RunRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ("gachasimulate-ffmpeg-run-" + [guid]::NewGuid().ToString("N"))))
  New-Item -ItemType Directory -Path $RunRoot | Out-Null
  try {
    Copy-Item -LiteralPath (Join-Path $BinPath "ffmpeg.exe") -Destination $RunRoot
    Copy-Item -LiteralPath (Join-Path $BinPath "ffprobe.exe") -Destination $RunRoot
    $PreviousPath = $env:PATH
    try {
      $env:PATH = "$(Join-Path $env:WINDIR 'System32');$env:WINDIR"
      Push-Location $RunRoot
      try {
        $FfmpegVersion = Invoke-CheckedNative -Executable (Join-Path $RunRoot "ffmpeg.exe") -Arguments @("-version") -Description "isolated ffmpeg.exe validation"
        $FfprobeVersion = Invoke-CheckedNative -Executable (Join-Path $RunRoot "ffprobe.exe") -Arguments @("-version") -Description "isolated ffprobe.exe validation"
        if ($FfmpegVersion -notmatch '(?m)^ffmpeg version 9\.0\.1(?:[\s-]|$)' -or $FfprobeVersion -notmatch '(?m)^ffprobe version 9\.0\.1(?:[\s-]|$)') {
          throw "The staged executables report an unexpected version outside the development PATH."
        }
      }
      finally {
        Pop-Location
      }
    }
    finally {
      $env:PATH = $PreviousPath
    }
  }
  finally {
    if (Test-Path -LiteralPath $RunRoot) {
      Remove-Item -LiteralPath $RunRoot -Recurse -Force
    }
  }
}

if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
  throw "The offline FFmpeg source build supports Windows x64 only."
}

$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$LockPath = Resolve-RequiredPath -Path (Join-Path $PSScriptRoot "ffmpeg_windows_source_lock.json") -Kind Leaf -Description "FFmpeg source lock"
$BashScript = Resolve-RequiredPath -Path (Join-Path $PSScriptRoot "build_ffmpeg_win_ucrt64.sh") -Kind Leaf -Description "UCRT64 FFmpeg build script"
$Lock = Get-Content -Raw -LiteralPath $LockPath | ConvertFrom-Json
if ($Lock.target -ne "win32-x64-ucrt64") {
  throw "Unsupported FFmpeg build target in '$LockPath'."
}

$ResolvedMsysRoot = Resolve-RequiredPath -Path $MsysRoot -Kind Container -Description "MSYS2 root"
$ResolvedX264Source = Resolve-RequiredPath -Path $X264Source -Kind Container -Description "x264 Git worktree"
$ResolvedFfmpegArchive = Resolve-RequiredPath -Path $FfmpegArchive -Kind Leaf -Description "FFmpeg source archive"
$ResolvedZlibArchive = Resolve-RequiredPath -Path $ZlibArchive -Kind Leaf -Description "zlib source archive"
if ([System.IO.Path]::GetFileName($ResolvedZlibArchive) -ne $Lock.zlib.archive_name -or
    (Get-FileHash -LiteralPath $ResolvedZlibArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Lock.zlib.archive_sha256) {
  throw "zlib source archive name or SHA-256 mismatch. See the source lock."
}

if ([System.IO.Path]::GetFileName($ResolvedFfmpegArchive) -ne $Lock.ffmpeg.archive_name) {
  throw "Expected FFmpeg archive name '$($Lock.ffmpeg.archive_name)', got '$([System.IO.Path]::GetFileName($ResolvedFfmpegArchive))'."
}
$ActualArchiveHash = (Get-FileHash -LiteralPath $ResolvedFfmpegArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualArchiveHash -ne $Lock.ffmpeg.archive_sha256) {
  throw "FFmpeg archive SHA-256 mismatch: expected $($Lock.ffmpeg.archive_sha256), got $ActualArchiveHash."
}

$Bash = Resolve-RequiredPath -Path (Join-Path $ResolvedMsysRoot "usr\bin\bash.exe") -Kind Leaf -Description "MSYS2 Bash"
$Git = Resolve-RequiredPath -Path (Join-Path $ResolvedMsysRoot "usr\bin\git.exe") -Kind Leaf -Description "MSYS2 Git"
$PackageDatabase = Resolve-RequiredPath -Path (Join-Path $ResolvedMsysRoot "var\lib\pacman\local") -Kind Container -Description "MSYS2 local package database"

$AllInstalledPackages = Read-Msys2PackageDatabase -DatabaseRoot $PackageDatabase

$X264Head = Invoke-CheckedNative -Executable $Git -Arguments @("-C", $ResolvedX264Source, "rev-parse", "HEAD") -Description "x264 HEAD validation"
if ($X264Head -ne $Lock.x264.commit) {
  throw "x264 HEAD mismatch: expected $($Lock.x264.commit), got $X264Head. The build never fetches or changes the worktree."
}
$X264Status = Invoke-CheckedNative -Executable $Git -Arguments @("-C", $ResolvedX264Source, "status", "--porcelain=v1", "--untracked-files=normal") -Description "x264 worktree validation"
if ($X264Status) {
  throw "x264 worktree must be clean before an offline build:`n$X264Status"
}

$Destination = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "build\ffmpeg\win32-x64"))
$BuildParent = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "build\ffmpeg"))
if (-not $Destination.StartsWith($BuildParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to install outside the workspace FFmpeg build directory."
}
New-Item -ItemType Directory -Path $BuildParent -Force | Out-Null
$BuildId = [guid]::NewGuid().ToString("N")
$WorkRoot = Join-Path $BuildParent ".win32-x64-work-$BuildId"
$StageRoot = Join-Path $BuildParent ".win32-x64-stage-$BuildId"
$BackupRoot = Join-Path $BuildParent ".win32-x64-backup-$BuildId"

$EnvironmentNames = @(
  "MSYSTEM", "CHERE_INVOKING", "GS_PROJECT_ROOT", "GS_X264_SOURCE", "GS_FFMPEG_ARCHIVE",
  "GS_WORK_ROOT", "GS_STAGE_ROOT", "GS_JOBS", "GS_X264_COMMIT", "GS_FFMPEG_VERSION",
  "GS_FFMPEG_ARCHIVE_NAME", "GS_FFMPEG_SHA256", "GS_ZLIB_ARCHIVE", "GS_ZLIB_VERSION"
)
$PreviousEnvironment = @{}
foreach ($Name in $EnvironmentNames) {
  $PreviousEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
}

$Installed = $false
$HadDestination = $false
try {
  New-Item -ItemType Directory -Path $WorkRoot, $StageRoot | Out-Null
  $env:MSYSTEM = "UCRT64"
  $env:CHERE_INVOKING = "1"
  $env:GS_PROJECT_ROOT = $ProjectRoot
  $env:GS_X264_SOURCE = $ResolvedX264Source
  $env:GS_FFMPEG_ARCHIVE = $ResolvedFfmpegArchive
  $env:GS_WORK_ROOT = $WorkRoot
  $env:GS_STAGE_ROOT = $StageRoot
  $env:GS_JOBS = [string]$Jobs
  $env:GS_X264_COMMIT = $Lock.x264.commit
  $env:GS_FFMPEG_VERSION = $Lock.ffmpeg.version
  $env:GS_FFMPEG_ARCHIVE_NAME = $Lock.ffmpeg.archive_name
  $env:GS_FFMPEG_SHA256 = $Lock.ffmpeg.archive_sha256
  $env:GS_ZLIB_ARCHIVE = $ResolvedZlibArchive
  $env:GS_ZLIB_VERSION = $Lock.zlib.version

  & $Bash --noprofile --norc $BashScript
  if ($LASTEXITCODE -ne 0) {
    throw "UCRT64 FFmpeg build failed with exit code $LASTEXITCODE."
  }

  $StageBin = Join-Path $StageRoot "bin"
  $Materials = Join-Path $StageRoot "materials"
  $BinFiles = @(Get-ChildItem -LiteralPath $StageBin -File | Select-Object -ExpandProperty Name | Sort-Object)
  if ($BinFiles.Count -ne 2 -or $BinFiles[0] -ne "ffmpeg.exe" -or $BinFiles[1] -ne "ffprobe.exe") {
    throw "Staged bin must contain only ffmpeg.exe and ffprobe.exe; found: $($BinFiles -join ', ')."
  }
  Assert-SystemPeImports -MaterialsPath $Materials -Programs @("ffmpeg", "ffprobe")
  Assert-IsolatedExecution -BinPath $StageBin

  $AllInstalledPackages | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Materials "msys2-package-snapshot.json") -Encoding utf8
  [ordered]@{
    target = $Destination
    x264_private_prefix = "temporary build-only prefix; not installed"
    msys2_root = $ResolvedMsysRoot
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Materials "install-paths.json") -Encoding utf8

  $HadDestination = Test-Path -LiteralPath $Destination
  if ($HadDestination) {
    Move-Item -LiteralPath $Destination -Destination $BackupRoot
  }
  try {
    Move-Item -LiteralPath $StageRoot -Destination $Destination
    Assert-IsolatedExecution -BinPath (Join-Path $Destination "bin")
    $Installed = $true
  }
  catch {
    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    if ($HadDestination -and (Test-Path -LiteralPath $BackupRoot)) {
      Move-Item -LiteralPath $BackupRoot -Destination $Destination
    }
    throw
  }
  if (Test-Path -LiteralPath $BackupRoot) {
    try {
      Remove-Item -LiteralPath $BackupRoot -Recurse -Force
    }
    catch {
      Write-Warning "The new FFmpeg build is installed, but the previous backup could not be removed: $BackupRoot"
    }
  }

  Write-Host "Installed offline-built FFmpeg at $Destination"
  Write-Host "Build materials: $(Join-Path $Destination 'materials')"
}
finally {
  foreach ($Name in $EnvironmentNames) {
    [Environment]::SetEnvironmentVariable($Name, $PreviousEnvironment[$Name], "Process")
  }
  if (Test-Path -LiteralPath $WorkRoot) {
    Remove-Item -LiteralPath $WorkRoot -Recurse -Force
  }
  if (-not $Installed -and (Test-Path -LiteralPath $StageRoot)) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
  }
  if (-not $Installed -and $HadDestination -and (Test-Path -LiteralPath $BackupRoot) -and -not (Test-Path -LiteralPath $Destination)) {
    Move-Item -LiteralPath $BackupRoot -Destination $Destination
  }
}
