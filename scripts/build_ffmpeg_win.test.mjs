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

test("source lock pins only the requested source identities", async () => {
  const lock = JSON.parse(
    await readFile(
      join(root, "scripts", "ffmpeg_windows_source_lock.json"),
      "utf8",
    ),
  );

  assert.equal(
    lock.x264.commit,
    "b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
  );
  assert.equal(lock.ffmpeg.version, "9.0.1");
  assert.equal(lock.ffmpeg.archive_name, "ffmpeg-9.0.1.tar.xz");
  assert.equal(
    lock.ffmpeg.archive_sha256,
    "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635",
  );
  assert.deepEqual(Object.keys(lock), [
    "schema_version",
    "target",
    "x264",
    "ffmpeg",
  ]);
});
