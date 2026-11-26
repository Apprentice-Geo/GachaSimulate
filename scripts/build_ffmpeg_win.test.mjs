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
