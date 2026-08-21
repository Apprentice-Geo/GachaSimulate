import {
  YAML_TEXT_LIMIT,
  read_config_manifest,
  type ConfigManifest,
} from "@gachasimulate/config-compiler";

export const CONFIG_REPOSITORY_FORMAT_VERSION = 1 as const;
export const REPOSITORY_INDEX_TEXT_LIMIT = 1024 * 1024;
export const REPOSITORY_CONFIG_LIMIT = 1024;
export const REPOSITORY_ID_BYTE_LIMIT = 64;
export const REPOSITORY_NAME_BYTE_LIMIT = 256;
export const REPOSITORY_DESCRIPTION_BYTE_LIMIT = 8 * 1024;
export const REPOSITORY_TERMINATION_LIMIT = 62;
export const REPOSITORY_TERMINATION_FILE_BYTE_LIMIT = 255;
export const REPOSITORY_TERMINATION_NAME_BYTE_LIMIT = 128;
export const CONFIG_PACKAGE_FILE_LIMIT = 64;
export const CONFIG_PACKAGE_FILE_SIZE_LIMIT = YAML_TEXT_LIMIT;

export type ConfigRepositoryEntry = {
  id: string;
  name: string;
  description: string;
  download_url: string;
  sha256: string;
};

export type ConfigRepositoryIndex = {
  format_version: typeof CONFIG_REPOSITORY_FORMAT_VERSION;
  configs: ConfigRepositoryEntry[];
};

export type ConfigPackageFile = {
  path: string;
  size: number;
};

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TERMINATION_FILE = /^[a-z0-9][a-z0-9_-]*\.yaml$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function mapping(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function exact_keys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
) {
  for (const key of Object.keys(value))
    if (!expected.includes(key)) fail(`${path}.${key}`, "unsupported field");
  for (const key of expected)
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function limited_string(
  value: unknown,
  path: string,
  limit: number,
  nonempty = false,
): string {
  const result = string(value, path);
  if (nonempty && !result.trim()) fail(path, "must be a non-empty string");
  if (bytes(result) > limit) fail(path, `must not exceed ${limit} UTF-8 bytes`);
  return result;
}

function repository_id(value: unknown, path: string): string {
  const id = limited_string(value, path, REPOSITORY_ID_BYTE_LIMIT);
  if (!ID.test(id) || WINDOWS_DEVICE.test(id))
    fail(path, "must be a safe lowercase config id");
  return id;
}

function safe_download_url(value: unknown, path: string): string {
  const url = string(value, path);
  if (
    !url ||
    url.startsWith("/") ||
    url.includes("\\") ||
    url.includes("?") ||
    url.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)
  )
    fail(path, "must be a safe relative URL path");
  for (const raw of url.split("/")) {
    if (!raw) fail(path, "must not contain empty path segments");
    let segment = raw;
    for (;;) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        fail(path, "contains invalid percent encoding");
      }
      if (decoded === segment) break;
      segment = decoded;
    }
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      [...segment].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      fail(path, "must not contain unsafe path segments");
  }
  return url;
}

export function read_repository_index(text: string): ConfigRepositoryIndex {
  if (bytes(text) > REPOSITORY_INDEX_TEXT_LIMIT)
    fail("index", "must not exceed 1 MiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("index", "must be valid JSON");
  }
  const index = mapping(parsed, "index");
  exact_keys(index, "index", ["format_version", "configs"]);
  if (index.format_version !== CONFIG_REPOSITORY_FORMAT_VERSION)
    fail("index.format_version", "must be 1");
  if (!Array.isArray(index.configs)) fail("index.configs", "must be an array");
  if (index.configs.length > REPOSITORY_CONFIG_LIMIT)
    fail(
      "index.configs",
      `must not contain more than ${REPOSITORY_CONFIG_LIMIT} entries`,
    );

  const ids = new Set<string>();
  let previous = "";
  const configs = index.configs.map((raw, position): ConfigRepositoryEntry => {
    const path = `index.configs[${position}]`;
    const entry = mapping(raw, path);
    exact_keys(entry, path, [
      "id",
      "name",
      "description",
      "download_url",
      "sha256",
    ]);
    const id = repository_id(entry.id, `${path}.id`);
    if (ids.has(id)) fail(`${path}.id`, "must be unique");
    if (previous && previous > id)
      fail("index.configs", "must be sorted by id in ASCII order");
    ids.add(id);
    previous = id;
    const sha256 = string(entry.sha256, `${path}.sha256`);
    if (!SHA256.test(sha256))
      fail(`${path}.sha256`, "must be a lowercase SHA-256 digest");
    return {
      id,
      name: limited_string(
        entry.name,
        `${path}.name`,
        REPOSITORY_NAME_BYTE_LIMIT,
        true,
      ),
      description: limited_string(
        entry.description,
        `${path}.description`,
        REPOSITORY_DESCRIPTION_BYTE_LIMIT,
      ),
      download_url: safe_download_url(
        entry.download_url,
        `${path}.download_url`,
      ),
      sha256,
    };
  });
  return { format_version: CONFIG_REPOSITORY_FORMAT_VERSION, configs };
}

