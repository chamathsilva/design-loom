// Core release resources, resource-inventory-v1 and version ranges (backlog B04; design docs 03 and 06).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  checkReleaseManifest,
  parseRange,
  RESOURCE_INVENTORY_CONTRACT,
  resourceInventoryDigest,
  satisfiesRange,
  templateContentPath,
} from "@design-loom/config";
import { validateAgainstSchema } from "@design-loom/validation";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CORE = join(ROOT, "packages", "config", "resources", "core");
const DESIGN = join(ROOT, "tests", "fixtures", "design");

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

/** Every file under the core resource folder except its README, as "folder/name". */
function resourceFiles(): string[] {
  return readdirSync(CORE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "README.md")
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(CORE.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
}

describe("core release resources", () => {
  const release = readJson(join(CORE, "release.json"));
  const manifest = checkReleaseManifest(release).manifest;

  test("release.json is valid", () => {
    assert.deepEqual(checkReleaseManifest(release).problems, []);
    assert.ok(manifest);
  });

  test("release.json lists every resource file, and nothing else is shipped", () => {
    assert.ok(manifest);
    const listed = ["release.json", ...manifest.workflows];
    for (const path of manifest.templates) {
      const descriptor = readJson(join(CORE, path)) as { content_path: string };
      listed.push(path, templateContentPath(path, descriptor.content_path));
    }
    assert.deepEqual(resourceFiles(), listed.sort());
  });

  test("copies match the table in README.md byte for byte", () => {
    const readme = readFileSync(join(CORE, "README.md"), "utf8");
    const table = [...readme.matchAll(/^\| `([^`]+)` \| `[^`]+` \| `([0-9a-f]{64})` \|$/gm)];
    assert.deepEqual(
      table.map(([, file]) => file).sort(),
      resourceFiles().filter((file) => file !== "release.json"),
    );
    for (const [, file = "", expected] of table) {
      assert.equal(sha256(readFileSync(join(CORE, ...file.split("/")))), expected, file);
    }
  });

  test("template descriptors are the design package's, and every resource matches its schema", () => {
    assert.ok(manifest);
    for (const path of manifest.templates) {
      const name = path.split("/").at(-1) ?? "";
      assert.deepEqual(readFileSync(join(CORE, path)), readFileSync(join(DESIGN, "templates", name)), path);
      assert.equal(validateAgainstSchema("template", readJson(join(CORE, path))).valid, true, path);
    }
    for (const path of manifest.workflows) {
      assert.equal(validateAgainstSchema("workflow", readJson(join(CORE, path))).valid, true, path);
    }
    assert.deepEqual(
      readFileSync(join(CORE, "workflows", "core.feature-design.json")),
      readFileSync(join(DESIGN, "examples", "workflow.json")),
    );
  });

  test("each template is for a core artifact type, one per type", () => {
    assert.ok(manifest);
    const types = manifest.templates.map(
      (path) => (readJson(join(CORE, path)) as { artifact_type: string }).artifact_type,
    );
    assert.deepEqual(types.sort(), [...manifest.artifact_types].sort());
  });

  test("checkReleaseManifest reports each kind of problem", () => {
    const problems = checkReleaseManifest({
      schema_version: "2.0",
      framework_version: "0.1",
      artifact_types: [],
      core_rule_ids: ["DL1"],
      workflows: ["../outside.json"],
      templates: ["a.json", "A.json"],
      extra: true,
    }).problems;
    assert.equal(problems.length, 7, problems.join("\n"));
    assert.deepEqual(checkReleaseManifest(null).manifest, null);
  });
});

describe("resource-inventory-v1", () => {
  const files = [
    { path: "templates/b.md", sha256: "b".repeat(64) },
    { path: "release.json", sha256: "a".repeat(64) },
  ];

  test("is SHA-256 of canonical JSON over the files sorted by path", () => {
    const canonical = `{"digest_contract":"${RESOURCE_INVENTORY_CONTRACT}","files":[{"path":"release.json","sha256":"${"a".repeat(64)}"},{"path":"templates/b.md","sha256":"${"b".repeat(64)}"}]}`;
    assert.equal(resourceInventoryDigest(files), sha256(canonical));
    assert.equal(resourceInventoryDigest(files.toReversed()), sha256(canonical));
  });

  test("changes when a file is renamed, edited, added or removed", () => {
    const base = resourceInventoryDigest(files);
    const variants = [
      [{ ...files[0]!, path: "templates/c.md" }, files[1]!],
      [{ ...files[0]!, sha256: "c".repeat(64) }, files[1]!],
      [...files, { path: "extra.json", sha256: "d".repeat(64) }],
      [files[0]!],
    ];
    for (const variant of variants) assert.notEqual(resourceInventoryDigest(variant), base);
  });

  test("rejects unsafe or unnormalized paths, case-folded duplicates and bad hashes", () => {
    const bad = [
      [{ path: "../x", sha256: "a".repeat(64) }],
      [{ path: "a\\b.json", sha256: "a".repeat(64) }],
      [
        { path: "A.json", sha256: "a".repeat(64) },
        { path: "a.json", sha256: "b".repeat(64) },
      ],
      [{ path: "a.json", sha256: "A".repeat(64) }],
    ];
    for (const set of bad) assert.throws(() => resourceInventoryDigest(set), JSON.stringify(set));
  });
});

describe("version ranges", () => {
  test("comparators, conjunctions and alternatives", () => {
    const cases: [string, string, boolean][] = [
      ["0.1.0", ">=0.1.0 <0.2.0", true],
      ["0.1.9", ">=0.1.0 <0.2.0", true],
      ["0.2.0", ">=0.1.0 <0.2.0", false],
      ["0.0.9", ">=0.1.0 <0.2.0", false],
      ["0.1.0", "0.1.0", true],
      ["0.1.1", "=0.1.0", false],
      ["1.0.0", ">0.9.9", true],
      ["1.0.0", "<=1.0.0", true],
      ["2.0.0", "<1.0.0 || >=2.0.0", true],
      ["1.5.0", "<1.0.0 || >=2.0.0", false],
      ["0.10.0", ">0.9.0", true],
    ];
    for (const [version, range, expected] of cases)
      assert.equal(satisfiesRange(version, range), expected, `${version} ${range}`);
  });

  test("anything outside the small syntax is rejected rather than guessed", () => {
    for (const range of [
      "^0.1.0",
      "~0.1.0",
      "0.1.x",
      "*",
      ">=0.1",
      ">= 0.1.0",
      "",
      "0.1.0 ||",
      "01.0.0",
      "0.1.0-beta",
    ]) {
      assert.equal(parseRange(range), null, range);
    }
    assert.throws(() => satisfiesRange("0.1", ">=0.1.0"));
    assert.throws(() => satisfiesRange("0.1.0", "^0.1.0"));
  });
});
