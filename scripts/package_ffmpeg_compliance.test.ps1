$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path (Join-Path $root 'tmp/ffmpeg-verification') ('package-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$copy = Join-Path $testRoot 'build'
Copy-Item -LiteralPath (Join-Path $root 'build/ffmpeg/win32-x64') -Destination $copy -Recurse
$output = Join-Path $testRoot 'dist'
$script = Join-Path $root 'scripts/package_ffmpeg_compliance.ps1'
$installerFixture = Join-Path $testRoot 'installer-fixture.exe'
'Packaging association fixture, not an executable installer.' | Set-Content $installerFixture
& $script -BuildRoot $copy -OutputDirectory $output -Installer $installerFixture
$zip = Get-ChildItem $output -Filter '*.zip' | Select-Object -First 1
$originalZipHash = (Get-FileHash $zip.FullName).Hash
function Assert-Rejected([string]$relative, [string]$replacement, [string]$expected) {
  $path = Join-Path $copy $relative
  $bytes = [IO.File]::ReadAllBytes($path)
  try {
    [IO.File]::WriteAllText($path, $replacement)
    $rejected = $false
    try { & $script -BuildRoot $copy -OutputDirectory $output } catch {
      if ($_.Exception.Message -notmatch $expected) { throw }
      $rejected = $true
    }
    if (-not $rejected) { throw "Accepted invalid material: $relative" }
    if ((Get-FileHash $zip.FullName).Hash -ne $originalZipHash) { throw 'Failed packaging replaced previous ZIP.' }
  } finally { [IO.File]::WriteAllBytes($path, $bytes) }
}
Assert-Rejected 'bin/ffmpeg.exe' 'corrupt' 'Binary does not match'
Assert-Rejected 'materials/sources/x264.bundle' 'corrupt' 'Archived source changed'
Assert-Rejected 'materials/source-sha256.txt' '' 'Incomplete source hash'
Assert-Rejected 'materials/ffmpeg-buildconf.txt' '--enable-nonfree --enable-gpl --enable-libx264' 'Unexpected FFmpeg license'
$license = Join-Path $copy 'materials/licenses/ffmpeg-COPYING.GPLv2'
Move-Item -LiteralPath $license -Destination "$license.saved"
try {
  $rejected = $false
  try { & $script -BuildRoot $copy -OutputDirectory $output } catch {
    if ($_.Exception.Message -notmatch 'Missing FFmpeg material') { throw }
    $rejected = $true
  }
  if (-not $rejected) { throw 'Accepted missing GPL license.' }
} finally { Move-Item -LiteralPath "$license.saved" -Destination $license }
# Authorized best-effort runtime notices remain visible in the released manifest.
'Fixture: unavailable optional runtime notice' | Set-Content (Join-Path $copy 'materials/license-gaps.txt')
& $script -BuildRoot $copy -OutputDirectory $output -Installer $installerFixture
$extracted = Join-Path $testRoot 'extracted'
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $extracted
$manifest = Get-Content (Join-Path $extracted 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.runtime_notice_gaps.Count -ne 1) { throw 'Missing runtime gap disclosure.' }
if ($manifest.installer.sha256 -ne (Get-FileHash $installerFixture).Hash.ToLowerInvariant()) { throw 'Incorrect installer association.' }
foreach ($line in Get-Content (Join-Path $extracted 'SHA256SUMS')) {
  if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid checksum format.' }
  if ((Get-FileHash -LiteralPath (Join-Path $extracted $Matches[2])).Hash.ToLowerInvariant() -ne $Matches[1]) { throw 'ZIP payload checksum mismatch.' }
}
Write-Output "PASS: valid ZIP and payload checksums; five rejection cases; previous ZIP preserved; runtime gaps disclosed. Evidence: $testRoot"
