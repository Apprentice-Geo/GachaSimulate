$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$UnpackedBin = Join-Path $ProjectRoot "dist/win-unpacked/resources/native/bin"
$UnpackedRoot = Join-Path $ProjectRoot "dist/win-unpacked"
$LicenseRoot = Join-Path $UnpackedRoot "resources/licenses"
$Core = Join-Path $UnpackedBin "gachasimulate-core.exe"
$Analyzer = Join-Path $UnpackedBin "gachasimulate-analyze.exe"
$ffmpeg = Join-Path $UnpackedRoot "resources/ffmpeg/bin/ffmpeg.exe"
$SourceFfmpeg = Join-Path $ProjectRoot "build/ffmpeg/win32-x64/bin/ffmpeg.exe"
$FfmpegLock = Get-Content -LiteralPath (Join-Path $ProjectRoot "build/ffmpeg/win32-x64/materials/source-lock.json") -Raw | ConvertFrom-Json
$Installer = Join-Path $ProjectRoot "dist/GachaSimulate Setup $($Package.version).exe"

foreach ($Path in @($Core, $Analyzer, $ffmpeg, $SourceFfmpeg, $Installer)) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing Windows package artifact: $Path"
  }
}
if ((Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $SourceFfmpeg -Algorithm SHA256).Hash) {
  throw "Packaged FFmpeg differs from the self-built source binary: $SourceFfmpeg"
}
$NativeNames = @(Get-ChildItem -LiteralPath $UnpackedBin -File | ForEach-Object Name | Sort-Object)
$ExpectedNames = @("gachasimulate-analyze.exe", "gachasimulate-core.exe")
if (($NativeNames -join ',') -ne ($ExpectedNames -join ',')) {
  throw "Unexpected packaged native files: $($NativeNames -join ', ')."
}

& node (Join-Path $PSScriptRoot "application_licenses.mjs") --verify $LicenseRoot
if ($LASTEXITCODE -ne 0) { throw "Packaged application license verification failed." }

foreach ($ElectronNotice in @("LICENSE.electron.txt", "LICENSES.chromium.html")) {
  $Notice = Join-Path $UnpackedRoot $ElectronNotice
  if (-not (Test-Path -LiteralPath $Notice -PathType Leaf) -or (Get-Item -LiteralPath $Notice).Length -eq 0) {
    throw "Missing Electron/Chromium license material: $Notice"
  }
}

$SmokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gachasimulate-package-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $SmokeRoot | Out-Null
$OriginalPath = $env:Path
try {
  $env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
  $FfmpegVersion = & $ffmpeg -version 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Packaged FFmpeg smoke failed with exit code $LASTEXITCODE`:`n$FfmpegVersion" }
  $ExpectedFfmpegVersion = [regex]::Escape($FfmpegLock.ffmpeg.version)
  if ($FfmpegVersion -notmatch "(?m)^ffmpeg version $ExpectedFfmpegVersion(?:[\s-]|$)") {
    throw "Packaged FFmpeg reports an unexpected version: $FfmpegVersion"
  }
  & $Core --ir (Join-Path $ProjectRoot "cpp/tests/batch_fixture_ir.json") `
    --total-runs 10 --seed 0 --threads 1 --output (Join-Path $SmokeRoot "fixed.gsr")
  if ($LASTEXITCODE -ne 0) { throw "Packaged core smoke failed with exit code $LASTEXITCODE." }
  & $Analyzer --input (Join-Path $SmokeRoot "fixed.gsr")
  if ($LASTEXITCODE -ne 0) { throw "Packaged analyzer smoke failed with exit code $LASTEXITCODE." }
} finally {
  $env:Path = $OriginalPath
  Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
}
