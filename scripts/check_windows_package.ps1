$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$UnpackedBin = Join-Path $ProjectRoot "dist/win-unpacked/resources/native/bin"
$UnpackedRoot = Join-Path $ProjectRoot "dist/win-unpacked"
$LicenseRoot = Join-Path $UnpackedRoot "resources/licenses"
$Core = Join-Path $UnpackedBin "gachasimulate-core.exe"
$Analyzer = Join-Path $UnpackedBin "gachasimulate-analyze.exe"
$ffmpeg = Join-Path $UnpackedRoot "resources/ffmpeg/bin/ffmpeg.exe"
$Installer = Join-Path $ProjectRoot "dist/GachaSimulate Setup $($Package.version).exe"

foreach ($Path in @($Core, $Analyzer, $ffmpeg, $Installer)) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing Windows package artifact: $Path"
  }
}
$NativeNames = @(Get-ChildItem -LiteralPath $UnpackedBin -File | ForEach-Object Name | Sort-Object)
$ExpectedNames = @("gachasimulate-analyze.exe", "gachasimulate-core.exe")
if (($NativeNames -join ',') -ne ($ExpectedNames -join ',')) {
  throw "Unexpected packaged native files: $($NativeNames -join ', ')."
}

$LicenseMappings = @{
  "JetBrainsMono-OFL-1.1.txt" = "third_party/licenses/JetBrainsMono-OFL-1.1.txt"
  "JetBrainsMono-AUTHORS.txt" = "third_party/licenses/JetBrainsMono-AUTHORS.txt"
  "LICENSE.txt" = "LICENSE.txt"
  "THIRD_PARTY_NOTICES.md" = "THIRD_PARTY_NOTICES.md"
  "SourceHanSansSC-OFL-1.1.txt" = "third_party/licenses/SourceHanSansSC-OFL-1.1.txt"
  "nlohmann-json-3.11.3-MIT.txt" = "third_party/licenses/nlohmann-json-3.11.3-MIT.txt"
  "victory-vendor-37.3.6.txt" = "third_party/licenses/victory-vendor-37.3.6.txt"
}
foreach ($Entry in $LicenseMappings.GetEnumerator()) {
  $Packaged = Join-Path $LicenseRoot $Entry.Key
  $Source = Join-Path $ProjectRoot $Entry.Value
  if (-not (Test-Path -LiteralPath $Packaged -PathType Leaf) -or (Get-Item -LiteralPath $Packaged).Length -eq 0) {
    throw "Missing or empty packaged license material: $Packaged"
  }
  if ((Get-FileHash -LiteralPath $Packaged -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash) {
    throw "Packaged license material differs from repository source: $($Entry.Key)"
  }
}

$NpmLicenses = Join-Path $LicenseRoot "THIRD_PARTY_LICENSES.txt"
if (-not (Test-Path -LiteralPath $NpmLicenses -PathType Leaf) -or (Get-Item -LiteralPath $NpmLicenses).Length -eq 0) {
  throw "Missing or empty packaged npm license inventory: $NpmLicenses"
}
$NpmLicenseText = Get-Content -LiteralPath $NpmLicenses -Raw
foreach ($Dependency in @("ajv@", "lucide-react@", "react@", "react-dom@", "recharts@", "victory-vendor@37.3.6", "yaml@", "yauzl@")) {
  if (-not $NpmLicenseText.Contains($Dependency)) {
    throw "Packaged npm license inventory is missing $Dependency."
  }
}
if ($NpmLicenseText.Contains($ProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Packaged npm license inventory exposes the workspace path."
}

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
  & $Core --ir (Join-Path $ProjectRoot "cpp/tests/batch_fixture_ir.json") `
    --total-runs 10 --seed 0 --threads 1 --output (Join-Path $SmokeRoot "fixed.gsr")
  if ($LASTEXITCODE -ne 0) { throw "Packaged core smoke failed with exit code $LASTEXITCODE." }
  & $Analyzer --input (Join-Path $SmokeRoot "fixed.gsr")
  if ($LASTEXITCODE -ne 0) { throw "Packaged analyzer smoke failed with exit code $LASTEXITCODE." }
} finally {
  $env:Path = $OriginalPath
  Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
}
