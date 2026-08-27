[CmdletBinding()]
param(
  [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ArchiveName = "ffmpeg-9.0.1-essentials_build.zip"
$ArchiveSha256 = "fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9"
$FfmpegSourceCommit = "bf1b838f2a"
$ArchiveUrl = "https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/$ArchiveName"

if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
  throw "The pinned FFmpeg baseline supports Windows x64 only."
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$Destination = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "build\ffmpeg\win32-x64"))
$ExpectedDestination = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "build\ffmpeg\win32-x64"))
if ($Destination -ne $ExpectedDestination) {
  throw "Refusing to install FFmpeg outside the exact workspace build target."
}
$BuildParent = Split-Path -Parent $Destination
$SystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$WorkDirectory = [System.IO.Path]::GetFullPath((Join-Path $SystemTemp ("gachasimulate-ffmpeg-" + [guid]::NewGuid().ToString("N"))))
if (-not $WorkDirectory.StartsWith($SystemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a temporary directory outside the system temp root."
}
$WorkingArchivePath = Join-Path $WorkDirectory $ArchiveName
$ExtractedPath = Join-Path $WorkDirectory "extracted"
$StagedPath = Join-Path $WorkDirectory "win32-x64"
$BackupPath = "$Destination.backup-$([guid]::NewGuid().ToString("N"))"

function Invoke-CheckedFfmpeg {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $Output = & $Executable @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg validation failed for '$($Arguments -join ' ')':`n$Output"
  }
  return $Output
}

New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
try {
  if ($ArchivePath) {
    $ResolvedArchivePath = (Resolve-Path -LiteralPath $ArchivePath).Path
    Write-Host "Using local development FFmpeg archive at $ResolvedArchivePath"
    Copy-Item -LiteralPath $ResolvedArchivePath -Destination $WorkingArchivePath
    $ArchiveSource = $ResolvedArchivePath
  }
  else {
    Write-Host "Downloading pinned development FFmpeg archive from $ArchiveUrl"
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $WorkingArchivePath
    $ArchiveSource = $ArchiveUrl
  }

  $ActualSha256 = (Get-FileHash -LiteralPath $WorkingArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ArchiveSha256) {
    throw "FFmpeg archive SHA-256 mismatch: expected $ArchiveSha256, got $ActualSha256"
  }

  Expand-Archive -LiteralPath $WorkingArchivePath -DestinationPath $ExtractedPath
  $FfmpegExecutables = @(Get-ChildItem -LiteralPath $ExtractedPath -Filter "ffmpeg.exe" -File -Recurse)
  if ($FfmpegExecutables.Count -ne 1) {
    throw "Expected exactly one ffmpeg.exe in the pinned archive, found $($FfmpegExecutables.Count)."
  }

  $DistributionRoot = Split-Path -Parent (Split-Path -Parent $FfmpegExecutables[0].FullName)
  Copy-Item -LiteralPath $DistributionRoot -Destination $StagedPath -Recurse
  $StagedFfmpeg = Join-Path $StagedPath "bin\ffmpeg.exe"
  $StagedFfprobe = Join-Path $StagedPath "bin\ffprobe.exe"
  if (-not (Test-Path -LiteralPath $StagedFfmpeg -PathType Leaf) -or -not (Test-Path -LiteralPath $StagedFfprobe -PathType Leaf)) {
    throw "The pinned archive does not contain both bin\ffmpeg.exe and bin\ffprobe.exe."
  }

  $Version = Invoke-CheckedFfmpeg -Executable $StagedFfmpeg -Arguments @("-version")
  if ($Version -notmatch "(?m)^ffmpeg version 9\.0\.1-essentials_build") {
    throw "Unexpected FFmpeg version output:`n$Version"
  }
  $BuildConfiguration = Invoke-CheckedFfmpeg -Executable $StagedFfmpeg -Arguments @("-buildconf")
  $Encoders = Invoke-CheckedFfmpeg -Executable $StagedFfmpeg -Arguments @("-hide_banner", "-encoders")
  if ($BuildConfiguration -notmatch "--enable-gpl" -or $BuildConfiguration -notmatch "--enable-libx264") {
    throw "The pinned FFmpeg build configuration does not enable both GPL components and libx264."
  }
  if ($Encoders -notmatch "(?m)^\s*V\S*\s+libx264\s") {
    throw "The pinned FFmpeg build does not expose the required libx264 encoder."
  }

  $DevelopmentMarker = [ordered]@{
    purpose = "development-and-ci-only"
    archive_source = $ArchiveSource
    archive_sha256 = $ArchiveSha256
    ffmpeg_source_commit = $FfmpegSourceCommit
    distribution_status = "not-approved"
    decision_document = "docs/FFMPEG_DISTRIBUTION.md"
  }
  $DevelopmentMarker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StagedPath "DEVELOPMENT-ONLY.json") -Encoding utf8

  New-Item -ItemType Directory -Path $BuildParent -Force | Out-Null
  $HadDestination = Test-Path -LiteralPath $Destination
  if ($HadDestination) {
    Move-Item -LiteralPath $Destination -Destination $BackupPath
  }
  try {
    Move-Item -LiteralPath $StagedPath -Destination $Destination
  }
  catch {
    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    if ($HadDestination -and (Test-Path -LiteralPath $BackupPath)) {
      Move-Item -LiteralPath $BackupPath -Destination $Destination
    }
    throw
  }
  $FinalFfmpeg = Join-Path $Destination "bin\ffmpeg.exe"
  try {
    $FinalVersion = Invoke-CheckedFfmpeg -Executable $FinalFfmpeg -Arguments @("-version")
    $FinalBuildConfiguration = Invoke-CheckedFfmpeg -Executable $FinalFfmpeg -Arguments @("-buildconf")
    $FinalEncoders = Invoke-CheckedFfmpeg -Executable $FinalFfmpeg -Arguments @("-hide_banner", "-encoders")
    if ($FinalVersion -notmatch "(?m)^ffmpeg version 9\.0\.1-essentials_build" -or $FinalEncoders -notmatch "(?m)^\s*V\S*\s+libx264\s") {
      throw "The installed FFmpeg baseline failed its final version or libx264 verification."
    }
  }
  catch {
    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    if ($HadDestination -and (Test-Path -LiteralPath $BackupPath)) {
      Move-Item -LiteralPath $BackupPath -Destination $Destination
    }
    throw
  }
  if (Test-Path -LiteralPath $BackupPath) {
    Remove-Item -LiteralPath $BackupPath -Recurse -Force
  }

  Write-Warning "Installed FFmpeg 9.0.1 essentials_build for development and CI only. Do not add this directory to application packages."
  Write-Host "Installed development FFmpeg at $Destination"
  Write-Host "Pinned FFmpeg source commit: $FfmpegSourceCommit"
  Write-Host "Distribution decision: docs/FFMPEG_DISTRIBUTION.md"
  Write-Verbose $BuildConfiguration
  Write-Verbose $FinalBuildConfiguration
}
finally {
  if (Test-Path -LiteralPath $WorkDirectory) {
    Remove-Item -LiteralPath $WorkDirectory -Recurse -Force
  }
}
