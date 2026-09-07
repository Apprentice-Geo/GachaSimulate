param(
  [ValidateSet("Format", "Debug", "Tidy", "Release", "Full")]
  [string]$Task = "Full"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$CppRoot = Join-Path $ProjectRoot "cpp"
$DebugBuild = Join-Path $ProjectRoot "build/cpp/windows-debug"
$ReleaseBuild = Join-Path $ProjectRoot "build/cpp/windows-release"
$NativePrefix = Join-Path $ProjectRoot "build/native"

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function Assert-Ucrt64Toolchain {
  $Commands = @("cmake", "ninja", "g++")
  if ($Task -in @("Format", "Full")) { $Commands += "clang-format" }
  if ($Task -in @("Tidy", "Full")) { $Commands += "clang-tidy" }
  foreach ($Command in $Commands) {
    $ResolvedCommand = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $ResolvedCommand) {
      throw "Missing required UCRT64 command: $Command"
    }
    if ($ResolvedCommand.Source -notmatch '[\\/]ucrt64[\\/]bin[\\/]') {
      throw "$Command must come from MSYS2 UCRT64; got '$($ResolvedCommand.Source)'."
    }
  }
  $Compiler = (Get-Command g++).Source
  $Target = (& $Compiler -dumpmachine).Trim()
  if ($LASTEXITCODE -ne 0 -or $Target -ne "x86_64-w64-mingw32" -or $Compiler -notmatch '[\\/]ucrt64[\\/]bin[\\/]') {
    throw "g++ must come from MSYS2 UCRT64 and target x86_64-w64-mingw32; got '$Compiler' ($Target)."
  }
}

function Invoke-FormatCheck {
  $Files = @(Get-ChildItem (Join-Path $CppRoot "include"), (Join-Path $CppRoot "src"), (Join-Path $CppRoot "tests") `
      -Recurse -File -Include "*.cpp", "*.hpp" | ForEach-Object FullName)
  if ($Files.Count -eq 0) { throw "No C++ source files found." }
  Invoke-Checked clang-format --dry-run --Werror @Files
}

function Invoke-DebugCheck {
  Push-Location $CppRoot
  try {
    Invoke-Checked cmake --preset windows-debug
    Invoke-Checked cmake --build --preset windows-debug
    Invoke-Checked ctest --preset windows-debug
  } finally {
    Pop-Location
  }
}

function Invoke-TidyCheck {
  $Database = Join-Path $DebugBuild "compile_commands.json"
  if (-not (Test-Path -LiteralPath $Database -PathType Leaf)) {
    throw "Missing $Database. Run the Debug check first."
  }
  $Files = @(Get-ChildItem (Join-Path $CppRoot "src"), (Join-Path $CppRoot "tests") `
      -Recurse -File -Filter "*.cpp" | ForEach-Object FullName)
  foreach ($File in $Files) {
    Invoke-Checked -Command clang-tidy -Arguments @("--quiet", "-p", $DebugBuild, $File)
  }
}

function Invoke-IsolatedSmoke {
  param([Parameter(Mandatory)][string]$InstallPrefix)
  $SmokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gachasimulate-native-smoke-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $SmokeRoot | Out-Null
  $OriginalPath = $env:Path
  try {
    $Core = Join-Path $InstallPrefix "bin/gachasimulate-core.exe"
    $Analyzer = Join-Path $InstallPrefix "bin/gachasimulate-analyze.exe"
    Copy-Item -LiteralPath $Core, $Analyzer -Destination $SmokeRoot
    $env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
    Invoke-Checked (Join-Path $SmokeRoot "gachasimulate-core.exe") `
      --ir (Join-Path $CppRoot "tests/batch_fixture_ir.json") `
      --total-runs 10 --seed 0 --threads 1 --output (Join-Path $SmokeRoot "fixed.gsr")
    Invoke-Checked (Join-Path $SmokeRoot "gachasimulate-analyze.exe") `
      --input (Join-Path $SmokeRoot "fixed.gsr")
  } finally {
    $env:Path = $OriginalPath
    Remove-Item -LiteralPath $SmokeRoot -Recurse -Force
  }
}

function Invoke-ReleaseCheck {
  Push-Location $CppRoot
  try {
    Invoke-Checked cmake --preset windows-release
    Invoke-Checked cmake --build --preset windows-release
    Invoke-Checked ctest --preset windows-release
  } finally {
    Pop-Location
  }
  New-Item -ItemType Directory -Path $NativePrefix -Force | Out-Null
  $StagePrefix = Join-Path $NativePrefix (".install-" + [guid]::NewGuid().ToString("N"))
  $DestinationBin = Join-Path $NativePrefix "bin"
  $BackupBin = Join-Path $NativePrefix (".bin-backup-" + [guid]::NewGuid().ToString("N"))
  try {
    Invoke-Checked cmake --install $ReleaseBuild --prefix $StagePrefix
    $InstalledNames = @(Get-ChildItem (Join-Path $StagePrefix "bin") -File | ForEach-Object Name | Sort-Object)
    $ExpectedNames = @("gachasimulate-analyze.exe", "gachasimulate-core.exe")
    if (($InstalledNames -join ',') -ne ($ExpectedNames -join ',')) {
      throw "Unexpected native install files: $($InstalledNames -join ', ')."
    }
    Invoke-IsolatedSmoke -InstallPrefix $StagePrefix

    if (Test-Path -LiteralPath $DestinationBin) {
      Move-Item -LiteralPath $DestinationBin -Destination $BackupBin
    }
    try {
      Move-Item -LiteralPath (Join-Path $StagePrefix "bin") -Destination $DestinationBin
      if (Test-Path -LiteralPath $BackupBin) {
        Remove-Item -LiteralPath $BackupBin -Recurse -Force
      }
    } catch {
      if (Test-Path -LiteralPath $DestinationBin) {
        Remove-Item -LiteralPath $DestinationBin -Recurse -Force
      }
      if (Test-Path -LiteralPath $BackupBin) {
        Move-Item -LiteralPath $BackupBin -Destination $DestinationBin
      }
      throw
    }
  } finally {
    if (Test-Path -LiteralPath $StagePrefix) {
      Remove-Item -LiteralPath $StagePrefix -Recurse -Force
    }
  }
}

if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
  throw "C++ checks require Windows x64."
}
Assert-Ucrt64Toolchain

switch ($Task) {
  "Format" { Invoke-FormatCheck }
  "Debug" { Invoke-DebugCheck }
  "Tidy" { Invoke-TidyCheck }
  "Release" { Invoke-ReleaseCheck }
  "Full" {
    Invoke-FormatCheck
    Invoke-DebugCheck
    Invoke-TidyCheck
    Invoke-ReleaseCheck
  }
}
