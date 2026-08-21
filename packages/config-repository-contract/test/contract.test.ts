import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_PACKAGE_FILE_SIZE_LIMIT,
  CONFIG_REPOSITORY_FORMAT_VERSION,
  REPOSITORY_CONFIG_LIMIT,
  REPOSITORY_DESCRIPTION_BYTE_LIMIT,
  REPOSITORY_ID_BYTE_LIMIT,
  REPOSITORY_INDEX_TEXT_LIMIT,
  REPOSITORY_NAME_BYTE_LIMIT,
  REPOSITORY_TERMINATION_FILE_BYTE_LIMIT,
  REPOSITORY_TERMINATION_LIMIT,
  REPOSITORY_TERMINATION_NAME_BYTE_LIMIT,
  read_repository_index,
  read_repository_manifest,
  validate_config_package,
  type ConfigPackageFile,
} from "../src/index.js";

const sha256 = "0".repeat(64);

function entry(id = "example") {
  return {
    id,
    name: "Example",
    description: "Description",
    download_url: `packages/${id}.zip`,
    sha256,
  };
}

function index(configs: unknown[] = [entry()]): string {
  return JSON.stringify({
    format_version: CONFIG_REPOSITORY_FORMAT_VERSION,
    configs,
  });
}

function termination(position = 0) {
  return { file: `termination_${position}.yaml`, name: `Done ${position}` };
}

function manifest(
  overrides: Partial<{
    id: string;
    name: string;
    description: string;
    terminations: { file: string; name: string }[];
    metadata: unknown;
  }> = {},
): string {
  return JSON.stringify({
    id: "example",
    name: "Example",
    description: "Description",
    terminations: [termination()],
    ...overrides,
  });
}

function package_files(
  terminations = [termination()],
  size = 1,
): ConfigPackageFile[] {
  return [
    { path: "manifest.yaml", size },
    { path: "config.yaml", size },
    ...terminations.map(({ file }) => ({ path: file, size })),
  ];
}

test("reads a typed repository index and rejects shape errors", () => {
  assert.deepEqual(read_repository_index(index()), {
    format_version: 1,
    configs: [entry()],
  });
  for (const source of [
    "null",
    "not json",
    JSON.stringify({ configs: [] }),
    JSON.stringify({ format_version: 1 }),
    JSON.stringify({ format_version: 2, configs: [] }),
    JSON.stringify({ format_version: 1, configs: [], unknown: true }),
    JSON.stringify({ format_version: 1, configs: {} }),
    index([{ ...entry(), unknown: true }]),
    index([{ ...entry(), sha256: "A".repeat(64) }]),
    index([{ ...entry(), sha256: "0".repeat(63) }]),
    index([{ ...entry(), name: "" }]),
    index([{ ...entry(), name: "名".repeat(86) }]),
    index([{ ...entry(), description: "说".repeat(2731) }]),
  ])
    assert.throws(() => read_repository_index(source));
});

test("requires unique ASCII-sorted repository ids", () => {
  assert.doesNotThrow(() =>
    read_repository_index(index([entry("a"), entry("a_1"), entry("b")])),
  );
  assert.throws(() => read_repository_index(index([entry("b"), entry("a")])));
  assert.throws(() => read_repository_index(index([entry("a"), entry("a")])));
});

test("rejects unsafe repository download paths", () => {
  for (const download_url of [
    "https://example.test/package.zip",
    "//example.test/package.zip",
    "/packages/example.zip",
    "packages\\example.zip",
    "packages//example.zip",
    "packages/./example.zip",
    "packages/../example.zip",
    "packages/%2e%2e/example.zip",
    "packages/%252e%252e/example.zip",
    "packages/%2fexample.zip",
    "packages/%255cexample.zip",
    "packages/example.zip?download=1",
    "packages/example.zip#archive",
    "packages/%00example.zip",
    "packages/%zz.zip",
  ])
    assert.throws(() =>
      read_repository_index(index([{ ...entry(), download_url }])),
    );
});

test("enforces repository index count and UTF-8 text limits", () => {
  const configs = Array.from({ length: REPOSITORY_CONFIG_LIMIT }, (_, i) =>
    entry(`config_${i.toString().padStart(4, "0")}`),
  );
  assert.equal(read_repository_index(index(configs)).configs.length, 1024);
  assert.throws(() =>
    read_repository_index(index([...configs, entry("config_9999")])),
  );

  const source = index();
  assert.doesNotThrow(() =>
    read_repository_index(source.padEnd(REPOSITORY_INDEX_TEXT_LIMIT, " ")),
  );
  assert.throws(() =>
    read_repository_index(source.padEnd(REPOSITORY_INDEX_TEXT_LIMIT + 1, " ")),
  );
});

