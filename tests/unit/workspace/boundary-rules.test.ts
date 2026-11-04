// Negative and positive cases proving the boundary checker can fail (backlog B01).

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type FileContext, findSpecifiers, sourceViolations } from "./boundary-rules.ts";

const PACKAGES = join("/repo", "packages");

function ctx(packageDir: string, declared: string[] = []): FileContext {
  const packageRoot = join(PACKAGES, packageDir);
  return { packageDir, packageRoot, file: join(packageRoot, "src", "index.ts"), declared: new Set(declared) };
}

describe("findSpecifiers", () => {
  test("finds static, type, re-export, side-effect, dynamic and require forms", () => {
    const source = [
      'import { a } from "x1";',
      'import type { B } from "x2";',
      'export { c } from "x3";',
      'export * from "x4";',
      'import "x5";',
      'const d = await import("x6");',
      'const e = require("x7");',
      "import f from 'x8';",
    ].join("\n");
    assert.deepEqual(findSpecifiers(source), ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8"]);
  });
});

describe("sourceViolations rejects", () => {
  const cases: Array<[string, string, FileContext]> = [
    ["undeclared workspace import", 'import { x } from "@design-loom/config";', ctx("workflow")],
    [
      "deep subpath import",
      'import { x } from "@design-loom/config/src/index.ts";',
      ctx("workflow", ["@design-loom/config"]),
    ],
    ["side-effect import", 'import "@design-loom/integrations";', ctx("config")],
    ["dynamic import", 'await import("@design-loom/integrations");', ctx("config")],
    ["self import by name", 'import { x } from "@design-loom/config";', ctx("config", ["@design-loom/config"])],
    ["relative import into another package", 'import { x } from "../../integrations/src/index.ts";', ctx("config")],
    ["file-system module in a pure package", 'import { readFileSync } from "node:fs";', ctx("artifacts")],
    ["unprefixed built-in", 'import { spawn } from "child_process";', ctx("handoff")],
    ["network module in a pure package", 'import https from "node:https";', ctx("validation")],
    ["network global in a pure package", 'const r = await fetch("https://example.com");', ctx("baseline")],
    ["undeclared third-party package", 'import x from "left-pad";', ctx("workflow")],
    ["undeclared scoped third-party package", 'import x from "@acme/tool/sub";', ctx("workflow")],
  ];
  for (const [name, source, context] of cases) {
    test(name, () => {
      assert.ok(sourceViolations(source, context).length > 0, `expected a violation for: ${source}`);
    });
  }
});

describe("sourceViolations accepts", () => {
  const cases: Array<[string, string, FileContext]> = [
    ["declared workspace import", 'import { x } from "@design-loom/config";', ctx("workflow", ["@design-loom/config"])],
    ["relative import inside the package", 'import { x } from "./helpers/x.ts";', ctx("config")],
    ["pure built-in", 'import { createHash } from "node:crypto";', ctx("artifacts")],
    ["I/O built-in in an adapter package", 'import { readFile } from "node:fs/promises";', ctx("integrations")],
    ["network global in cli", 'await fetch("https://example.com");', ctx("cli")],
    ["declared third-party package", 'import x from "@acme/tool/sub";', ctx("workflow", ["@acme/tool"])],
  ];
  for (const [name, source, context] of cases) {
    test(name, () => {
      assert.deepEqual(sourceViolations(source, context), []);
    });
  }
});
