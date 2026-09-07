#!/usr/bin/env bash
set -euo pipefail

export PATH=/ucrt64/bin:/usr/bin
export LC_ALL=C
export TZ=UTC
unset CDPATH CFLAGS CPPFLAGS CXXFLAGS LDFLAGS LIBS MAKEFLAGS MFLAGS
unset CONFIG_SITE GIT_DIR GIT_WORK_TREE PKG_CONFIG_LIBDIR PKG_CONFIG_SYSROOT_DIR

if [[ "${MSYSTEM:-}" != "UCRT64" ]]; then
  printf 'Expected MSYSTEM=UCRT64, got %s. Run through scripts/build_ffmpeg_win.ps1.\n' "${MSYSTEM:-<unset>}" >&2
  exit 2
fi

for variable in GS_PROJECT_ROOT GS_X264_SOURCE GS_FFMPEG_ARCHIVE GS_ZLIB_ARCHIVE GS_ZLIB_VERSION GS_WORK_ROOT GS_STAGE_ROOT GS_JOBS; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'Required environment variable %s is missing.\n' "$variable" >&2
    exit 2
  fi
done

project_root="$(cygpath -u "$GS_PROJECT_ROOT")"
x264_source="$(cygpath -u "$GS_X264_SOURCE")"
ffmpeg_archive="$(cygpath -u "$GS_FFMPEG_ARCHIVE")"
zlib_archive="$(cygpath -u "$GS_ZLIB_ARCHIVE")"
work_root="$(cygpath -u "$GS_WORK_ROOT")"
stage_root="$(cygpath -u "$GS_STAGE_ROOT")"
jobs="$GS_JOBS"
private_prefix="$work_root/prefix"
materials="$stage_root/materials"

mkdir -p "$work_root" "$stage_root/bin" "$materials/licenses" "$materials/sources" "$materials/build-scripts/scripts"
exec > >(tee "$materials/build.log") 2>&1

printf 'Building pinned FFmpeg for Windows x64 in MSYS2 UCRT64.\n'
printf 'x264 source: %s\nFFmpeg archive: %s\n' "$x264_source" "$ffmpeg_archive"

required_tools=(ar gcc git ld make nasm objdump pkgconf ranlib sha256sum strip tar)
for tool in "${required_tools[@]}"; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required UCRT64 build tool is missing from /ucrt64/bin or /usr/bin: %s\n' "$tool" >&2
    exit 2
  fi
done

if [[ "$(git -C "$x264_source" rev-parse HEAD)" != "${GS_X264_COMMIT}" ]]; then
  printf 'x264 HEAD changed after PowerShell preflight. Expected %s.\n' "$GS_X264_COMMIT" >&2
  exit 2
fi
if [[ -n "$(git -C "$x264_source" status --porcelain=v1 --untracked-files=normal)" ]]; then
  printf 'x264 worktree changed after PowerShell preflight; refusing to build.\n' >&2
  exit 2
fi

{
  printf 'gcc\t'; gcc --version | sed -n '1p'
  printf 'ld\t'; ld --version | sed -n '1p'
  printf 'make\t'; make --version | sed -n '1p'
  printf 'pkgconf\t'; pkgconf --version
  printf 'nasm\t'; nasm -v
  printf 'git\t'; git --version
  printf 'bash\t%s\n' "$BASH_VERSION"
} > "$materials/tool-versions.tsv"

# Archive actual inputs before building. A bundle preserves x264's Git version
# metadata and allows the existing clean-worktree build entry to work offline.
cp "$ffmpeg_archive" "$zlib_archive" "$materials/sources/"
git -C "$x264_source" bundle create "$materials/sources/x264.bundle" HEAD refs/remotes/origin/master
git -C "$x264_source" rev-parse refs/remotes/origin/master > "$materials/x264-origin-master.txt"
(
  cd "$materials/sources"
  sha256sum * > "$materials/source-sha256.txt"
)
cp "$project_root/scripts/build_ffmpeg_win.ps1" "$project_root/scripts/build_ffmpeg_win_ucrt64.sh" \
  "$project_root/scripts/ffmpeg_windows_source_lock.json" "$project_root/scripts/ffmpeg_compliance_README.md" "$materials/build-scripts/scripts/"
