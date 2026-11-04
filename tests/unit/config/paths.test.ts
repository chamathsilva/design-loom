// Relative-path policy (backlog B03, design doc 03 "Limits and paths", acceptance AT-21 and AT-30).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  caseFoldKey,
  findCaseFoldCollisions,
  isSafeRelativePath,
  normalizeRelativePath,
  PathPolicyError,
} from "@design-loom/config";

describe("normalizeRelativePath accepts", () => {
  const cases: Array<[string, string]> = [
    ["changes/CHANGE-001/change.json", "changes/CHANGE-001/change.json"],
    ["changes\\CHANGE-001\\content\\design.md", "changes/CHANGE-001/content/design.md"],
    [".design-loom/app.json", ".design-loom/app.json"],
    ["shared/content/é-status.md", "shared/content/é-status.md"],
    ["a..b/..c", "a..b/..c"],
    ["console.md", "console.md"],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      assert.equal(normalizeRelativePath(input), expected);
    });
  }

  test("a directory prefix when allowed", () => {
    assert.equal(normalizeRelativePath("src\\", { allowDirectoryPrefix: true }), "src/");
  });
});

describe("normalizeRelativePath rejects", () => {
  const cases: Array<[string, string]> = [
    ["empty path", ""],
    ["absolute POSIX path", "/etc/passwd"],
    ["UNC path", "\\\\server\\share\\x"],
    ["root-relative Windows path", "\\Windows\\x"],
    ["drive-letter path", "C:\\x.md"],
    ["drive-relative path", "C:x.md"],
    ["parent segment", "changes/../../x"],
    ["leading parent segment", "../x"],
    ["dot segment", "./x"],
    ["empty segment", "a//b"],
    ["NUL character", "a\0b"],
    ["control character", "a\u0007b"],
    ["NTFS stream", "file.md:hidden"],
    ["Windows-invalid character", "what?.md"],
    ["trailing dot", "notes./x.md"],
    ["trailing space", "notes /x.md"],
    ["reserved device name", "con"],
    ["reserved device name with extension", "docs/NUL.txt"],
    ["reserved COM port", "com1.json"],
    ["unpaired surrogate", "a\ud800b"],
    ["trailing slash when not allowed", "src/"],
  ];
  for (const [name, input] of cases) {
    test(name, () => {
      assert.throws(() => normalizeRelativePath(input), PathPolicyError);
      assert.equal(isSafeRelativePath(input), false);
    });
  }
});

describe("case-fold collisions", () => {
  test("maps case, ß and accent composition together", () => {
    assert.equal(caseFoldKey("README.md"), caseFoldKey("readme.MD"));
    assert.equal(caseFoldKey("Straße"), caseFoldKey("STRASSE"));
    assert.equal(caseFoldKey("caf\u00e9"), caseFoldKey("cafe\u0301"));
  });

  test("finds collisions between whole paths and folder prefixes", () => {
    assert.deepEqual(findCaseFoldCollisions(["docs/a.md", "Docs/b.md", "src/x.ts", "src/X.ts", "lib/y.ts"]), [
      ["Docs", "docs"],
      ["src/X.ts", "src/x.ts"],
    ]);
  });

  test("reports nothing for distinct paths", () => {
    assert.deepEqual(findCaseFoldCollisions(["a/b.md", "a/c.md", "b/b.md"]), []);
  });
});
