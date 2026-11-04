// Toolchain pins that keep installs and digests reproducible (backlog B01, DL-Q01, DL-Q04).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const rootPackage = JSON.parse(read("package.json")) as {
  engines: { node: string; npm: string };
  packageManager: string;
  devDependencies: Record<string, string>;
};

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const pinnedNode = read(".nvmrc").trim();
const pinnedNpm = rootPackage.packageManager.replace(/^npm@/, "");

/** Compares two x.y.z versions numerically. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

test(".nvmrc pins an exact Node release that the engines range starts from", () => {
  assert.match(pinnedNode, EXACT_VERSION);
  const major = Number(pinnedNode.split(".")[0]);
  assert.equal(rootPackage.engines.node, `>=${pinnedNode} <${major + 1}`);
});

test("packageManager pins an exact npm release that the engines range starts from", () => {
  assert.match(rootPackage.packageManager, /^npm@\d+\.\d+\.\d+$/);
  const major = Number(pinnedNpm.split(".")[0]);
  assert.equal(rootPackage.engines.npm, `>=${pinnedNpm} <${major + 1}`);
});

test("tests run on a Node release inside the engines range", () => {
  const running = process.versions.node;
  assert.equal(running.split(".")[0], pinnedNode.split(".")[0], `running Node ${running}`);
  assert.ok(compareVersions(running, pinnedNode) >= 0, `running Node ${running} is older than ${pinnedNode}`);
});

test("when run through npm, npm is inside the engines range", (t) => {
  // npm sets this for scripts, for example "npm/11.19.1 node/v24.22.2 darwin arm64".
  const agent = process.env.npm_config_user_agent ?? "";
  const running = /^npm\/(\d+\.\d+\.\d+)/.exec(agent)?.[1];
  if (running === undefined) {
    t.skip("not started by npm");
    return;
  }
  assert.equal(running.split(".")[0], pinnedNpm.split(".")[0], `running npm ${running}`);
  assert.ok(compareVersions(running, pinnedNpm) >= 0, `running npm ${running} is older than ${pinnedNpm}`);
});

test("development tools are pinned exactly and installs enforce engines", () => {
  for (const [name, version] of Object.entries(rootPackage.devDependencies)) {
    assert.match(version, EXACT_VERSION, `${name} must be pinned exactly`);
  }
  assert.match(read(".npmrc"), /^save-exact=true$/m);
  assert.match(read(".npmrc"), /^engine-strict=true$/m);
});

test("text files are stored with LF line endings on every platform", () => {
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/m);
});

test("checked-out text files contain no carriage returns", () => {
  // Proves the rule above on each CI platform, using the files Git actually checked out.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const textFiles = tracked.filter((file) =>
    /\.(?:ts|json|md|ya?ml|txt)$|(?:^|\/)\.(?:nvmrc|npmrc|gitignore|gitattributes|editorconfig)$/.test(file),
  );
  assert.ok(textFiles.length > 0);
  const withCr = textFiles.filter((file) => readFileSync(join(ROOT, file)).includes(0x0d));
  assert.deepEqual(withCr, []);
});
