// Safe file-system adapter against a real temporary directory (backlog B03, acceptance AT-21).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PathPolicyError, sha256Hex } from "@design-loom/config";
import { SafeFileSystem, SafeFsError } from "@design-loom/integrations";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

let base: string;
let root: string;
let outside: string;
let fs: SafeFileSystem;

before(async () => {
  base = await mkdtemp(join(tmpdir(), "design-loom-safe-fs-"));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside");
  fs = await SafeFileSystem.open(root);
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * Creates a symlink, skipping the test where the OS doesn't allow it. On Windows, folder links use
 * junctions (no admin rights needed); file symlinks need Developer Mode or admin rights.
 */
async function trySymlink(
  t: { skip: (message: string) => void },
  target: string,
  path: string,
  kind: "file" | "dir" = "file",
): Promise<boolean> {
  const type = kind === "dir" ? (process.platform === "win32" ? "junction" : "dir") : "file";
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("symlinks need extra privileges on this OS");
      return false;
    }
    throw error;
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof SafeFsError && error.code === code);
}

describe("writeAtomic", () => {
  test("creates a new file and its folders", async () => {
    await fs.writeAtomic("changes/CHANGE-001/change.json", bytes("{}"));
    assert.equal(await readFile(join(root, "changes", "CHANGE-001", "change.json"), "utf8"), "{}");
  });

  test("refuses to overwrite without an expected digest", async () => {
    await fs.writeAtomic("a.txt", bytes("one"));
    await expectCode(fs.writeAtomic("a.txt", bytes("two")), "exists");
    assert.equal(text(await fs.readBytes("a.txt")), "one");
  });

  test("replaces a file when the expected digest matches", async () => {
    await fs.writeAtomic("b.txt", bytes("one"));
    await fs.writeAtomic("b.txt", bytes("two"), { expectedSha256: sha256Hex(bytes("one")) });
    assert.equal(text(await fs.readBytes("b.txt")), "two");
  });

  test("refuses a replacement when the file changed", async () => {
    await fs.writeAtomic("c.txt", bytes("one"));
    await expectCode(
      fs.writeAtomic("c.txt", bytes("two"), { expectedSha256: sha256Hex(bytes("stale")) }),
      "digest-mismatch",
    );
    assert.equal(text(await fs.readBytes("c.txt")), "one");
  });

  test("rejects a malformed expected digest before touching the disk", async () => {
    await fs.writeAtomic("d.txt", bytes("one"));
    await expectCode(
      fs.writeAtomic("d.txt", bytes("two"), { expectedSha256: sha256Hex(bytes("one")).toUpperCase() }),
      "invalid-digest",
    );
    assert.equal(text(await fs.readBytes("d.txt")), "one");
  });

  test("writes a file whose name is at the 255-byte limit", async () => {
    const name = "n".repeat(255);
    await fs.writeAtomic(name, bytes("long"));
    assert.equal(text(await fs.readBytes(name)), "long");
  });

  test("refuses a replacement of a missing file", async () => {
    await expectCode(fs.writeAtomic("missing.txt", bytes("x"), { expectedSha256: sha256Hex(bytes("x")) }), "not-found");
  });

  test("leaves no temporary files behind, including after a refusal", async () => {
    await fs.writeAtomic("tidy/x.txt", bytes("x"));
    await expectCode(fs.writeAtomic("tidy/x.txt", bytes("y")), "exists");
    assert.deepEqual(await readdir(join(root, "tidy")), ["x.txt"]);
  });

  test("refuses a name that differs from an existing file only by case", async () => {
    await fs.writeAtomic("notes/Readme.md", bytes("x"));
    await expectCode(fs.writeAtomic("notes/README.md", bytes("y")), "case-collision");
  });

  test("refuses a folder that differs from an existing folder only by case", async () => {
    await fs.writeAtomic("Docs/a.md", bytes("x"));
    await expectCode(fs.writeAtomic("docs/b.md", bytes("y")), "case-collision");
  });

  test("rejects unsafe paths before touching the disk", async () => {
    for (const path of ["../escape.txt", "/abs.txt", "C:\\x.txt", "a/../../x.txt"]) {
      await assert.rejects(fs.writeAtomic(path, bytes("x")), PathPolicyError, path);
    }
    assert.deepEqual(await readdir(outside), ["secret.txt"]);
  });

  test("refuses to write through a symlinked folder that leaves the root", async (t) => {
    if (!(await trySymlink(t, outside, join(root, "link-out"), "dir"))) return;
    await expectCode(fs.writeAtomic("link-out/new.txt", bytes("x")), "outside-root");
    assert.deepEqual(await readdir(outside), ["secret.txt"]);
  });

  test("refuses to write through a symlink at the target", async (t) => {
    await writeFile(join(root, "real.txt"), "real");
    if (!(await trySymlink(t, join(root, "real.txt"), join(root, "alias.txt")))) return;
    await expectCode(
      fs.writeAtomic("alias.txt", bytes("x"), { expectedSha256: sha256Hex(bytes("real")) }),
      "symlink-target",
    );
    assert.equal(await readFile(join(root, "real.txt"), "utf8"), "real");
  });
});

describe("readBytes", () => {
  test("reads a file inside the root", async () => {
    await fs.writeAtomic("read/me.txt", bytes("hello"));
    assert.equal(text(await fs.readBytes("read/me.txt")), "hello");
  });

  test("reports a missing file", async () => {
    await expectCode(fs.readBytes("nope.txt"), "not-found");
  });

  test("requires the exact on-disk name", async () => {
    await fs.writeAtomic("exact/Name.txt", bytes("x"));
    await expectCode(fs.readBytes("exact/name.txt"), "case-collision");
  });

  test("refuses a symlink that leads outside the root", async (t) => {
    if (!(await trySymlink(t, join(outside, "secret.txt"), join(root, "leak.txt")))) return;
    await expectCode(fs.readBytes("leak.txt"), "outside-root");
  });

  test("allows a symlink that stays inside the root", async (t) => {
    await fs.writeAtomic("inside/target.txt", bytes("ok"));
    if (!(await trySymlink(t, join(root, "inside", "target.txt"), join(root, "inside-link.txt")))) return;
    assert.equal(text(await fs.readBytes("inside-link.txt")), "ok");
  });
});

describe("open", () => {
  test("requires an absolute root", async () => {
    await expectCode(SafeFileSystem.open("relative/root"), "outside-root");
  });
});
