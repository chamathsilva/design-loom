// Reading a design repository from disk into the store index (backlog B05).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildStoreIndex } from "@design-loom/artifacts";
import { readStoreIndex, SafeFileSystem } from "@design-loom/integrations";
import { SAMPLE_APPLICATION_ID, sampleRepository, storeInput } from "../../support/sample-store.ts";

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "design-loom-store-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeRepository(name: string, repo = sampleRepository()): Promise<string> {
  const root = join(scratch, name);
  for (const [path, bytes] of repo) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await mkdir(root, { recursive: true });
  return root;
}

async function trySymlink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("store reader", () => {
  test("reading from disk gives the same index as the in-memory scan", async () => {
    const root = await writeRepository("same");
    const fromDisk = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: SAMPLE_APPLICATION_ID });
    const inMemory = buildStoreIndex(storeInput(sampleRepository()));
    assert.deepEqual(fromDisk.diagnostics, inMemory.diagnostics);
    assert.deepEqual([...fromDisk.artifacts.keys()], [...inMemory.artifacts.keys()]);
    for (const [id, artifact] of inMemory.artifacts) {
      assert.equal(fromDisk.artifacts.get(id)?.semanticDigest, artifact.semanticDigest, id);
      assert.equal(fromDisk.artifacts.get(id)?.sha256, artifact.sha256, id);
    }
  });

  test("an empty repository has an empty index and no diagnostics", async () => {
    const root = join(scratch, "empty");
    await mkdir(root);
    const result = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: SAMPLE_APPLICATION_ID });
    assert.equal(result.artifacts.size, 0);
    assert.deepEqual(result.diagnostics, []);
  });

  test("content folders are not listed", async () => {
    const repo = sampleRepository();
    repo.set("changes/CHANGE-001/content/stray.json", new TextEncoder().encode("{"));
    const root = await writeRepository("content-not-listed", repo);
    const result = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: SAMPLE_APPLICATION_ID });
    assert.ok(!result.diagnostics.some((entry) => entry.path.includes("stray.json")));
  });

  test("a symlinked record folder is reported, not followed", async (t) => {
    const root = await writeRepository("linked-folder");
    const outside = await writeRepository("linked-outside");
    if (!(await trySymlink(join(outside, "changes", "CHANGE-002"), join(root, "changes", "CHANGE-009")))) {
      t.skip("symlinks need extra privileges on this OS");
      return;
    }
    const result = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: SAMPLE_APPLICATION_ID });
    const warning = result.diagnostics.find((entry) => entry.code === "STORE_SYMLINK_IGNORED");
    assert.equal(warning?.path, "changes/CHANGE-009");
    assert.equal(result.changes.has("CHANGE-009"), false);
  });

  test("content behind a symlink that leaves the root is not hashed", async (t) => {
    const root = await writeRepository("linked-content");
    const outside = join(scratch, "outside-content");
    await mkdir(outside);
    await writeFile(join(outside, "engineering.md"), "anything");
    const contentFolder = join(root, "changes", "CHANGE-001", "content");
    await rm(contentFolder, { recursive: true });
    if (!(await trySymlink(outside, contentFolder))) {
      t.skip("symlinks need extra privileges on this OS");
      return;
    }
    const result = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: SAMPLE_APPLICATION_ID });
    assert.ok(result.diagnostics.some((entry) => entry.code === "STORE_REFERENCE_UNREADABLE"));
    assert.equal(result.artifacts.get("DESIGN-001")?.semanticDigest, null);
  });

  test("a content path whose case differs from the file on disk is not trusted", async () => {
    const repo = sampleRepository();
    const bytes = repo.get("changes/CHANGE-001/content/engineering.md") as Uint8Array;
    repo.delete("changes/CHANGE-001/content/engineering.md");
    repo.set("changes/CHANGE-001/content/Engineering.md", bytes);
    const root = await writeRepository("case", repo);
    const result = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: SAMPLE_APPLICATION_ID });
    assert.equal(result.artifacts.get("DESIGN-001")?.bytesVerified, false);
    assert.ok(result.diagnostics.some((entry) => entry.severity === "error"));
  });

  test("listDirectory sorts entries and refuses paths outside the root", async () => {
    const root = await writeRepository("listing");
    const fs = await SafeFileSystem.open(root);
    const names = (await fs.listDirectory("changes")).map((entry) => entry.name);
    assert.deepEqual(names, ["CHANGE-001", "CHANGE-002", "QA-CAMPAIGN-001"]);
    assert.deepEqual(
      (await fs.listDirectory("")).map((entry) => `${entry.name}:${entry.kind}`),
      [
        "baselines:directory",
        "changes:directory",
        "findings.json:file",
        "late-qa:directory",
        "shared:directory",
        "sources:directory",
        "traceability.json:file",
      ],
    );
    await assert.rejects(fs.listDirectory("../"), /\.\./);
    await assert.rejects(fs.listDirectory("baselines/BASELINE-001.json"), { code: "not-a-file" });
    await assert.rejects(fs.listDirectory("nowhere"), { code: "not-found" });
  });
});
