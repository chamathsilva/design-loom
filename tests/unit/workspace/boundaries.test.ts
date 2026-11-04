// Package-boundary rules for the workspace (backlog B01).
// Design doc 02 defines the packages; BUILD-BRIEF keeps provider access out of pure logic.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PACKAGES_DIR = join(ROOT, "packages");
const SCOPE = "@design-loom/";

/** Packages named in design doc 02. Adding one is a design change, not a refactor. */
const EXPECTED_PACKAGES = [
  "artifacts",
  "baseline",
  "cli",
  "config",
  "handoff",
  "integrations",
  "validation",
  "workflow",
];

/** Packages allowed to depend on provider adapters. Pure logic must not. */
const MAY_USE_INTEGRATIONS = new Set(["cli"]);

/**
 * Third-party runtime dependencies, which must be bundled into the plugin (doc 02).
 * Empty in B01; each addition should be a deliberate, reviewed change.
 */
const ALLOWED_THIRD_PARTY_RUNTIME: Record<string, readonly string[]> = {};

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  type?: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8")) as PackageJson;
}

function packageDirs(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function sourceFiles(dir: string): string[] {
  const srcDir = join(PACKAGES_DIR, dir, "src");
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(srcDir, file));
}

function internalDeps(pkg: PackageJson): string[] {
  return Object.keys(pkg.dependencies ?? {})
    .filter((name) => name.startsWith(SCOPE))
    .map((name) => name.slice(SCOPE.length));
}

describe("workspace packages", () => {
  test("match the package set in design doc 02", () => {
    assert.deepEqual(packageDirs(), EXPECTED_PACKAGES);
  });

  for (const dir of EXPECTED_PACKAGES) {
    test(`${dir} has a private ESM manifest exporting src/index.ts`, () => {
      const pkg = readPackage(dir);
      assert.equal(pkg.name, `${SCOPE}${dir}`);
      assert.equal(pkg.version, "0.0.0");
      assert.equal(pkg.private, true);
      assert.equal(pkg.type, "module");
      assert.deepEqual(pkg.exports, { ".": "./src/index.ts" });
      assert.ok(existsSync(join(PACKAGES_DIR, dir, "src", "index.ts")));
    });
  }
});

describe("dependency boundaries", () => {
  const graph = new Map(EXPECTED_PACKAGES.map((dir) => [dir, internalDeps(readPackage(dir))]));

  test("internal dependencies name existing packages at the workspace version", () => {
    for (const dir of EXPECTED_PACKAGES) {
      const pkg = readPackage(dir);
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        if (!name.startsWith(SCOPE)) continue;
        assert.ok(EXPECTED_PACKAGES.includes(name.slice(SCOPE.length)), `${dir} depends on unknown ${name}`);
        assert.equal(version, "0.0.0", `${dir} must pin ${name} to the workspace version`);
      }
    }
  });

  test("third-party runtime dependencies are explicitly allowed", () => {
    for (const dir of EXPECTED_PACKAGES) {
      const external = Object.keys(readPackage(dir).dependencies ?? {}).filter((name) => !name.startsWith(SCOPE));
      assert.deepEqual(external.sort(), [...(ALLOWED_THIRD_PARTY_RUNTIME[dir] ?? [])].sort(), dir);
    }
  });

  test("nothing depends on cli", () => {
    for (const [dir, deps] of graph) {
      assert.ok(!deps.includes("cli"), `${dir} depends on cli`);
    }
  });

  test("only allowed packages depend on integrations", () => {
    for (const [dir, deps] of graph) {
      if (deps.includes("integrations")) {
        assert.ok(MAY_USE_INTEGRATIONS.has(dir), `${dir} must not depend on provider adapters`);
      }
    }
  });

  test("the internal dependency graph is acyclic", () => {
    const done = new Set<string>();
    const visit = (dir: string, path: string[]): void => {
      assert.ok(!path.includes(dir), `cycle: ${[...path, dir].join(" -> ")}`);
      if (done.has(dir)) return;
      for (const dep of graph.get(dir) ?? []) visit(dep, [...path, dir]);
      done.add(dir);
    };
    for (const dir of EXPECTED_PACKAGES) visit(dir, []);
  });

  test("source imports of workspace packages are declared dependencies", () => {
    const importPattern = /\bfrom\s+["']@design-loom\/([a-z-]+)["']|\bimport\(\s*["']@design-loom\/([a-z-]+)["']/g;
    for (const dir of EXPECTED_PACKAGES) {
      const declared = new Set(graph.get(dir));
      for (const file of sourceFiles(dir)) {
        for (const match of readFileSync(file, "utf8").matchAll(importPattern)) {
          const target = match[1] ?? match[2] ?? "";
          assert.notEqual(target, dir, `${file} imports its own package by name`);
          assert.ok(declared.has(target), `${file} imports undeclared @design-loom/${target}`);
        }
      }
    }
  });
});

describe("workspace resolution", () => {
  test("cli resolves every component package through the workspace links", async () => {
    const cli = await import("@design-loom/cli");
    assert.equal(cli.PACKAGE_NAME, "@design-loom/cli");
    assert.deepEqual(
      [...cli.COMPONENT_PACKAGES].sort(),
      EXPECTED_PACKAGES.filter((dir) => dir !== "cli").map((dir) => `${SCOPE}${dir}`),
    );
  });
});
