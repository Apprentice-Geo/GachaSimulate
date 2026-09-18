import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LICENSE_FILE_PATTERN = /^(?:license|licence|copying|notice)(?:\..*)?$/i;
const INTERNAL_PACKAGE_PREFIX = "@gachasimulate/";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeText(value) {
  return `${value.replace(/\r\n?/g, "\n").replace(/\n*$/, "")}\n`;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON metadata: ${file}`, { cause: error });
  }
}

async function readLicenseFiles(packageDirectory) {
  const entries = await fs.readdir(packageDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareText);

  return Promise.all(
    names.map(async (name) => ({
      name,
      text: normalizeText(
        await fs.readFile(path.join(packageDirectory, name), "utf8"),
      ),
    })),
  );
}

export async function loadLicensePolicy(projectRoot) {
  const policyFile = path.join(
    projectRoot,
    "scripts",
    "application_licenses_policy.json",
  );
  const policy = await readJson(policyFile);
  if (policy.policy_version !== 1) {
    throw new Error(
      `Unsupported application license policy version: ${policy.policy_version}`,
    );
  }
  return policy;
}

export function readPnpmLicenseInventory(projectRoot) {
  const executable =
    process.platform === "win32" ? process.env.ComSpec : "pnpm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm licenses list --prod --json"]
      : ["licenses", "list", "--prod", "--json"];
  const output = execFileSync(executable, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

export async function collectPackages(inventory, policy, projectRoot) {
  const allowed = new Set(policy.allowed_license_expressions);
  const reviewedPackageNames = new Set(
    Object.keys(policy.reviewed_overrides).map((key) =>
      key.slice(0, key.lastIndexOf("@")),
    ),
  );
  const packages = new Map();

  for (const group of Object.values(inventory)) {
    if (!Array.isArray(group)) {
      throw new Error("Unexpected pnpm license inventory structure.");
    }
    for (const reported of group) {
      if (!Array.isArray(reported.paths) || !Array.isArray(reported.versions)) {
        throw new Error(
          `Missing pnpm package paths or versions for ${reported.name ?? "unknown"}.`,
        );
      }
      for (const packageDirectory of reported.paths) {
        const metadata = await readJson(
          path.join(packageDirectory, "package.json"),
        );
        if (
          typeof metadata.name !== "string" ||
          typeof metadata.version !== "string"
        ) {
          throw new Error(
            `Missing package name or version metadata in ${packageDirectory}.`,
          );
        }
        if (metadata.name.startsWith(INTERNAL_PACKAGE_PREFIX)) {
          continue;
        }
        if (
          metadata.name !== reported.name ||
          !reported.versions.includes(metadata.version)
        ) {
          throw new Error(
            `pnpm metadata mismatch for ${metadata.name}@${metadata.version}.`,
          );
        }
        if (
          typeof metadata.license !== "string" ||
          !allowed.has(metadata.license)
        ) {
          throw new Error(
            `Unreviewed license expression for ${metadata.name}@${metadata.version}: ${String(metadata.license)}`,
          );
        }

        const key = `${metadata.name}@${metadata.version}`;
        const override = policy.reviewed_overrides[key];
        let licenseFiles;
        if (override) {
          if (override.license_expression !== metadata.license) {
            throw new Error(`Reviewed override license mismatch for ${key}.`);
          }
          licenseFiles = [
            {
              name: path.basename(override.license_file),
              text: normalizeText(
                await fs.readFile(
                  path.join(projectRoot, override.license_file),
                  "utf8",
                ),
              ),
            },
          ];
        } else if (reviewedPackageNames.has(metadata.name)) {
          throw new Error(
            `Unreviewed version of specially handled package: ${key}.`,
          );
        } else {
          licenseFiles = await readLicenseFiles(packageDirectory);
          if (licenseFiles.length === 0) {
            throw new Error(`Missing license text for ${key}.`);
          }
        }

        const candidate = {
          key,
          name: metadata.name,
          version: metadata.version,
          license: metadata.license,
          licenseFiles,
        };
        const previous = packages.get(key);
        if (
          previous &&
          JSON.stringify(previous) !== JSON.stringify(candidate)
        ) {
          throw new Error(`Conflicting license materials for ${key}.`);
        }
        packages.set(key, candidate);
      }
    }
  }

  return [...packages.values()].sort((left, right) =>
    compareText(left.key, right.key),
  );
}

export function renderThirdPartyLicenses(packages) {
  const sections = packages.map((item) => {
    const files = item.licenseFiles
      .map(
        (licenseFile) =>
          `--- ${licenseFile.name} ---\n\n${licenseFile.text.trimEnd()}`,
      )
      .join("\n\n");
    return `${"=".repeat(80)}\n${item.key}\nLicense: ${item.license}\n\n${files}`;
  });
  return normalizeText(
    [
      "GachaSimulate third-party production dependency licenses",
      "",
      "This file is generated from installed package metadata and license files.",
      "Internal @gachasimulate workspace packages are covered by the project license.",
      "",
      ...sections,
    ].join("\n"),
  );
}

export async function generateApplicationLicenses({
  inventory,
  outputDirectory,
  projectRoot,
}) {
  const policy = await loadLicensePolicy(projectRoot);
  const packages = await collectPackages(inventory, policy, projectRoot);
  const aggregate = renderThirdPartyLicenses(packages);

  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const mapping of policy.application_files) {
    await fs.copyFile(
      path.join(projectRoot, mapping.source),
      path.join(outputDirectory, mapping.output),
    );
  }
  await fs.writeFile(
    path.join(outputDirectory, "THIRD_PARTY_LICENSES.txt"),
    aggregate,
    "utf8",
  );
  return { aggregate, packages };
}

async function main() {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const inventory = readPnpmLicenseInventory(projectRoot);
  const outputDirectory = path.join(
    projectRoot,
    "build",
    "application-licenses",
  );
  const { packages } = await generateApplicationLicenses({
    inventory,
    outputDirectory,
    projectRoot,
  });
  process.stdout.write(
    `Prepared application licenses for ${packages.length} production packages.\n`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
