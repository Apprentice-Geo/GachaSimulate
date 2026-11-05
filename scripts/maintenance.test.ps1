$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-TestFunction([string]$Script, [string]$Name) {
  $Ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $Script), [ref]$null, [ref]$null)
  $Definition = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name }, $true)
  if (-not $Definition) { throw "Missing function $Name in $Script." }
  return $Definition.Extent.Text
}

$ReleaseFunction = Read-TestFunction 'check_cpp_win.ps1' 'Invoke-ReleaseCheck'
foreach ($Scenario in @('success', 'replace-failed', 'cleanup-failed')) {
  & {
    param($Scenario, $Definition)
    Invoke-Expression $Definition
    $CppRoot = 'D:\maintenance-test\cpp'
    $ReleaseBuild = 'D:\maintenance-test\release'
    $NativePrefix = 'D:\maintenance-test\native'
    $Destination = Join-Path $NativePrefix 'bin'
    # Filesystem and build commands are simulated; no real install is changed.
    $script:Files = @{ $Destination = 'old-complete' }
    $script:Warnings = @()
    function Push-Location {}
    function Pop-Location {}
    function New-Item {}
    function Invoke-Checked {}
    function Invoke-IsolatedSmoke {}
    function Get-ChildItem {
      [pscustomobject]@{ Name = 'gachasimulate-analyze.exe' }
      [pscustomobject]@{ Name = 'gachasimulate-core.exe' }
    }
    function Test-Path { param($LiteralPath) return $script:Files.ContainsKey($LiteralPath) }
    function Write-Warning { param($Message) $script:Warnings += $Message }
    function Move-Item {
      param($LiteralPath, $Destination)
      if ($LiteralPath -match '\.install-.*[\\/]bin$') {
        if ($Scenario -eq 'replace-failed') { throw 'injected replace failure' }
        $script:Files[$Destination] = 'new-validated'
      } else {
        $script:Files[$Destination] = $script:Files[$LiteralPath]
        $script:Files.Remove($LiteralPath) | Out-Null
      }
    }
    function Remove-Item {
      param($LiteralPath, [switch]$Recurse, [switch]$Force)
      if ($Scenario -eq 'cleanup-failed' -and $LiteralPath -match '\.bin-backup-') {
        $script:Files[$LiteralPath] = 'old-partially-deleted'
        throw 'injected backup cleanup failure'
      }
      $script:Files.Remove($LiteralPath) | Out-Null
    }
    $Failure = $null
    try { Invoke-ReleaseCheck } catch { $Failure = $_ }
    if ($Scenario -eq 'replace-failed') {
      if (-not $Failure -or $script:Files[$Destination] -ne 'old-complete') { throw 'Failed replacement did not preserve the old install.' }
    } else {
      if ($Failure -or $script:Files[$Destination] -ne 'new-validated') { throw 'A committed install was lost.' }
      if ($Scenario -eq 'cleanup-failed' -and $script:Warnings.Count -ne 1) { throw 'Cleanup failure was not reported.' }
    }
    Write-Output "PASS native install: $Scenario"
  } $Scenario $ReleaseFunction
}

$IsolatedFunction = Read-TestFunction 'build_ffmpeg_win.ps1' 'Assert-IsolatedExecution'
& {
  param($Definition)
  Invoke-Expression $Definition
  function New-Item {}
  function Copy-Item {}
  function Push-Location {}
  function Pop-Location {}
  function Test-Path { return $false }
  function Invoke-CheckedNative {
    param($Executable, $Arguments, $Description)
    $Program = [IO.Path]::GetFileNameWithoutExtension($Executable)
    return "$Program version $ReportedVersion custom-build"
  }
  $ReportedVersion = '12.34.5-test'
  Assert-IsolatedExecution -BinPath 'D:\maintenance-test\bin' -Version '12.34.5'
  $ReportedVersion = '12.34.6'
  $Rejected = $false
  try { Assert-IsolatedExecution -BinPath 'D:\maintenance-test\bin' -Version '12.34.5' } catch { $Rejected = $true }
  if (-not $Rejected) { throw 'Unexpected FFmpeg version was accepted.' }
  Write-Output 'PASS FFmpeg version follows the supplied source identity'
} $IsolatedFunction

$SetupSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'setup_ffmpeg_win.ps1') -Raw
$LockText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ffmpeg_windows_source_lock.json') -Raw
foreach ($Scenario in @('acquire-failed', 'build-failed', 'success')) {
  & {
    param($Scenario, $Source, $LockText)
    $script:Calls = @()
    function Join-Path {
      param($Path, $ChildPath)
      if ($ChildPath -eq 'acquire_ffmpeg_sources.ps1') { return 'Invoke-TestAcquire' }
      if ($ChildPath -eq 'build_ffmpeg_win.ps1') { return 'Invoke-TestBuild' }
      if (-not $Path) { $Path = 'D:\maintenance-test\scripts' }
      return Microsoft.PowerShell.Management\Join-Path $Path $ChildPath
    }
    function Get-Content { return $LockText }
    function Invoke-TestAcquire {
      $script:Calls += 'acquire'
      if ($Scenario -eq 'acquire-failed') { throw 'injected acquire failure' }
    }
    function Invoke-TestBuild {
      $script:Calls += 'build'
      if ($Scenario -eq 'build-failed') { throw 'injected build failure' }
    }
    $Failure = $null
    try { Invoke-Expression $Source } catch { $Failure = $_ }
    $Expected = if ($Scenario -eq 'acquire-failed') { 'acquire' } else { 'acquire,build' }
    if (($script:Calls -join ',') -ne $Expected) { throw "Unexpected setup calls '$($script:Calls -join ',')' for $Scenario; failure: $Failure" }
    if (($null -eq $Failure) -ne ($Scenario -eq 'success')) { throw 'Setup did not propagate failure.' }
    Write-Output "PASS FFmpeg setup: $Scenario"
  } $Scenario $SetupSource $LockText
}
