// `change init` and `artifact register` against real folders (backlog B06; design doc 07).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type CliContext, EXIT, type ResultEnvelope, runCli } from "@design-loom/cli";
import { loadRelease, readStoreIndex, SafeFileSystem } from "@design-loom/integrations";
import { validateAgainstSchema } from "@design-loom/validation";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CORE = join(ROOT, "packages", "config", "resources", "core");
const EXAMPLES = join(ROOT, "tests", "fixtures", "design", "examples");
const ENGINE = "a".repeat(64);

let scratch: string;
let resourcesSha256: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "design-loom-register-"));
  resourcesSha256 = (await loadRelease(await SafeFileSystem.open(CORE), ENGINE)).resourcesSha256;
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const context: CliContext = {
  releaseRoot: CORE,
  engineSha256: ENGINE,
  nodeVersion: "v24.22.2",
  now: () => new Date("2026-11-04T12:00:00.000Z"),
};

interface Run {
  code: number;
  envelope: ResultEnvelope;
}

async function run(args: string[]): Promise<Run> {
  let stdout = "";
  const code = await runCli([...args, "--json"], { stdout: (text) => (stdout += text), stderr: () => {} }, context);
  return { code, envelope: JSON.parse(stdout) };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const lock = (resources = resourcesSha256): Record<string, unknown> => ({
  schema_version: "1.0",
  framework_version: "0.1.0",
  engine_sha256: ENGINE,
  resources_sha256: resources,
  extensions_locked: [],
  schema_contract_version: "1.0",
});

/** An empty design repository for the example application. */
async function repository(resources?: string): Promise<string> {
  const root = join(scratch, `repo-${++counter}`);
  await mkdir(join(root, ".design-loom"), { recursive: true });
  await mkdir(join(root, "sources", "snapshots"), { recursive: true });
  await writeFile(join(root, ".design-loom", "app.json"), await readFile(join(EXAMPLES, "application.json")));
  await writeFile(join(root, ".design-loom", "framework.lock.json"), json(lock(resources)));
  return root;
}

const codes = (envelope: ResultEnvelope): string[] => envelope.diagnostics.map((entry) => entry.code);
const sha256 = (bytes: Uint8Array | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const readJson = async (root: string, path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, ...path.split("/")), "utf8"));
const exists = (root: string, path: string): Promise<boolean> =>
  readFile(join(root, ...path.split("/"))).then(
    () => true,
    () => false,
  );
const resultOf = (envelope: ResultEnvelope): { written: { path: string; sha256: string; bytes: number }[] } =>
  envelope.result as never;

const CHANGE = [
  "change",
  "init",
  "--id",
  "CHANGE-100",
  "--workflow",
  "core.feature-design",
  "--title",
  "Dashboard API",
];

async function withChange(): Promise<string> {
  const root = await repository();
  assert.equal((await run([...CHANGE, "--root", root])).code, EXIT.ok);
  return root;
}

async function saveContent(root: string, path: string, text = "# Design\n"): Promise<void> {
  await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(root, ...path.split("/")), text);
}

