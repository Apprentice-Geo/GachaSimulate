import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

function git(...args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

const trackedFiles = new Set(
  git("ls-files")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => fs.existsSync(path.join(repoRoot, file))),
);

const markdownFiles = [...trackedFiles].filter((file) => file.endsWith(".md"));

function extractLocalLinks(content) {
  const links = [];

  // 普通 Markdown 链接：
  // [text](path)
  // [text](<path with spaces>)
  const pattern = /!?\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

  for (const match of content.matchAll(pattern)) {
    let target = match[1];

    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }

    if (
      target.startsWith("#") ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }

    links.push({
      target,
      index: match.index,
    });
  }

  return links;
}

function removeFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) =>
    block.replace(/[^\r\n]/g, " "),
  );
}

test("tracked Markdown local links point to tracked files", () => {
  const brokenLinks = [];

  for (const markdownFile of markdownFiles) {
    const absolutePath = path.join(repoRoot, markdownFile);
    const content = removeFencedCodeBlocks(
      fs.readFileSync(absolutePath, "utf8"),
    );
    for (const { target, index } of extractLocalLinks(content)) {
      const targetPath = target.split("#", 1)[0].split("?", 1)[0];

      if (!targetPath) {
        continue;
      }

      let decodedTarget;
      try {
        decodedTarget = decodeURIComponent(targetPath);
      } catch {
        decodedTarget = targetPath;
      }
      const line = content.slice(0, index).split("\n").length;
      const resolved = path
        .normalize(path.join(path.dirname(markdownFile), decodedTarget))
        .replaceAll("\\", "/");

      if (!trackedFiles.has(resolved)) {
        brokenLinks.push(`${markdownFile}:${line}: ${target} -> ${resolved}`);
      }
    }
  }

  assert.deepEqual(
    brokenLinks,
    [],
    `Broken Markdown links:\n${brokenLinks.join("\n")}`,
  );
});
