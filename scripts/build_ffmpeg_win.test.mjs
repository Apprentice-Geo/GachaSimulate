import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("offline FFmpeg build scripts contain no acquisition or package mutation commands", async () => {
  const powershell = await readFile(
    join(root, "scripts", "build_ffmpeg_win.ps1"),
    "utf8",
  );
  const bash = await readFile(
    join(root, "scripts", "build_ffmpeg_win_ucrt64.sh"),
    "utf8",
  );
  const scripts = `${powershell}\n${bash}`;

  assert.doesNotMatch(scripts, /https?:\/\//i);
  assert.doesNotMatch(
    scripts,
    /\b(?:curl|wget|Invoke-WebRequest|Start-BitsTransfer)\b/i,
  );
  assert.doesNotMatch(
    scripts,
    /\bpacman(?:\.exe)?\s+(?:-[A-Za-z]*S|-[A-Za-z]*U)/i,
  );
  assert.doesNotMatch(
    scripts,
    /\bgit\s+(?:clone|fetch|pull|submodule|remote)\b/i,
  );
});

test("rolling UCRT64 toolchain checks tools and target, recording packages only as a snapshot", async () => {
  const powershell = await readFile(
    join(root, "scripts", "build_ffmpeg_win.ps1"),
    "utf8",
  );
  const bash = await readFile(
    join(root, "scripts", "build_ffmpeg_win_ucrt64.sh"),
    "utf8",
  );

  assert.doesNotMatch(
    powershell,
    /RequiredMsys2Packages|mingw-w64-ucrt-x86_64-/,
  );
  assert.match(powershell, /\$AllInstalledPackages \| ConvertTo-Json/);
  assert.match(powershell, /msys2-package-snapshot\.json/);
  assert.match(
    bash,
    /ucrt64_tools=\(ar gcc ld nasm objdump pkgconf ranlib strip\)/,
  );
  assert.match(bash, /"\$tool_path" != "\/ucrt64\/bin\/\$tool"/);
  assert.match(bash, /msys_tools=\([^)]*\bcmp\b[^)]*\bmake\b[^)]*\btar\b/);
  assert.match(bash, /gcc_target="\$\(gcc -dumpmachine\)"/);
  assert.match(bash, /"\$gcc_target" != "x86_64-w64-mingw32"/);
  assert.doesNotMatch(
    `${powershell}\n${bash}`,
    /installed-package-versions\.json|license-gaps\.txt|\/ucrt64\/share\/licenses/,
  );
});

test("source lock pins only the requested source identities", async () => {
  const lock = JSON.parse(
    await readFile(
      join(root, "scripts", "ffmpeg_windows_source_lock.json"),
      "utf8",
    ),
  );

  assert.equal(lock.target, "win32-x64-ucrt64");
  assert.equal(lock.x264.commit, "b35605ace3ddf7c1a5d67a2eb553f034aef41d55");
  assert.equal(lock.ffmpeg.version, "9.0.1");
  assert.deepEqual(lock.zlib, {
    version: "1.3.2",
    archive_name: "zlib-1.3.2.tar.xz",
    archive_sha256:
      "d7a0654783a4da529d1bb793b7ad9c3318020af77667bcae35f95d0e42a792f3",
  });
  assert.equal(lock.ffmpeg.archive_name, "ffmpeg-9.0.1.tar.xz");
  assert.equal(
    lock.ffmpeg.archive_sha256,
    "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635",
  );
  assert.deepEqual(Object.keys(lock), ["target", "zlib", "x264", "ffmpeg"]);
});
