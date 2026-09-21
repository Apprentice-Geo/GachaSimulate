[CmdletBinding()]
param(
  [string]$BuildRoot = (Join-Path $PSScriptRoot "../build/ffmpeg/win32-x64"),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "../dist"),
  [string]$Installer
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Version = (Get-Content -Raw (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json).version
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw "Invalid application version." }
$Materials = Join-Path $BuildRoot "materials"
$Required = @(
  "README.md", "source-lock.json", "sources.json", "patches.json", "source-sha256.txt",
  "sources/x264.bundle", "x264-origin-master.txt", "binary-sha256.txt",
  "ffmpeg-link.map", "ffprobe-link.map", "ffmpeg-pe-imports.txt", "ffprobe-pe-imports.txt",
  "ffmpeg-buildconf.txt",
  "msys2-package-snapshot.json", "tool-versions.tsv", "build.log",
  "licenses/zlib-LICENSE", "licenses/x264-COPYING", "licenses/ffmpeg-COPYING.GPLv2",
  "licenses/ffmpeg-COPYING.LGPLv2.1", "licenses/ffmpeg-LICENSE.md",
  "build-scripts/scripts/build_ffmpeg_win.ps1", "build-scripts/scripts/build_ffmpeg_win_ucrt64.sh",
  "build-scripts/scripts/ffmpeg_windows_source_lock.json", "build-scripts/LICENSE.txt"
)
foreach ($Relative in $Required) {
  if (-not (Test-Path -LiteralPath (Join-Path $Materials $Relative) -PathType Leaf)) {
    throw "Missing FFmpeg material: $Relative"
  }
}
$Lock = Get-Content -Raw (Join-Path $Materials "source-lock.json") | ConvertFrom-Json
foreach ($Component in @($Lock.zlib, $Lock.ffmpeg)) {
  $SourceFile = Join-Path $Materials "sources/$($Component.archive_name)"
  if ((Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Component.archive_sha256) {
    throw "Source archive hash mismatch: $($Component.archive_name)"
  }
}
$SourceNames = @()
foreach ($Line in Get-Content (Join-Path $Materials "source-sha256.txt")) {
  if ($Line -notmatch '^([a-f0-9]{64}) [ *]([A-Za-z0-9._-]+)$') { throw "Invalid source hash record." }
  $SourceNames += $Matches[2]
  if ((Get-FileHash -LiteralPath (Join-Path $Materials "sources/$($Matches[2])") -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Matches[1]) {
    throw "Archived source changed since build."
  }
}
if ((($SourceNames | Sort-Object) -join ',') -ne ((@($Lock.zlib.archive_name, $Lock.ffmpeg.archive_name, 'x264.bundle') | Sort-Object) -join ',')) {
  throw "Incomplete source hash record."
}
$BuildConf = Get-Content -Raw (Join-Path $Materials "ffmpeg-buildconf.txt")
if ($BuildConf -match '--enable-nonfree' -or $BuildConf -notmatch '--enable-gpl' -or $BuildConf -notmatch '--enable-libx264') {
  throw "Unexpected FFmpeg license configuration."
}
$Binaries = [ordered]@{}
foreach ($Name in @("ffmpeg.exe", "ffprobe.exe")) {
  $Hash = (Get-FileHash -LiteralPath (Join-Path $BuildRoot "bin/$Name") -Algorithm SHA256).Hash.ToLowerInvariant()
  $BinaryRecords = Get-Content (Join-Path $Materials "binary-sha256.txt")
  if (-not ($BinaryRecords -contains "$Hash  $Name" -or $BinaryRecords -contains "$Hash *$Name")) {
    throw "Binary does not match build materials: $Name"
  }
  $Binaries[$Name] = $Hash
}
$Commit = & git -C $ProjectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Cannot identify project commit." }
$Dirty = & git -C $ProjectRoot status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect project worktree." }
$Manifest = [ordered]@{
  schema_version = 1
  scope = "FFmpeg, x264 and zlib; not whole-application compliance"
  application_version = $Version
  project_commit = $Commit.Trim()
  project_worktree_dirty = [bool]$Dirty
  platform = "windows-x64"
  source_lock = $Lock
  binaries_sha256 = $Binaries
}
if ($Installer) {
  $Manifest.installer = [ordered]@{
    name = [IO.Path]::GetFileName($Installer)
    sha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$Stage = Join-Path $OutputDirectory (".ffmpeg-compliance-" + [guid]::NewGuid().ToString("N"))
$Archive = Join-Path $OutputDirectory "GachaSimulate-v$Version-windows-x64-ffmpeg-compliance.zip"
try {
  New-Item -ItemType Directory -Path $Stage | Out-Null
  Copy-Item -Path (Join-Path $Materials "*") -Destination $Stage -Recurse
  # Packaging-time reader instructions can improve without rebuilding binaries.
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "ffmpeg_compliance_README.md") -Destination (Join-Path $Stage "README.md") -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "ffmpeg_compliance_README.md") -Destination (Join-Path $Stage "build-scripts/scripts/ffmpeg_compliance_README.md") -Force
  $Manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Stage "manifest.json") -Encoding utf8
  $Checksums = foreach ($File in Get-ChildItem -LiteralPath $Stage -Recurse -File | Sort-Object FullName) {
    $Relative = [IO.Path]::GetRelativePath($Stage, $File.FullName).Replace('\', '/')
    "$((Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $Relative"
  }
  $Checksums | Set-Content -LiteralPath (Join-Path $Stage "SHA256SUMS") -Encoding utf8
  Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath "$Stage.zip"
  Move-Item -LiteralPath "$Stage.zip" -Destination $Archive -Force
  "$((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($Archive))" |
    Set-Content -LiteralPath "$Archive.sha256" -Encoding utf8
  Write-Output $Archive
}
finally {
  # Only the unique, verified child of the requested output directory is removed.
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Stage)) -ne $OutputDirectory) { throw "Unsafe staging path." }
  if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
  if (Test-Path -LiteralPath "$Stage.zip") { Remove-Item -LiteralPath "$Stage.zip" -Force }
}
