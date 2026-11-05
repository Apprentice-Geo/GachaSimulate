import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateApplicationLicenses,
  readPnpmLicenseInventory,
  verifyApplicationLicenses,
} from "./application_licenses.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function makeFixturePackage(
  root,
  metadata,
  licenseText = "fixture license\r\n",
) {
  const directory = path.join(
    root,
    `${metadata.name.replaceAll("/", "-")}-${metadata.version}`,
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(metadata),
    "utf8",
  );
  if (licenseText !== null) {
    await fs.writeFile(path.join(directory, "LICENSE"), licenseText, "utf8");
  }
  return directory;
}

function inventoryFor(packages) {
  return {
    fixture: packages.map(({ directory, name, version }) => ({
      name,
      versions: [version],
      paths: [directory],
    })),
  };
}

async function withFixture(callback) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "gachasimulate-license-test-"),
  );
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("sorts packages, normalizes line endings, and does not expose absolute paths", async () => {
  await withFixture(async (root) => {
    const beta = await makeFixturePackage(root, {
      name: "beta",
      version: "2.0.0",
      license: "ISC",
    });
    const alpha = await makeFixturePackage(
      root,
      { name: "alpha", version: "1.0.0", license: "MIT" },
      "alpha line one\r\nalpha line two\r\n",
    );
    const inventory = inventoryFor([
      { directory: beta, name: "beta", version: "2.0.0" },
      { directory: alpha, name: "alpha", version: "1.0.0" },
    ]);
    const first = await generateApplicationLicenses({
      inventory,
      outputDirectory: path.join(root, "first"),
      projectRoot,
    });
    const second = await generateApplicationLicenses({
      inventory,
      outputDirectory: path.join(root, "second"),
      projectRoot,
    });

    assert.equal(first.aggregate, second.aggregate);
    assert.ok(
      first.aggregate.indexOf("alpha@1.0.0") <
        first.aggregate.indexOf("beta@2.0.0"),
    );
    assert.doesNotMatch(first.aggregate, /\r/);
    assert.ok(!first.aggregate.includes(root));
  });
});

test("rejects an unknown license expression", async () => {
  await withFixture(async (root) => {
    const directory = await makeFixturePackage(root, {
      name: "unknown-license",
      version: "1.0.0",
      license: "MPL-2.0",
    });
    await assert.rejects(
      generateApplicationLicenses({
        inventory: inventoryFor([
          { directory, name: "unknown-license", version: "1.0.0" },
        ]),
        outputDirectory: path.join(root, "output"),
        projectRoot,
      }),
      /Unreviewed license expression/,
    );
  });
});

test("rejects an external package without license text", async () => {
  await withFixture(async (root) => {
    const directory = await makeFixturePackage(
      root,
      { name: "missing-text", version: "1.0.0", license: "MIT" },
      null,
    );
    await assert.rejects(
      generateApplicationLicenses({
        inventory: inventoryFor([
          { directory, name: "missing-text", version: "1.0.0" },
        ]),
        outputDirectory: path.join(root, "output"),
        projectRoot,
      }),
      /Missing license text/,
    );
  });
});

test("uses only the reviewed victory-vendor version override", async () => {
  await withFixture(async (root) => {
    const reviewed = await makeFixturePackage(
      root,
      { name: "victory-vendor", version: "37.3.6", license: "MIT AND ISC" },
      null,
    );
    const accepted = await generateApplicationLicenses({
      inventory: inventoryFor([
        { directory: reviewed, name: "victory-vendor", version: "37.3.6" },
      ]),
      outputDirectory: path.join(root, "accepted"),
      projectRoot,
    });
    assert.match(accepted.aggregate, /victory-vendor@37\.3\.6 reviewed notice/);

    const unreviewed = await makeFixturePackage(
      root,
      { name: "victory-vendor", version: "37.3.7", license: "MIT AND ISC" },
      "new version license",
    );
    await assert.rejects(
      generateApplicationLicenses({
        inventory: inventoryFor([
          { directory: unreviewed, name: "victory-vendor", version: "37.3.7" },
        ]),
        outputDirectory: path.join(root, "rejected"),
        projectRoot,
      }),
      /Unreviewed version of specially handled package: victory-vendor@37\.3\.7/,
    );
  });
});

test("generates the current production dependency inventory", async () => {
  await withFixture(async (root) => {
    const inventory = readPnpmLicenseInventory(projectRoot);
    const result = await generateApplicationLicenses({
      inventory,
      outputDirectory: path.join(root, "output"),
      projectRoot,
    });
    const expected = [
      ...new Set(
        Object.values(inventory)
          .flat()
          .filter(({ name }) => !name.startsWith("@gachasimulate/"))
          .flatMap(({ name, versions }) =>
            versions.map((version) => `${name}@${version}`),
          ),
      ),
    ].sort();
    assert.deepEqual(result.packages.map(({ key }) => key).sort(), expected);
    assert.ok(!result.aggregate.includes(projectRoot));
    await verifyApplicationLicenses({
      inventory,
      directory: path.join(root, "output"),
      projectRoot,
    });
  });
});

test("packaged license verification rejects changed, missing, and stale materials", async () => {
  await withFixture(async (root) => {
    const directory = path.join(root, "output");
    const inventory = inventoryFor([]);
    await generateApplicationLicenses({
      inventory,
      outputDirectory: directory,
      projectRoot,
    });
    const verify = () =>
      verifyApplicationLicenses({ inventory, directory, projectRoot });
    const aggregate = path.join(directory, "THIRD_PARTY_LICENSES.txt");
    const original = await fs.readFile(aggregate);
    await fs.writeFile(aggregate, "outdated inventory\n");
    await assert.rejects(verify, /differs from source/);
    await fs.writeFile(aggregate, original);
    const material = path.join(directory, "LICENSE.txt");
    const license = await fs.readFile(material);
    await fs.rm(material);
    await assert.rejects(verify, /file collection/);
    await fs.writeFile(material, license);
    await fs.writeFile(path.join(directory, "stale-license.txt"), "stale");
    await assert.rejects(verify, /file collection/);
  });
});
