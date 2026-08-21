import type { ConfigManifest } from "./types.js";
import {
  fail,
  reject_unknown_keys,
  require_list,
  require_mapping,
  parse_yaml,
} from "./validation.js";

const MANIFEST_ID = /^[A-Za-z0-9_-]+$/;

export function validate_config_manifest(value: unknown): ConfigManifest {
  const manifest = require_mapping(value, "manifest");
  reject_unknown_keys(manifest, "manifest", [
    "id",
    "name",
    "description",
    "terminations",
    "metadata",
  ]);
  if (typeof manifest.id !== "string" || !MANIFEST_ID.test(manifest.id))
    fail("manifest.id", "must be a valid config id");
  if (typeof manifest.name !== "string" || !manifest.name.trim())
    fail("manifest.name", "must be a non-empty string");
  if (typeof manifest.description !== "string")
    fail("manifest.description", "must be a string");
  const terminations = require_list(
    manifest.terminations,
    "manifest.terminations",
  );
  if (!terminations.length) fail("manifest.terminations", "must be non-empty");
  const parsedTerminations = terminations.map((raw, index) => {
    const path = `manifest.terminations[${index}]`;
    const termination = require_mapping(raw, path);
    reject_unknown_keys(termination, path, ["file", "name"]);
    if (
      typeof termination.file !== "string" ||
      !termination.file ||
      termination.file.includes("/") ||
      termination.file.includes("\\")
    )
      fail(`${path}.file`, "must be a non-empty file name");
    if (typeof termination.name !== "string" || !termination.name.trim())
      fail(`${path}.name`, "must be a non-empty string");
    return { file: termination.file, name: termination.name };
  });
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    terminations: parsedTerminations,
    ...(Object.hasOwn(manifest, "metadata")
      ? { metadata: manifest.metadata }
      : {}),
  };
}

export function read_config_manifest(manifest_text: string): ConfigManifest {
  return validate_config_manifest(parse_yaml(manifest_text, "manifest"));
}
