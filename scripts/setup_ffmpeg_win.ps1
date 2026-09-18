pwsh -NoProfile -File scripts/acquire_ffmpeg_sources.ps1

$lock = Get-Content scripts/ffmpeg_windows_source_lock.json -Raw |
  ConvertFrom-Json

pwsh -NoProfile -File scripts/build_ffmpeg_win.ps1 `
  -X264Source "tmp/ffmpeg-build-inputs/x264" `
  -FfmpegArchive "tmp/ffmpeg-build-inputs/$($lock.ffmpeg.archive_name)" `
  -ZlibArchive "tmp/ffmpeg-build-inputs/$($lock.zlib.archive_name)"