cp "$project_root/LICENSE.txt" "$materials/build-scripts/LICENSE.txt"
cp "$project_root/scripts/ffmpeg_compliance_README.md" "$materials/README.md"

mkdir -p "$work_root/zlib-source"
tar -xJf "$zlib_archive" -C "$work_root/zlib-source"
zlib_source="$work_root/zlib-source/zlib-${GS_ZLIB_VERSION}"
printf '%s\n' 'CHOST=x86_64-w64-mingw32' 'CFLAGS=-O2' '--static' "--prefix=$private_prefix" > "$materials/zlib-configure-args.txt"
(
  cd "$zlib_source"
  CHOST=x86_64-w64-mingw32 CFLAGS=-O2 ./configure --static "--prefix=$private_prefix"
  make -j"$jobs"
  make check
  make install
)
test -f "$private_prefix/lib/libz.a"
cp "$zlib_source/LICENSE" "$materials/licenses/zlib-LICENSE"

ffmpeg_source_parent="$work_root/ffmpeg-source"
mkdir -p "$ffmpeg_source_parent"
tar -xJf "$ffmpeg_archive" -C "$ffmpeg_source_parent"
ffmpeg_source="$ffmpeg_source_parent/ffmpeg-${GS_FFMPEG_VERSION}"
if [[ ! -x "$ffmpeg_source/configure" ]]; then
  printf 'Archive did not contain the expected ffmpeg-%s/configure tree.\n' "$GS_FFMPEG_VERSION" >&2
  exit 2
fi

x264_build="$work_root/x264-build"
mkdir -p "$x264_build"
x264_configure=(
  "$x264_source/configure"
  "--host=x86_64-w64-mingw32"
  "--prefix=$private_prefix"
  "--enable-static"
  "--disable-cli"
  "--disable-opencl"
  "--bit-depth=8"
  "--extra-cflags=-O2"
  "--extra-ldflags=-static"
)
printf '%s\n' "${x264_configure[@]:1}" > "$materials/x264-configure-args.txt"
(
  cd "$x264_build"
  "${x264_configure[@]}"
  make -j"$jobs"
  make install
)
if [[ ! -f "$private_prefix/lib/libx264.a" || ! -f "$private_prefix/lib/pkgconfig/x264.pc" ]]; then
  printf 'x264 did not install the expected static library and pkg-config file.\n' >&2
  exit 2
fi

ffmpeg_build="$work_root/ffmpeg-build"
mkdir -p "$ffmpeg_build"
export PKG_CONFIG_PATH="$private_prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$private_prefix/lib/pkgconfig"
test "$(cygpath -u "$(pkgconf --variable=libdir zlib)")" = "$private_prefix/lib"
ffmpeg_configure=(
  "$ffmpeg_source/configure"
  "--prefix=$private_prefix"
  "--arch=x86_64"
  "--target-os=mingw32"
  "--cc=gcc"
  "--pkg-config=pkgconf"
  "--pkg-config-flags=--static"
  "--extra-cflags=-I$private_prefix/include -O2"
  "--extra-ldflags=-L$private_prefix/lib -static -Wl,-Map=%.map"
  "--enable-gpl"
  "--enable-static"
  "--disable-shared"
  "--disable-autodetect"
  "--disable-everything"
  "--disable-debug"
  "--disable-doc"
  "--disable-ffplay"
  "--disable-avdevice"
  "--disable-swresample"
  "--disable-network"
  "--disable-devices"
  "--disable-hwaccels"
  "--disable-iconv"
  "--disable-pthreads"
  "--enable-w32threads"
  "--enable-ffmpeg"
  "--enable-ffprobe"
  "--enable-zlib"
  "--enable-libx264"
  "--enable-decoder=png,h264"
  "--enable-encoder=libx264"
  "--enable-demuxer=image2pipe,mov"
  "--enable-muxer=mp4"
  "--enable-protocol=file,pipe"
  "--enable-parser=png,h264"
  "--enable-filter=buffer,buffersink,format,scale"
  "--enable-swscale"
)
printf '%s\n' "${ffmpeg_configure[@]:1}" > "$materials/ffmpeg-configure-args.txt"
(
  cd "$ffmpeg_build"
  "${ffmpeg_configure[@]}"
  # GNU ld uses the output filename for separate maps, including parallel links.
  make -j"$jobs" V=1 ffmpeg.exe ffprobe.exe
)