describe("change init", () => {
  test("creates the change folder, validates it and indexes it", async () => {
    const root = await repository();
    const { code, envelope } = await run([...CHANGE, "--root", root, "--owner-role", "engineering"]);
    assert.equal(code, EXIT.ok);
    assert.equal(envelope.status, "passed");
    assert.deepEqual(envelope.diagnostics, []);
    const { written } = resultOf(envelope);
    assert.deepEqual(
      written.map((file) => file.path),
      ["changes/CHANGE-100/traceability.json", "changes/CHANGE-100/change.json"],
    );
    for (const file of written) {
      const bytes = await readFile(join(root, ...file.path.split("/")));
      assert.equal(file.sha256, sha256(bytes));
      assert.equal(file.bytes, bytes.byteLength);
    }
    assert.equal(validateAgainstSchema("change", await readJson(root, "changes/CHANGE-100/change.json")).valid, true);

    const index = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: "sample-catalog" });
    assert.equal(index.changes.get("CHANGE-100")?.record.title, "Dashboard API");
    assert.deepEqual(index.diagnostics, []);
  });

  test("never overwrites an existing change", async () => {
    const root = await withChange();
    const before = await readFile(join(root, "changes", "CHANGE-100", "change.json"));
    const { code, envelope } = await run([...CHANGE, "--root", root, "--title", "Something else"]);
    assert.equal(code, EXIT.invalid);
    assert.equal(envelope.status, "failed");
    assert.deepEqual(codes(envelope), ["CHANGE_EXISTS"]);
    assert.deepEqual(resultOf(envelope).written, []);
    assert.deepEqual(await readFile(join(root, "changes", "CHANGE-100", "change.json")), before);
  });

  test("refuses when a required option is missing", async () => {
    const root = await repository();
    for (const missing of ["--id", "--workflow", "--title"]) {
      const args = [...CHANGE, "--root", root];
      args.splice(args.indexOf(missing), 2);
      const { code, envelope } = await run(args);
      assert.equal(code, EXIT.invalid, missing);
      assert.deepEqual(codes(envelope), ["CLI_MISSING_OPTION"], missing);
    }
    assert.equal(await exists(root, "changes/CHANGE-100/change.json"), false);
  });

  test("refuses IDs that aren't valid on every OS, without an internal error", async () => {
    const root = await repository();
    for (const id of ["NUL", "COM1", "CHANGE-1."]) {
      const { code, envelope } = await run([
        "change",
        "init",
        "--root",
        root,
        "--id",
        id,
        "--title",
        "X",
        "--workflow",
        "core.feature-design",
      ]);
      assert.equal(code, EXIT.invalid, id);
      assert.deepEqual(codes(envelope), ["REGISTER_UNPORTABLE_ID"], id);
    }
    assert.equal(await exists(root, "changes/NUL/change.json"), false);
  });

  test("refuses unknown workflows and sources without writing anything", async () => {
    const root = await repository();
    const { code, envelope } = await run([
      "change",
      "init",
      "--root",
      root,
      "--id",
      "CHANGE-101",
      "--title",
      "X",
      "--workflow",
      "no.such",
      "--source",
      "src-missing",
    ]);
    assert.equal(code, EXIT.invalid);
    assert.deepEqual(codes(envelope).sort(), ["REGISTER_UNKNOWN_SOURCE", "REGISTER_UNKNOWN_WORKFLOW"]);
    assert.equal(await exists(root, "changes/CHANGE-101/change.json"), false);
  });

  test("is refused when the lock doesn't match the plugin's resources", async () => {
    const root = await repository("f".repeat(64));
    const { code, envelope } = await run([...CHANGE, "--root", root]);
    assert.equal(code, EXIT.stale);
    assert.equal(envelope.status, "blocked");
    assert.equal(await exists(root, "changes/CHANGE-100/change.json"), false);
  });

  test("is refused when the application profile is missing", async () => {
    const root = join(scratch, `empty-${++counter}`);
    await mkdir(root, { recursive: true });
    const { code, envelope } = await run([...CHANGE, "--root", root]);
    assert.equal(code, EXIT.invalid);
    assert.equal(envelope.status, "failed");
    assert.equal(await exists(root, "changes/CHANGE-100/change.json"), false);
  });

  test("records its options in the input digest, so different requests differ", async () => {
    const [a, b] = [await repository(), await repository()];
    const first = await run([...CHANGE, "--root", a]);
    const second = await run([
      "change",
      "init",
      "--root",
      b,
      "--id",
      "CHANGE-100",
      "--workflow",
      "core.feature-design",
      "--title",
      "Other",
    ]);
    assert.notEqual(first.envelope.input_digest, second.envelope.input_digest);
  });

  test("reports an unwritable repository by error code", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async () => {
    const root = await repository();
    await mkdir(join(root, "changes"));
    await chmod(join(root, "changes"), 0o500);
    try {
      const { code, envelope } = await run([...CHANGE, "--root", root]);
      assert.equal(code, EXIT.unavailable);
      assert.deepEqual(codes(envelope), ["CLI_WRITE_FAILED"]);
      assert.ok(envelope.diagnostics[0]?.message.includes("EACCES"));
      assert.ok(!envelope.diagnostics[0]?.message.includes(root), "no local path in the message");
    } finally {
      await chmod(join(root, "changes"), 0o700);
    }
  });
});