test("enforces repository manifest display limits in UTF-8 bytes", () => {
  assert.equal(REPOSITORY_ID_BYTE_LIMIT, 64);
  assert.doesNotThrow(() =>
    read_repository_manifest(
      manifest({
        id: "a".repeat(REPOSITORY_ID_BYTE_LIMIT),
        name: "名".repeat(85) + "a",
        description: "说".repeat(2730) + "aa",
        terminations: [
          {
            file:
              "a".repeat(REPOSITORY_TERMINATION_FILE_BYTE_LIMIT - 5) + ".yaml",
            name: "名".repeat(42) + "aa",
          },
        ],
      }),
    ),
  );
  for (const source of [
    manifest({ id: "a".repeat(REPOSITORY_ID_BYTE_LIMIT + 1) }),
    manifest({ name: "名".repeat(86) }),
    manifest({ description: "说".repeat(2731) }),
    manifest({
      terminations: [
        {
          file:
            "a".repeat(REPOSITORY_TERMINATION_FILE_BYTE_LIMIT - 4) + ".yaml",
          name: "Done",
        },
      ],
    }),
    manifest({
      terminations: [{ file: "done.yaml", name: "名".repeat(43) }],
    }),
  ])
    assert.throws(() => read_repository_manifest(source));
  assert.equal(REPOSITORY_NAME_BYTE_LIMIT, 256);
  assert.equal(REPOSITORY_DESCRIPTION_BYTE_LIMIT, 8192);
  assert.equal(REPOSITORY_TERMINATION_NAME_BYTE_LIMIT, 128);
});

test("enforces repository manifest id, file-name, and count rules", () => {
  const terminations = Array.from(
    { length: REPOSITORY_TERMINATION_LIMIT },
    (_, i) => termination(i),
  );
  assert.equal(
    read_repository_manifest(manifest({ terminations })).terminations.length,
    62,
  );
  for (const source of [
    manifest({ id: "Uppercase" }),
    manifest({ id: "con" }),
    manifest({ id: "com1" }),
    manifest({ terminations: [...terminations, termination(62)] }),
    manifest({ terminations: [{ file: "Done.yaml", name: "Done" }] }),
    manifest({ terminations: [{ file: "done.yml", name: "Done" }] }),
    manifest({ terminations: [{ file: "con.yaml", name: "Done" }] }),
    manifest({ terminations: [{ file: "lpt9.yaml", name: "Done" }] }),
    manifest({ terminations: [termination(), termination()] }),
  ])
    assert.throws(() => read_repository_manifest(source));
});

test("validates package identity and exact flat file collection", () => {
  const source = manifest();
  assert.equal(
    validate_config_package("example", source, package_files()).id,
    "example",
  );
  assert.throws(() =>
    validate_config_package("other", source, package_files()),
  );
  for (const files of [
    package_files().slice(1),
    [...package_files(), { path: "extra.yaml", size: 1 }],
    package_files().map((file, index) =>
      index === 2 ? { ...file, path: "nested/termination_0.yaml" } : file,
    ),
    [...package_files(), { path: "termination_0.yaml", size: 1 }],
    [...package_files(), { path: "TERMINATION_0.YAML", size: 1 }],
  ])
    assert.throws(() => validate_config_package("example", source, files));
});

test("accepts 64 one-MiB files without a total package size limit", () => {
  const terminations = Array.from(
    { length: REPOSITORY_TERMINATION_LIMIT },
    (_, i) => termination(i),
  );
  const source = manifest({ terminations });
  const files = package_files(terminations, CONFIG_PACKAGE_FILE_SIZE_LIMIT);
  assert.equal(files.length, 64);
  assert.doesNotThrow(() => validate_config_package("example", source, files));
  assert.throws(() =>
    validate_config_package("example", source, [
      ...files,
      { path: "extra.yaml", size: 1 },
    ]),
  );
  assert.throws(() =>
    validate_config_package("example", source, [
      { ...files[0], size: CONFIG_PACKAGE_FILE_SIZE_LIMIT + 1 },
      ...files.slice(1),
    ]),
  );
});