for program in ffmpeg ffprobe; do
  # FFmpeg links *_g.exe first, then strips it into the final executable.
  cp "$ffmpeg_build/${program}_g.exe.map" "$materials/$program-link.map"
  # Windows ld mixes '/' directory paths with '\' before archive filenames.
  tr '\\' '/' < "$materials/$program-link.map" > "$work_root/link-normalized.txt"
  if ! grep -Fq -e "$private_prefix/lib/libz.a(" -e "$(cygpath -m "$private_prefix")/lib/libz.a(" "$work_root/link-normalized.txt"; then
    printf '%s did not link the private zlib archive.\n' "$program" >&2
    exit 2
  fi
  if grep -Eq '/ucrt64/lib/lib(z|x264)\.a\(' "$work_root/link-normalized.txt"; then
    printf '%s linked a system codec archive.\n' "$program" >&2
    exit 2
  fi
done
cp "$ffmpeg_build/ffbuild/config.log" "$materials/ffmpeg-config.log"

for program in ffmpeg ffprobe; do
  executable="$ffmpeg_build/$program.exe"
  if [[ ! -f "$executable" ]]; then
    printf 'FFmpeg build did not produce %s.exe.\n' "$program" >&2
    exit 2
  fi
  strip "$executable"
  cp "$executable" "$stage_root/bin/$program.exe"
done

ffmpeg="$stage_root/bin/ffmpeg.exe"
ffprobe="$stage_root/bin/ffprobe.exe"
"$ffmpeg" -version > "$materials/ffmpeg-version.txt"
"$ffprobe" -version > "$materials/ffprobe-version.txt"
"$ffmpeg" -buildconf > "$materials/ffmpeg-buildconf.txt"
"$ffmpeg" -hide_banner -decoders > "$materials/decoders.txt"
"$ffmpeg" -hide_banner -encoders > "$materials/encoders.txt"
"$ffmpeg" -hide_banner -demuxers > "$materials/demuxers.txt"
"$ffmpeg" -hide_banner -muxers > "$materials/muxers.txt"
"$ffmpeg" -hide_banner -protocols > "$materials/protocols.txt"
"$ffmpeg" -hide_banner -filters > "$materials/filters.txt"
# FFmpeg has no -parsers CLI option. This generated registry is compiled into
# libavcodec and lists exactly the parsers enabled for this build.
cp "$ffmpeg_build/libavcodec/parser_list.c" "$materials/parser_list.c"
sed -n 's/^[[:space:]]*&ff_\([a-z0-9_]*\)_parser,.*/\1/p' \
  "$materials/parser_list.c" > "$materials/parsers.txt"

