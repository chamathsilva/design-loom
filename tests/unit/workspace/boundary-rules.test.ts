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
    ["sub-path network built-in", 'import { lookup } from "node:dns/promises";', ctx("workflow")],
    ["sub-path readline built-in", 'import { createInterface } from "node:readline/promises";', ctx("workflow")],
    ["prefix-only sqlite built-in", 'import { DatabaseSync } from "node:sqlite";', ctx("artifacts")],
    ["process.getBuiltinModule", 'const fs = process.getBuiltinModule("node:fs");', ctx("config")],
    ["createRequire from node:module", 'import { createRequire } from "node:module";', ctx("config")],
    ["createRequire without an import", 'const r = createRequire(import.meta.url); r("fs");', ctx("config")],
    ["backtick dynamic import", "await import(`node:fs`);", ctx("validation")],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text containing a template specifier
    ["template dynamic import", "await import(`node:${name}`);", ctx("validation")],
    ["variable dynamic import", 'const m = "node:fs";\nawait import(m);', ctx("validation")],
    ["variable require", "const fs = require(name);", ctx("validation")],
    ["dynamic import of an expression", 'await import("node:" + "fs");', ctx("cli")],
    ["vm module", 'import { runInNewContext } from "node:vm";', ctx("validation")],
    ["os module", 'import { homedir } from "node:os";', ctx("handoff")],
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
    ["in-package folder whose name starts with dots", 'import { x } from "./..helpers/x.ts";', ctx("config")],
    ["parent import that stays in the package", 'import { x } from "../src/x.ts";', ctx("config")],
    ["pure built-in", 'import { createHash } from "node:crypto";', ctx("artifacts")],
    ["I/O built-in in an adapter package", 'import { readFile } from "node:fs/promises";', ctx("integrations")],
    ["network global in cli", 'await fetch("https://example.com");', ctx("cli")],
    ["method named fetch", "const row = store.fetch(id);", ctx("artifacts")],
    ["identifier ending in fetch", "const value = prefetch(id);", ctx("artifacts")],
    ["os module in an adapter package", 'import { EOL } from "node:os";', ctx("integrations")],
    ["declared third-party package", 'import x from "@acme/tool/sub";', ctx("workflow", ["@acme/tool"])],
  ];
  for (const [name, source, context] of cases) {
    test(name, () => {
      assert.deepEqual(sourceViolations(source, context), []);
    });
  }
});
