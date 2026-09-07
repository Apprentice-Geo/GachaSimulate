$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$UnpackedBin = Join-Path $ProjectRoot "dist/win-unpacked/resources/native/bin"
$Core = Join-Path $UnpackedBin "gachasimulate-core.exe"
$Analyzer = Join-Path $UnpackedBin "gachasimulate-analyze.exe"
$Installer = Join-Path $ProjectRoot "dist/GachaSimulate Setup $($Package.version).exe"

foreach ($Path in @($Core, $Analyzer, $Installer)) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing Windows package artifact: $Path"
  }
}
$NativeNames = @(Get-ChildItem -LiteralPath $UnpackedBin -File | ForEach-Object Name | Sort-Object)
$ExpectedNames = @("gachasimulate-analyze.exe", "gachasimulate-core.exe")
if (($NativeNames -join ',') -ne ($ExpectedNames -join ',')) {
  throw "Unexpected packaged native files: $($NativeNames -join ', ')."
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