grep -Eq '^ffmpeg version 9\.0\.1([[:space:]-]|$)' "$materials/ffmpeg-version.txt"
grep -Eq '^[[:space:]]*V[^[:space:]]*[[:space:]]+png([[:space:]]|$)' "$materials/decoders.txt"
grep -Eq '^[[:space:]]*V[^[:space:]]*[[:space:]]+h264([[:space:]]|$)' "$materials/decoders.txt"
grep -Eq '^[[:space:]]*V[^[:space:]]*[[:space:]]+libx264([[:space:]]|$)' "$materials/encoders.txt"
grep -Eq '^[[:space:]]+D[[:space:]]+image2pipe([[:space:]]|$)' "$materials/demuxers.txt"
grep -Eq '^[[:space:]]+D[[:space:]]+mov,mp4,' "$materials/demuxers.txt"
grep -Eq '^[[:space:]]+E[[:space:]]+mp4([[:space:]]|$)' "$materials/muxers.txt"
for protocol in file pipe; do
  grep -Eq "^[[:space:]]*$protocol([[:space:]]|$)" "$materials/protocols.txt"
done
for filter in buffer buffersink format scale; do
  grep -Eq "^[[:space:]]*[.TSC]+[[:space:]]+$filter([[:space:]]|$)" "$materials/filters.txt"
done
for parser in png h264; do
  grep -Eq "^[[:space:]]*$parser([[:space:]]|$)" "$materials/parsers.txt"
done
if grep -Eqi '(^|[[:space:]])(aac|mp3|opus|vorbis)([[:space:]]|$)' "$materials/encoders.txt"; then
  printf 'Unexpected audio encoder survived the component allowlist.\n' >&2
  exit 2
fi
if grep -Eqi '^[[:space:]]*(http|https|rtmp|tcp|udp)([[:space:]]|$)' "$materials/protocols.txt"; then
  printf 'Unexpected network protocol survived the component allowlist.\n' >&2
  exit 2
fi

for program in ffmpeg ffprobe; do
  objdump -p "$stage_root/bin/$program.exe" | sed -n 's/^[[:space:]]*DLL Name:[[:space:]]*//p' > "$materials/$program-pe-imports.txt"
done
(
  cd "$stage_root/bin"
  sha256sum ffmpeg.exe ffprobe.exe
) > "$materials/binary-sha256.txt"

cp "$project_root/scripts/ffmpeg_windows_source_lock.json" "$materials/source-lock.json"
cp "$x264_source/COPYING" "$materials/licenses/x264-COPYING"
# Runtime notices are copied as package-level collections, not inferred legal
# verdicts per symbol. Missing collections are reported without blocking builds.
: > "$materials/license-gaps.txt"
for package in gcc-libs crt winpthreads libwinpthread; do
  if [[ -d "/ucrt64/share/licenses/$package" ]]; then
    cp -R "/ucrt64/share/licenses/$package" "$materials/licenses/$package"
  else
    printf 'Missing local runtime notice directory: %s\n' "$package" >> "$materials/license-gaps.txt"
  fi
done
for license in COPYING.GPLv2 COPYING.LGPLv2.1 LICENSE.md; do
  if [[ -f "$ffmpeg_source/$license" ]]; then
    cp "$ffmpeg_source/$license" "$materials/licenses/ffmpeg-$license"
  else
    printf 'Required FFmpeg license is missing: %s\n' "$license" >&2
    exit 2
  fi
done

cat > "$materials/sources.json" <<EOF
{
  "zlib": {
    "archive": "$(basename "$zlib_archive")",
    "version": "${GS_ZLIB_VERSION}",
    "upstream": "official zlib release archive"
  },
  "x264": {
    "upstream": "VideoLAN x264 Git repository",
    "commit": "${GS_X264_COMMIT}",
    "worktree_clean": true
  },
  "ffmpeg": {
    "archive": "${GS_FFMPEG_ARCHIVE_NAME}",
    "version": "${GS_FFMPEG_VERSION}",
    "sha256": "${GS_FFMPEG_SHA256}",
    "upstream": "official FFmpeg release archive"
  }
}
EOF
cat > "$materials/patches.json" <<'EOF'
{
  "zlib": [],
  "x264": [],
  "ffmpeg": []
}
EOF

printf 'Offline build and staged capability checks completed.\n'
