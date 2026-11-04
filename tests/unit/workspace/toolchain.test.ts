// Toolchain pins that keep installs and digests reproducible (backlog B01, DL-Q01, DL-Q04).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const rootPackage = JSON.parse(read("package.json")) as {
  engines: { node: string };
  packageManager: string;
  devDependencies: Record<string, string>;
};

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

test("tests run on the supported Node major", () => {
  const major = process.versions.node.split(".")[0];
  assert.equal(read(".nvmrc").trim(), major);
  assert.equal(rootPackage.engines.node, `>=${major} <${Number(major) + 1}`);
});

test("development tools and the package manager are pinned to exact versions", () => {
  for (const [name, version] of Object.entries(rootPackage.devDependencies)) {
    assert.match(version, EXACT_VERSION, `${name} must be pinned exactly`);
  }
  assert.match(rootPackage.packageManager, /^npm@\d+\.\d+\.\d+$/);
  assert.match(read(".npmrc"), /^save-exact=true$/m);
  assert.match(read(".npmrc"), /^engine-strict=true$/m);
});

test("text files are stored with LF line endings on every platform", () => {
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/m);
});