const register = (root: string, ...more: string[]): Promise<Run> =>
  run([
    "artifact",
    "register",
    "--root",
    root,
    "--id",
    "DESIGN-100",
    "--type",
    "engineering-design",
    "--owner-role",
    "engineering",
    ...more,
  ]);

describe("artifact register: change scope", () => {
  test("registers an artifact whose content is already in the change's folder", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/design.md");
    const { code, envelope } = await register(
      root,
      "--change",
      "CHANGE-100",
      "--content",
      "changes/CHANGE-100/content/design.md",
      "--title",
      "Dashboard engineering",
    );
    assert.equal(code, EXIT.ok, JSON.stringify(envelope.diagnostics));
    assert.equal(envelope.status, "passed");
    const path = "changes/CHANGE-100/artifacts/DESIGN-100.json";
    assert.deepEqual(
      resultOf(envelope).written.map((file) => file.path),
      [path],
    );
    const record = await readJson(root, path);
    assert.equal(record.workflow_step, "engineering");
    assert.equal(record.state, "draft");

    // The index agrees: the bytes verify, and the digest the command reported is the indexed one.
    const index = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: "sample-catalog" });
    const indexed = index.artifacts.get("DESIGN-100");
    assert.equal(indexed?.bytesVerified, true);
    assert.equal((envelope.result as { semantic_digest: string }).semantic_digest, indexed?.semanticDigest);
    assert.deepEqual(index.diagnostics, []);
  });

  test("binds a context receipt to a dependency registered earlier", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/requirements.md", "# Requirements\n");
    await saveContent(root, "changes/CHANGE-100/content/design.md");
    const first = await run([
      "artifact",
      "register",
      "--root",
      root,
      "--id",
      "REQDOC-100",
      "--type",
      "requirements",
      "--owner-role",
      "qa",
      "--change",
      "CHANGE-100",
      "--content",
      "changes/CHANGE-100/content/requirements.md",
    ]);
    assert.equal(first.code, EXIT.ok, JSON.stringify(first.envelope.diagnostics));
    const second = await register(
      root,
      "--change",
      "CHANGE-100",
      "--content",
      "changes/CHANGE-100/content/design.md",
      "--depends-on",
      "REQDOC-100",
    );
    assert.equal(second.code, EXIT.ok, JSON.stringify(second.envelope.diagnostics));
    const record = (await readJson(root, "changes/CHANGE-100/artifacts/DESIGN-100.json")) as {
      context: { references: { id: string; sha256: string }[] };
    };
    assert.deepEqual(
      record.context.references.map((reference) => reference.id),
      ["REQDOC-100"],
    );
    const index = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: "sample-catalog" });
    assert.equal(record.context.references[0]?.sha256, index.artifacts.get("REQDOC-100")?.semanticDigest);
  });

  test("never overwrites an existing artifact, even under a different case", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/design.md");
    const args = ["--change", "CHANGE-100", "--content", "changes/CHANGE-100/content/design.md"];
    assert.equal((await register(root, ...args)).code, EXIT.ok);
    const path = "changes/CHANGE-100/artifacts/DESIGN-100.json";
    const before = await readFile(join(root, ...path.split("/")));
    const again = await register(root, ...args, "--title", "Changed");
    assert.equal(again.code, EXIT.invalid);
    assert.deepEqual(codes(again.envelope), ["ARTIFACT_EXISTS"]);
    assert.deepEqual(await readFile(join(root, ...path.split("/"))), before);

    // The same ID in another case is the same artifact on a case-insensitive disk, so it is refused too.
    const lower = await run([
      "artifact",
      "register",
      "--root",
      root,
      "--id",
      "design-100",
      "--type",
      "engineering-design",
      "--owner-role",
      "engineering",
      ...args,
    ]);
    assert.equal(lower.code, EXIT.invalid);
    assert.deepEqual(codes(lower.envelope), ["ARTIFACT_EXISTS"]);
    assert.deepEqual(await readdir(join(root, "changes", "CHANGE-100", "artifacts")), ["DESIGN-100.json"]);
    assert.deepEqual(await readFile(join(root, ...path.split("/"))), before);
  });

  test("of two simultaneous registrations of one ID, exactly one wins", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/a.md", "A\n");
    await saveContent(root, "changes/CHANGE-100/content/b.md", "B\n");
    const runs = await Promise.all(
      ["a", "b"].map((name) =>
        register(root, "--change", "CHANGE-100", "--content", `changes/CHANGE-100/content/${name}.md`),
      ),
    );
    assert.deepEqual(runs.map((entry) => entry.code).sort(), [EXIT.ok, EXIT.invalid]);
    const loser = runs.find((entry) => entry.code === EXIT.invalid);
    assert.ok(
      codes(loser?.envelope as ResultEnvelope).some((code) =>
        ["REGISTER_WRITE_REFUSED", "ARTIFACT_EXISTS"].includes(code),
      ),
    );
    const winner = runs.find((entry) => entry.code === EXIT.ok);
    const record = (await readJson(root, "changes/CHANGE-100/artifacts/DESIGN-100.json")) as {
      content: { sha256: string };
    };
    assert.ok(winner);
    assert.ok([sha256(Buffer.from("A\n")), sha256(Buffer.from("B\n"))].includes(record.content.sha256));
  });

  test("refuses content that is missing, outside its scope or unsafe, and writes nothing", async () => {
    const root = await withChange();
    await saveContent(root, "docs/design.md");
    await saveContent(root, "shared/content/design.md");
    const cases: [string, string, number][] = [
      ["changes/CHANGE-100/content/missing.md", "REGISTER_CONTENT_MISSING", EXIT.invalid],
      ["docs/design.md", "REGISTER_CONTENT_OUTSIDE_SCOPE", EXIT.invalid],
      ["shared/content/design.md", "REGISTER_CONTENT_OUTSIDE_SCOPE", EXIT.invalid],
      ["../outside.md", "REGISTER_UNSAFE_PATH", EXIT.invalid],
    ];
    for (const [path, expected, exit] of cases) {
      const { code, envelope } = await register(root, "--change", "CHANGE-100", "--content", path);
      assert.equal(code, exit, path);
      assert.deepEqual(codes(envelope), [expected], path);
      assert.ok(!JSON.stringify(envelope.diagnostics).includes(root), "no local path in diagnostics");
    }
    assert.equal(await exists(root, "changes/CHANGE-100/artifacts/DESIGN-100.json"), false);
  });

  test("accepts Windows separators and stores the path with forward slashes", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/design.md");
    const { code, envelope } = await register(
      root,
      "--change",
      "CHANGE-100",
      "--content",
      "changes\\CHANGE-100\\content\\design.md",
    );
    assert.equal(code, EXIT.ok, JSON.stringify(envelope.diagnostics));
    const record = (await readJson(root, "changes/CHANGE-100/artifacts/DESIGN-100.json")) as {
      content: { path: string };
    };
    assert.equal(record.content.path, "changes/CHANGE-100/content/design.md");
  });

  test("refuses an unknown change and an unknown dependency", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/design.md");
    const unknownChange = await register(
      root,
      "--change",
      "CHANGE-404",
      "--content",
      "changes/CHANGE-404/content/x.md",
    );
    assert.equal(unknownChange.code, EXIT.invalid);
    const dependency = await register(
      root,
      "--change",
      "CHANGE-100",
      "--content",
      "changes/CHANGE-100/content/design.md",
      "--depends-on",
      "NOPE-001",
    );
    assert.deepEqual(codes(dependency.envelope), ["REGISTER_UNKNOWN_DEPENDENCY"]);
  });

  test("a QA artifact covers several changes", async () => {
    const root = await withChange();
    assert.equal(
      (
        await run([
          "change",
          "init",
          "--root",
          root,
          "--id",
          "CHANGE-101",
          "--workflow",
          "core.feature-design",
          "--title",
          "CRUD",
        ])
      ).code,
      EXIT.ok,
    );
    assert.equal(
      (
        await run([
          "change",
          "init",
          "--root",
          root,
          "--id",
          "QA-100",
          "--workflow",
          "core.feature-design",
          "--title",
          "QA",
          "--owner-role",
          "qa",
        ])
      ).code,
      EXIT.ok,
    );
    await saveContent(root, "changes/QA-100/content/campaign.md", "# Campaign\n");
    const { code, envelope } = await run([
      "artifact",
      "register",
      "--root",
      root,
      "--id",
      "QA-BATCH-100",
      "--type",
      "test-design",
      "--change",
      "QA-100",
      "--content",
      "changes/QA-100/content/campaign.md",
      "--covered-change",
      "CHANGE-100",
      "--covered-change",
      "CHANGE-101",
    ]);
    assert.equal(code, EXIT.ok, JSON.stringify(envelope.diagnostics));
    const record = await readJson(root, "changes/QA-100/artifacts/QA-BATCH-100.json");
    assert.deepEqual(record.covered_change_ids, ["CHANGE-100", "CHANGE-101"]);
  });
});

