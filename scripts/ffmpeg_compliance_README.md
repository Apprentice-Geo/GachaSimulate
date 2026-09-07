# FFmpeg source and build materials

This archive covers the project's separately built FFmpeg/ffprobe and their
zlib/x264 dependencies. It is not a license inventory for the whole application.
FFmpeg is built with GPL components (`--enable-gpl`, libx264), without nonfree
components. Preserve the original copyright and license notices in `licenses/`
and in the source trees. The project's build scripts are Apache-2.0 licensed.

`source-lock.json` identifies the fixed upstream sources. `sources/` contains
the original FFmpeg and zlib archives and a self-contained x264 Git bundle,
including the history used by its version script. `patches.json` records local
source modifications (empty lists mean none). No MSYS2 zlib package is used.

## Offline rebuild on Windows x64

Prepare MSYS2 UCRT64 with bash, tar, xz, make, git, and UCRT64 gcc, binutils,
pkgconf and nasm. Package dependencies supply the CRT, headers and runtime
libraries. See `installed-package-versions.json`, `msys2-package-snapshot.json`
and `tool-versions.tsv` for this build's actual environment. Preparing the
toolchain can require network access; the build entry does not use the network.

From this extracted archive in PowerShell 7, restore x264 using MSYS2 Git:

```powershell
$lock = Get-Content source-lock.json -Raw | ConvertFrom-Json
$env:PATH = "C:\msys64\ucrt64\bin;C:\msys64\usr\bin;$env:PATH"
& C:\msys64\usr\bin\git.exe clone sources/x264.bundle x264
& C:\msys64\usr\bin\git.exe -C x264 update-ref refs/remotes/origin/master (Get-Content x264-origin-master.txt)
& C:\msys64\usr\bin\git.exe -C x264 checkout --detach $lock.x264.commit
pwsh -NoProfile -File build-scripts/scripts/build_ffmpeg_win.ps1 `
  -X264Source (Resolve-Path x264) `
  -FfmpegArchive (Resolve-Path "sources/$($lock.ffmpeg.archive_name)") `
  -ZlibArchive (Resolve-Path "sources/$($lock.zlib.archive_name)")
```

Use `-MsysRoot` if MSYS2 is installed elsewhere. Output is written under
`build-scripts/build/ffmpeg/win32-x64`. Paths recorded in logs refer to the
original machine; the scripts generate fresh paths. Rebuilding identical bytes
is not promised, especially with a different rolling toolchain.

## Records and scope

`manifest.json` associates this collection with the application version,
source commit, and binary hashes. If an installer is supplied when packaging,
its hash is included; this alone does not assert that it contains FFmpeg.
`SHA256SUMS` covers the files in this collection except itself.

The two `*-link.map` files record static archive members/startup objects;
`*-pe-imports.txt` records imported DLLs. The local runtime license collections
are intentionally copied in full. Inclusion of a notice is not a claim that
every library in that package was linked. `license-gaps.txt` reports any missing
runtime collections; it is not a complete automated legal review.

The Windows system DLLs are not included. GCC/build-tool source and MSYS2
packaging recipes are not included. This material collection is not a legal
certification or a patent license.
