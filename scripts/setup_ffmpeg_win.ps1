$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

& (Join-Path $PSScriptRoot "acquire_ffmpeg_sources.ps1")

$lock = Get-Content (Join-Path $PSScriptRoot "ffmpeg_windows_source_lock.json") -Raw |
  ConvertFrom-Json
$inputs = Join-Path $PSScriptRoot "../tmp/ffmpeg-build-inputs"

& (Join-Path $PSScriptRoot "build_ffmpeg_win.ps1") `
  -X264Source (Join-Path $inputs "x264") `
  -FfmpegArchive (Join-Path $inputs $lock.ffmpeg.archive_name) `
  -ZlibArchive (Join-Path $inputs $lock.zlib.archive_name)
