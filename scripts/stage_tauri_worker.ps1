[CmdletBinding()]
param(
  [ValidateSet("release", "debug")]
  [string]$Profile = "release"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$TargetTriple = "x86_64-pc-windows-msvc"

Push-Location $ProjectRoot
try {
  $CargoArgs = @("build", "-p", "gachasimulate-host", "--bin", "gachasimulate-worker")
  if ($Profile -eq "release") {
    $CargoArgs += "--release"
  }
  & cargo @CargoArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build gachasimulate-worker ($Profile)."
  }

  $Source = Join-Path $ProjectRoot "target/$Profile/gachasimulate-worker.exe"
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Built worker binary not found at $Source"
  }

  $BinDir = Join-Path $ProjectRoot "src-tauri/bin"
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $Destination = Join-Path $BinDir "gachasimulate-worker-$TargetTriple.exe"
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  Write-Output "Staged Tauri sidecar worker: $Destination"
}
finally {
  Pop-Location
}