describe("artifact register: project scope and ownership", () => {
  test("registers a shared artifact without a change owner", async () => {
    const root = await repository();
    await saveContent(root, "shared/content/errors.md", "# Errors\n");
    const { code, envelope } = await run([
      "artifact",
      "register",
      "--root",
      root,
      "--id",
      "SHARED-100",
      "--type",
      "contract",
      "--owner-role",
      "architecture",
      "--scope",
      "project",
      "--content",
      "shared/content/errors.md",
    ]);
    assert.equal(code, EXIT.ok, JSON.stringify(envelope.diagnostics));
    const record = await readJson(root, "shared/artifacts/SHARED-100.json");
    assert.equal(record.scope, "project");
    assert.equal("change_id" in record, false);
    assert.equal("workflow_step" in record, false);
    const index = await readStoreIndex(await SafeFileSystem.open(root), { applicationId: "sample-catalog" });
    assert.equal(index.artifacts.get("SHARED-100")?.scope, "project");
    assert.deepEqual(index.diagnostics, []);
  });

  test("exactly one of --change or --scope project is required", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/design.md");
    const content = ["--content", "changes/CHANGE-100/content/design.md"];
    const cases: [string[], string][] = [
      [[], "CLI_OWNERSHIP_REQUIRED"],
      [["--change", "CHANGE-100", "--scope", "project"], "CLI_OWNERSHIP_REQUIRED"],
      [["--scope", "everything"], "CLI_INVALID_SCOPE"],
    ];
    for (const [extra, expected] of cases) {
      const { code, envelope } = await register(root, ...content, ...extra);
      assert.equal(code, EXIT.invalid, extra.join(" "));
      assert.deepEqual(codes(envelope), [expected], extra.join(" "));
    }
  });

  test("project artifacts refuse covered changes and change-artifact dependencies", async () => {
    const root = await withChange();
    await saveContent(root, "changes/CHANGE-100/content/design.md");
    await saveContent(root, "shared/content/errors.md");
    assert.equal(
      (await register(root, "--change", "CHANGE-100", "--content", "changes/CHANGE-100/content/design.md")).code,
      EXIT.ok,
    );
    const project = (...more: string[]): Promise<Run> =>
      run([
        "artifact",
        "register",
        "--root",
        root,
        "--id",
        "SHARED-100",
        "--type",
        "contract",
        "--owner-role",
        "architecture",
        "--scope",
        "project",
        "--content",
        "shared/content/errors.md",
        ...more,
      ]);
    assert.deepEqual(codes((await project("--covered-change", "CHANGE-100")).envelope), [
      "REGISTER_COVERED_CHANGES_NEED_CHANGE_SCOPE",
    ]);
    assert.deepEqual(codes((await project("--depends-on", "DESIGN-100")).envelope), [
      "REGISTER_PROJECT_DEPENDS_ON_CHANGE",
    ]);
    assert.equal(await exists(root, "shared/artifacts/SHARED-100.json"), false);
  });

  test("an artifact has one owner role", async () => {
    const root = await withChange();
    const { code, envelope } = await register(
      root,
      "--owner-role",
      "qa",
      "--change",
      "CHANGE-100",
      "--content",
      "changes/CHANGE-100/content/design.md",
    );
    assert.equal(code, EXIT.invalid);
    assert.deepEqual(codes(envelope), ["CLI_TOO_MANY_OPTIONS"]);
  });
});
