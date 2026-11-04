// Negative and positive cases proving the boundary checker can fail (backlog B01).

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type FileContext, findSpecifiers, maskSource, sourceViolations } from "./boundary-rules.ts";

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

  test("sees through comments between tokens and ignores imports inside comments and strings", () => {
    const source = [
      'import { a } from /* native */ "x1";',
      "import { b }\n  from // note\n  'x2';",
      '// import { c } from "not-me";',
      "const text = 'import d from \"not-me-either\"';",
    ].join("\n");
    assert.deepEqual(findSpecifiers(source), ["x1", "x2"]);
  });
});

describe("maskSource", () => {
  test("keeps length and line breaks, blanks comments, string contents and regex bodies", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text containing a template literal
    const source = 'a("x"); // c\nconst r = /"/g; const t = `t${b}u`; /* d */';
    const { code, bare } = maskSource(source);
    assert.equal(code.length, source.length);
    assert.equal(bare.length, source.length);
    assert.equal(code, 'a("x");     \nconst r = /"/g; const t = `t${b}u`;        ');
    assert.equal(bare, 'a(" ");     \nconst r = / /g; const t = ` ${b} `;        ');
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
    ["globalThis.fetch", 'await globalThis.fetch("https://example.com");', ctx("artifacts")],
    ["self.WebSocket", 'const ws = new self.WebSocket("wss://example.com");', ctx("artifacts")],
    ["process.env", "const token = process.env.TOKEN;", ctx("config")],
    ["node:process import", 'import { env } from "node:process";', ctx("config")],
    ["Date.now", "const at = Date.now();", ctx("handoff")],
    ["new Date()", "const at = new Date();", ctx("handoff")],
    ["performance.now", "const t = performance.now();", ctx("workflow")],
    ["Math.random", "const n = Math.random();", ctx("baseline")],
    ["crypto.randomUUID", "const id = crypto.randomUUID();", ctx("baseline")],
    ["randomBytes", 'import { randomBytes } from "node:crypto";\nconst b = randomBytes(4);', ctx("baseline")],
    ["comment before the specifier", 'import { readFileSync } from /* native API */ "node:fs";', ctx("artifacts")],
    ["line comment before the specifier", 'import { readFileSync }\n  from // native\n  "node:fs";', ctx("artifacts")],
    [
      "import after a regex literal with quotes",
      'const re = /["\']/;\nimport { readFileSync } from "node:fs";',
      ctx("artifacts"),
    ],
    ["relative import of a module beside src", 'export { read } from "../read-config.ts";', ctx("config")],
    ["JSON data from another package", 'import s from "../../validation/x.json" with { type: "json" };', ctx("config")],
    ["randomFillSync", 'import { randomFillSync } from "node:crypto";\nrandomFillSync(buffer);', ctx("baseline")],
    ["crypto.randomFill", "crypto.randomFill(buffer, done);", ctx("baseline")],
    ["aliased fetch", "const get = fetch;\nawait get(url);", ctx("artifacts")],
    ["fetch inside a template expression", "const s = `${await fetch(url)}`;", ctx("artifacts")],
    ["globalThis alias", "const g = globalThis;\ng.fetch(url);", ctx("artifacts")],
    ["globalThis.process", "const env = globalThis.process.env;", ctx("config")],
    ["aliased process", "const p = process;", ctx("config")],
    ["process by index", 'const env = process["env"];', ctx("config")],
    ["Date() without new", "const now = Date();", ctx("handoff")],
    ["eval", 'eval("1 + 1");', ctx("workflow")],
    ["new Function", 'const f = new Function("return 1");', ctx("workflow")],
    ["locale-dependent comparison", "names.sort((a, b) => a.localeCompare(b));", ctx("workflow")],
    ["Intl", "const f = new Intl.NumberFormat();", ctx("workflow")],
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
    ["a Date built from data", "const at = new Date(record.created_at);", ctx("artifacts")],
    ["a property named process", "const step = workflow.process.steps;", ctx("workflow")],
    ["randomness in an adapter package", "const id = crypto.randomUUID();", ctx("integrations")],
    ["identifier ending in fetch", "const value = prefetch(id);", ctx("artifacts")],
    ["os module in an adapter package", 'import { EOL } from "node:os";', ctx("integrations")],
    ["declared third-party package", 'import x from "@acme/tool/sub";', ctx("workflow", ["@acme/tool"])],
    [
      "prose in a line comment",
      "// Validates the build process. Calls fetch() later.\nexport const x = 1;",
      ctx("workflow"),
    ],
    ["an import in a block comment", '/* import x from "node:fs"; */\nexport const x = 1;', ctx("workflow")],
    ["words inside a string", 'const help = "run fetch(url) after process.env and Date.now()";', ctx("workflow")],
    ["words in template text", "const t = `Date.now() is ${value}`;", ctx("workflow")],
    ["a regex literal with quotes and slashes", 'const re = /^"[^"]*"\\/x$/u;', ctx("workflow")],
    ["an object key named fetch", "const options = { fetch: false };", ctx("workflow")],
    ["division, not a regex", "const r = total / count / 2;", ctx("workflow")],
    ["JSON data beside src", 'import s from "../schemas/a.schema.json" with { type: "json" };', ctx("validation")],
  ];
  for (const [name, source, context] of cases) {
    test(name, () => {
      assert.deepEqual(sourceViolations(source, context), []);
    });
  }
});

describe("known gaps (documented in boundary-rules.ts, covered by code review)", () => {
  test("a global property name built at run time is not detected", () => {
    assert.deepEqual(sourceViolations('self["fe" + "tch"](url);', ctx("artifacts")), []);
  });
});