export function read_repository_manifest(text: string): ConfigManifest {
  const manifest = read_config_manifest(text);
  repository_id(manifest.id, "manifest.id");
  limited_string(
    manifest.name,
    "manifest.name",
    REPOSITORY_NAME_BYTE_LIMIT,
    true,
  );
  limited_string(
    manifest.description,
    "manifest.description",
    REPOSITORY_DESCRIPTION_BYTE_LIMIT,
  );
  if (manifest.terminations.length > REPOSITORY_TERMINATION_LIMIT)
    fail(
      "manifest.terminations",
      `must not contain more than ${REPOSITORY_TERMINATION_LIMIT} entries`,
    );
  const files = new Set<string>();
  manifest.terminations.forEach((termination, index) => {
    const path = `manifest.terminations[${index}]`;
    if (
      bytes(termination.file) > REPOSITORY_TERMINATION_FILE_BYTE_LIMIT ||
      !TERMINATION_FILE.test(termination.file) ||
      WINDOWS_DEVICE.test(termination.file.slice(0, -5))
    )
      fail(`${path}.file`, "must be a safe lowercase .yaml file name");
    if (files.has(termination.file)) fail(`${path}.file`, "must be unique");
    files.add(termination.file);
    limited_string(
      termination.name,
      `${path}.name`,
      REPOSITORY_TERMINATION_NAME_BYTE_LIMIT,
      true,
    );
  });
  return manifest;
}

export function validate_config_package(
  directory_id: string,
  manifest_text: string,
  files: readonly ConfigPackageFile[],
): ConfigManifest {
  const manifest = read_repository_manifest(manifest_text);
  if (directory_id !== manifest.id)
    fail("directory_id", "must match manifest.id");
  if (!Array.isArray(files)) fail("files", "must be an array");
  if (files.length > CONFIG_PACKAGE_FILE_LIMIT)
    fail(
      "files",
      `must not contain more than ${CONFIG_PACKAGE_FILE_LIMIT} entries`,
    );

  const exact = new Set<string>();
  const folded = new Set<string>();
  files.forEach((file, index) => {
    const path = `files[${index}]`;
    const entry = mapping(file, path);
    const name = string(entry.path, `${path}.path`);
    if (!name || name.includes("/") || name.includes("\\"))
      fail(`${path}.path`, "must be a single file name");
    if (exact.has(name)) fail(`${path}.path`, "must not be duplicated");
    const foldedName = name.toLowerCase();
    if (folded.has(foldedName))
      fail(`${path}.path`, "must not conflict after case folding");
    exact.add(name);
    folded.add(foldedName);
    if (
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > CONFIG_PACKAGE_FILE_SIZE_LIMIT
    )
      fail(`${path}.size`, "must be a non-negative size not exceeding 1 MiB");
  });

  const expected = new Set([
    "manifest.yaml",
    "config.yaml",
    ...manifest.terminations.map(({ file }) => file),
  ]);
  for (const name of expected)
    if (!exact.has(name)) fail("files", `missing required file: ${name}`);
  for (const name of exact)
    if (!expected.has(name)) fail("files", `unexpected file: ${name}`);
  return manifest;
}
