[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "../tmp/ffmpeg-build-inputs"),
  [string]$MsysRoot = "C:\msys64"
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Lock = Get-Content -Raw (Join-Path $PSScriptRoot "ffmpeg_windows_source_lock.json") | ConvertFrom-Json
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
foreach ($Item in @(
  @{ Source = $Lock.ffmpeg; Base = "https://ffmpeg.org/releases" },
  @{ Source = $Lock.zlib; Base = "https://github.com/madler/zlib/releases/download/v$($Lock.zlib.version)" }
)) {
  $Destination = Join-Path $OutputDirectory $Item.Source.archive_name
  if (-not (Test-Path -LiteralPath $Destination)) {
    $Partial = "$Destination.$([guid]::NewGuid().ToString('N')).partial"
    try {
      Write-Host "Acquiring $($Item.Source.archive_name)"
      Invoke-WebRequest -Uri "$($Item.Base)/$($Item.Source.archive_name)" -OutFile $Partial -MaximumRetryCount 3 -TimeoutSec 120
      if ((Get-FileHash -LiteralPath $Partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Item.Source.archive_sha256) {
        throw "Downloaded source hash mismatch: $Destination"
      }
      Move-Item -LiteralPath $Partial -Destination $Destination
    }
    finally {
      if (Test-Path -LiteralPath $Partial) { Remove-Item -LiteralPath $Partial }
    }
  }
  if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Item.Source.archive_sha256) {
    throw "Cached source hash mismatch: $Destination"
  }
}
$Git = Join-Path $MsysRoot "usr/bin/git.exe"
$X264 = Join-Path $OutputDirectory "x264"
$PreviousPath = $env:PATH
try {
  $env:PATH = "$(Join-Path $MsysRoot 'ucrt64/bin');$(Join-Path $MsysRoot 'usr/bin');$PreviousPath"
  if (-not (Test-Path -LiteralPath $X264)) {
    & $Git clone https://code.videolan.org/videolan/x264.git $X264
    if ($LASTEXITCODE -ne 0) { throw "Cannot acquire x264." }
    & $Git -C $X264 checkout --detach $Lock.x264.commit
    if ($LASTEXITCODE -ne 0) { throw "Cannot check out pinned x264." }
  }
  # Existing input trees are validated, never reset or updated automatically.
  $Head = & $Git -C $X264 rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $Head -ne $Lock.x264.commit) { throw "Cached x264 is not at the pinned commit." }
  $Status = & $Git -C $X264 status --porcelain=v1 --untracked-files=normal
  if ($LASTEXITCODE -ne 0 -or $Status) { throw "Cached x264 is not clean." }
}
finally { $env:PATH = $PreviousPath }
Write-Output $OutputDirectory
