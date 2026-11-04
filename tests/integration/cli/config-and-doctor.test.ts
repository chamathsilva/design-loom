// `config resolve` and `doctor` from the command line (backlog B04; design docs 03, 06, 07 and 08).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { type CliContext, EXIT, type ResultEnvelope, runCli } from "@design-loom/cli";
import { effectiveConfigDigest } from "@design-loom/config";
import { loadExtension, loadRelease, SafeFileSystem } from "@design-loom/integrations";
import { validateAgainstSchema } from "@design-loom/validation";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CORE = join(ROOT, "packages", "config", "resources", "core");
const EXAMPLES = join(ROOT, "tests", "fixtures", "design", "examples");
const MAIN = join(ROOT, "packages", "cli", "src", "main.ts");
const ENGINE = "a".repeat(64);
const FIXTURE_DIGEST = "8922d7247113ee502e1e45e8726e69be57223974d197fb7f558fa73eb6ccdbcc";

let scratch: string;
let resourcesSha256: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "design-loom-cli-"));
  resourcesSha256 = (await loadRelease(await SafeFileSystem.open(CORE), ENGINE)).resourcesSha256;
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const context = (overrides: Partial<CliContext> = {}): CliContext => ({
  releaseRoot: CORE,
  engineSha256: ENGINE,
  nodeVersion: "v24.22.2",
  now: () => new Date("2026-11-04T12:00:00.000Z"),
  ...overrides,
});

interface Run {
  code: number;
  envelope: ResultEnvelope;
  stderr: string;
}

async function run(args: string[], overrides: Partial<CliContext> = {}): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    [...args, "--json"],
    { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    context(overrides),
  );
  return { code, envelope: JSON.parse(stdout), stderr };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function lockFor(extensions: { id: string; version: string; sha256: string }[] = []): Record<string, unknown> {
  return {
    schema_version: "1.0",
    framework_version: "0.1.0",
    engine_sha256: ENGINE,
    resources_sha256: resourcesSha256,
    extensions_locked: extensions,
    schema_contract_version: "1.0",
  };
}

/**
 * A design repository for the example application, with everything its default workflow needs:
 * a sources/snapshots folder, a Git checkout, and a mapped checkout for catalog-api.
 */
async function application(options: { lock?: Record<string, unknown>; map?: boolean } = {}): Promise<string> {
  const root = join(scratch, `app-${++counter}`);
  await mkdir(join(root, ".design-loom"), { recursive: true });
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "sources", "snapshots"), { recursive: true });
  await writeFile(join(root, ".design-loom", "app.json"), await readFile(join(EXAMPLES, "application.json")));
  await writeFile(join(root, ".design-loom", "framework.lock.json"), json(options.lock ?? lockFor()));
  if (options.map !== false) {
    const api = join(scratch, `api-${counter}`);
    await mkdir(join(api, ".git"), { recursive: true });
    await writeFile(
      join(root, ".design-loom", "workspace.local.json"),
      json({ schema_version: "1.0", repositories: [{ id: "catalog-api", checkout_path: api }] }),
    );
  }
  return root;
}

async function editJson(path: string, edit: (value: Record<string, unknown>) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8"));
  edit(value);
  await writeFile(path, json(value));
}

const codes = (envelope: ResultEnvelope): string[] => envelope.diagnostics.map((entry) => entry.code);

describe("config resolve", () => {
  test("resolves the application and reports the effective config digest", async () => {
    const root = await application();
    const { code, envelope } = await run(["config", "resolve", "--root", root]);
    assert.equal(code, EXIT.ok);
    assert.equal(envelope.status, "passed");
    assert.deepEqual(envelope.diagnostics, []);
    const result = envelope.result as {
      effective_config_digest: string;
      effective_config: { schema_version: string; configuration: unknown };
      lock: { ok: boolean };
    };
    assert.equal(result.lock.ok, true);
    assert.equal(result.effective_config_digest, effectiveConfigDigest(result.effective_config));
  });

  test("the envelope is a valid run report plus the command's result", async () => {
    const root = await application();
    const { envelope } = await run(["config", "resolve", "--root", root]);
    const { result: _result, ...report } = envelope;
    assert.deepEqual(validateAgainstSchema("run", report).issues, []);
    assert.equal(envelope.command, "config resolve");
    assert.equal(envelope.root, root);
    assert.equal(envelope.framework_version, "0.1.0");
    assert.equal(envelope.created_at, "2026-11-04T12:00:00Z");
  });

  test("the input digest depends on the inputs, not on the run or the root path", async () => {
    const first = await run(["config", "resolve", "--root", await application()]);
    const second = await run(["config", "resolve", "--root", await application()]);
    assert.equal(first.envelope.input_digest, second.envelope.input_digest);
    assert.notEqual(first.envelope.run_id, second.envelope.run_id);
  });

  test("the design's example application resolves to the design's recorded digest", async () => {
    const root = await application({ lock: JSON.parse(await readFile(join(EXAMPLES, "framework-lock.json"), "utf8")) });
    const { code, envelope } = await run(["config", "resolve", "--root", root]);
    // The example lock pins synthetic resource digests, so the run is blocked as stale ...
    assert.equal(code, EXIT.stale);
    assert.equal(envelope.status, "blocked");
    assert.deepEqual(codes(envelope), ["CONFIG_LOCK_RESOURCES_MISMATCH"]);
    // ... but the configuration it explains is exactly the design fixture's.
    assert.equal((envelope.result as { effective_config_digest: string }).effective_config_digest, FIXTURE_DIGEST);
  });

  test("running from source is degraded: the engine can't be compared", async () => {
    const { code, envelope } = await run(["config", "resolve", "--root", await application()], { engineSha256: null });
    assert.equal(code, EXIT.ok);
    assert.equal(envelope.status, "degraded");
    assert.deepEqual(codes(envelope), ["CONFIG_LOCK_ENGINE_UNKNOWN"]);
  });

  test("a locked extension resolves; editing its files makes the lock stale", async () => {
    const root = await application();
    await cp(join(EXAMPLES, "extension"), join(root, "extensions", "database-review"), { recursive: true });
    const extension = await loadExtension(await SafeFileSystem.open(root), "extensions/database-review");
    await writeFile(
      join(root, ".design-loom", "framework.lock.json"),
      json(lockFor([{ id: "example.database-review", version: "0.1.0", sha256: extension.resourcesSha256 }])),
    );
    await editJson(join(root, ".design-loom", "app.json"), (value) => {
      value.extension_paths = ["extensions/database-review"];
    });
    const ok = await run(["config", "resolve", "--root", root]);
    assert.equal(ok.code, EXIT.ok, JSON.stringify(ok.envelope.diagnostics));
    const resolved = ok.envelope.result as { effective_config: { configuration: { extensions: { id: string }[] } } };
    assert.deepEqual(
      resolved.effective_config.configuration.extensions.map((entry) => entry.id),
      ["example.database-review"],
    );

    await writeFile(join(root, "extensions", "database-review", "templates", "database-design.md"), "# Edited\n");
    const stale = await run(["config", "resolve", "--root", root]);
    assert.equal(stale.code, EXIT.stale);
    assert.deepEqual(codes(stale.envelope), ["CONFIG_EXTENSION_LOCK_MISMATCH"]);
  });

  test("a missing application profile is invalid configuration", async () => {
    const root = await application();
    await rm(join(root, ".design-loom", "app.json"));
    const { code, envelope } = await run(["config", "resolve", "--root", root]);
    assert.equal(code, EXIT.invalid);
    assert.equal(envelope.status, "failed");
    assert.deepEqual(codes(envelope), ["CONFIG_FILE_MISSING"]);
    assert.equal(envelope.diagnostics[0]?.path, ".design-loom/app.json");
  });

  test("extension_paths entries must be safe relative strings", async () => {
    for (const entry of [5, ["a"], "../outside"]) {
      const root = await application();
      await editJson(join(root, ".design-loom", "app.json"), (value) => {
        value.extension_paths = [entry];
      });
      const { code, envelope } = await run(["config", "resolve", "--root", root]);
      assert.equal(code, EXIT.invalid, JSON.stringify(entry));
      assert.deepEqual(codes(envelope), ["CONFIG_EXTENSION_INVALID"], JSON.stringify(entry));
    }
  });

  test("a broken plugin install is an internal error, not bad configuration", async () => {
    const release = join(scratch, `broken-release-${++counter}`);
    await cp(CORE, release, { recursive: true });
    await rm(join(release, "templates", "review.md"));
    const root = await application();
    const resolved = await run(["config", "resolve", "--root", root], { releaseRoot: release });
    assert.equal(resolved.code, EXIT.internal);
    assert.deepEqual(codes(resolved.envelope), ["CONFIG_FILE_MISSING"]);
    assert.equal(resolved.envelope.diagnostics[0]?.path, "core/templates/review.md");
    const checked = await run(["doctor", "--root", root], { releaseRoot: release });
    assert.equal(checked.code, EXIT.internal);
  });

  test("duplicate JSON keys are rejected", async () => {
    const root = await application();
    await writeFile(join(root, ".design-loom", "app.json"), '{"schema_version":"1.0","schema_version":"1.0"}');
    const { code, envelope } = await run(["config", "resolve", "--root", root]);
    assert.equal(code, EXIT.invalid);
    assert.deepEqual(codes(envelope), ["CONFIG_FILE_INVALID_JSON"]);
  });
});

describe("invocation", () => {
  test("--root must be given, absolute and an existing folder", async () => {
    for (const args of [
      ["doctor"],
      ["doctor", "--root", "relative/path"],
      ["doctor", "--root", join(scratch, "missing")],
    ]) {
      const { code, envelope } = await run(args);
      assert.equal(code, EXIT.invalid, args.join(" "));
      assert.deepEqual(codes(envelope), ["CLI_INVALID_ROOT"]);
    }
  });

  test("an unknown command or option is an invocation error", async () => {
    const unknown = await run(["deploy", "--root", scratch]);
    assert.equal(unknown.code, EXIT.invalid);
    assert.deepEqual(codes(unknown.envelope), ["CLI_UNKNOWN_COMMAND"]);
    assert.match(unknown.stderr, /Usage:/);

    let stdout = "";
    let stderr = "";
    const code = await runCli(
      ["doctor", "--force"],
      { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
      context(),
    );
    assert.equal(code, EXIT.invalid);
    assert.equal(stdout, "");
    assert.match(stderr, /--force/);
  });

  test("with --json, an argument error still prints one envelope", async () => {
    let stdout = "";
    const code = await runCli(
      ["doctor", "--force", "--json"],
      { stdout: (t) => (stdout += t), stderr: () => {} },
      context(),
    );
    assert.equal(code, EXIT.invalid);
    const envelope = JSON.parse(stdout) as ResultEnvelope;
    assert.equal(envelope.status, "failed");
    assert.deepEqual(codes(envelope), ["CLI_INVALID_ARGS"]);
  });

  test("without --json the output is a short summary", async () => {
    let stdout = "";
    const root = await application();
    await runCli(["config", "resolve", "--root", root], { stdout: (t) => (stdout += t), stderr: () => {} }, context());
    assert.match(stdout, /^config resolve: passed\n {2}effective_config_digest [0-9a-f]{64}\n$/);
  });
});

describe("doctor", () => {
  test("everything the default workflow needs is ready; the optional review provider is unknown", async () => {
    const { code, envelope } = await run(["doctor", "--root", await application()]);
    assert.equal(code, EXIT.ok, JSON.stringify(envelope.diagnostics));
    assert.equal(envelope.status, "degraded");
    const result = envelope.result as {
      workflow: string;
      workspace: string;
      capabilities: { id: string; state: string; used_by_workflow: boolean }[];
    };
    assert.equal(result.workflow, "core.feature-design");
    assert.equal(result.workspace, "valid");
    assert.deepEqual(
      result.capabilities.map((entry) => [entry.id, entry.state, entry.used_by_workflow]),
      [
        ["requirements.read", "ready", true],
        ["repository.read", "ready", true],
        ["review.verify", "unknown", true],
      ],
    );
    assert.deepEqual(codes(envelope), ["DOCTOR_CAPABILITY_UNKNOWN"]);
    assert.equal(envelope.diagnostics[0]?.severity, "warning");
  });

  test("an unmapped required repository blocks with exit 3", async () => {
    const { code, envelope } = await run(["doctor", "--root", await application({ map: false })]);
    assert.equal(code, EXIT.unavailable);
    assert.equal(envelope.status, "blocked");
    const unavailable = envelope.diagnostics.find((entry) => entry.code === "DOCTOR_CAPABILITY_UNAVAILABLE");
    assert.equal(unavailable?.severity, "error");
    assert.ok(unavailable?.evidence.includes("catalog-api: not mapped in .design-loom/workspace.local.json"));
  });

  test("an existing folder without .git and a missing checkout both block a required repository", async () => {
    const root = await application({ map: false });
    const checkout = join(scratch, "mapped-api");
    await writeFile(
      join(root, ".design-loom", "workspace.local.json"),
      json({ schema_version: "1.0", repositories: [{ id: "catalog-api", checkout_path: checkout }] }),
    );
    await mkdir(checkout);
    const notGit = await run(["doctor", "--root", root]);
    assert.equal(notGit.code, EXIT.unavailable);
    assert.equal(notGit.envelope.status, "blocked");
    const notGitDiagnostic = notGit.envelope.diagnostics.find(
      (entry) => entry.code === "DOCTOR_CAPABILITY_UNAVAILABLE",
    );
    assert.ok(notGitDiagnostic?.evidence.includes("catalog-api: mapped folder is not a Git checkout"));

    await rm(checkout, { recursive: true });
    const missing = await run(["doctor", "--root", root]);
    assert.equal(missing.code, EXIT.unavailable);
    assert.equal(missing.envelope.status, "blocked");
    const missingDiagnostic = missing.envelope.diagnostics.find(
      (entry) => entry.code === "DOCTOR_CAPABILITY_UNAVAILABLE",
    );
    assert.ok(missingDiagnostic?.evidence.includes("catalog-api: mapped checkout folder is missing"));
    assert.equal(notGit.envelope.input_digest, missing.envelope.input_digest);
  });

  test("changing the workspace map changes the input digest", async () => {
    const root = await application();
    const ready = await run(["doctor", "--root", root]);
    assert.equal(ready.code, EXIT.ok);
    await editJson(join(root, ".design-loom", "workspace.local.json"), (value) => {
      const [repository] = value.repositories as { checkout_path: string }[];
      assert.ok(repository);
      repository.checkout_path = join(scratch, "missing-api");
    });
    const blocked = await run(["doctor", "--root", root]);
    assert.equal(blocked.code, EXIT.unavailable);
    assert.notEqual(ready.envelope.input_digest, blocked.envelope.input_digest);
  });

  test("a missing optional capability only degrades the run", async () => {
    const root = await application();
    await rm(join(root, "sources"), { recursive: true });
    await editJson(join(root, ".design-loom", "app.json"), (value) => {
      (value.capabilities as { id: string; required: boolean }[])[0]!.required = false;
    });
    const { code, envelope } = await run(["doctor", "--root", root]);
    assert.equal(code, EXIT.ok);
    assert.equal(envelope.status, "degraded");
    assert.ok(codes(envelope).includes("DOCTOR_CAPABILITY_UNAVAILABLE"));
  });

  test("running from source can't verify the engine, so certified work is blocked", async () => {
    const { code, envelope } = await run(["doctor", "--root", await application()], { engineSha256: null });
    assert.equal(code, EXIT.unavailable);
    assert.ok(codes(envelope).includes("DOCTOR_ENGINE_UNVERIFIED"));
  });

  test("a lock mismatch is stale (exit 4), which outranks a missing capability", async () => {
    const lock = { ...lockFor(), engine_sha256: "b".repeat(64) };
    const { code, envelope } = await run(["doctor", "--root", await application({ lock, map: false })]);
    assert.equal(code, EXIT.stale);
    assert.ok(codes(envelope).includes("CONFIG_LOCK_ENGINE_MISMATCH"));
    assert.ok(codes(envelope).includes("DOCTOR_CAPABILITY_UNAVAILABLE"));
  });

  test("an invalid workspace map is invalid configuration", async () => {
    const root = await application();
    await writeFile(
      join(root, ".design-loom", "workspace.local.json"),
      json({ schema_version: "1.0", repositories: [{ id: "catalog-api", checkout_path: "relative/api" }] }),
    );
    const { code, envelope } = await run(["doctor", "--root", root]);
    assert.equal(code, EXIT.invalid);
    assert.ok(codes(envelope).includes("DOCTOR_WORKSPACE_INVALID"));
  });

  test("a workspace map that isn't a readable file is invalid configuration, not a crash", async () => {
    const root = await application({ map: false });
    await mkdir(join(root, ".design-loom", "workspace.local.json"));
    const { code, envelope } = await run(["doctor", "--root", root]);
    assert.equal(code, EXIT.invalid);
    assert.ok(codes(envelope).includes("DOCTOR_WORKSPACE_INVALID"));
    assert.ok(!codes(envelope).includes("CLI_INTERNAL_ERROR"));
  });

  test("workspace permission errors report the errno without exposing the local path", async ({ mock }) => {
    const root = await application();
    const workspacePath = ".design-loom/workspace.local.json";
    const readBytes = SafeFileSystem.prototype.readBytes;
    mock.method(SafeFileSystem.prototype, "readBytes", async function (this: SafeFileSystem, path: string) {
      if (path === workspacePath) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${join(root, path)}'`), { code: "EACCES" });
      }
      return readBytes.call(this, path);
    });
    const { code, envelope, stderr } = await run(["doctor", "--root", root]);
    assert.equal(code, EXIT.invalid);
    assert.equal(stderr, "");
    const invalid = envelope.diagnostics.find((entry) => entry.code === "DOCTOR_WORKSPACE_INVALID");
    assert.equal(invalid?.path, workspacePath);
    assert.equal(invalid?.message, `${workspacePath} can't be read: EACCES`);
    assert.ok(!JSON.stringify(envelope.diagnostics).includes(root));
  });

  test("an old Node.js runtime blocks", async () => {
    const { code, envelope } = await run(["doctor", "--root", await application()], { nodeVersion: "v22.11.0" });
    assert.equal(code, EXIT.unavailable);
    assert.ok(codes(envelope).includes("DOCTOR_RUNTIME_UNSUPPORTED"));
  });

  test("an unknown --workflow is invalid", async () => {
    const { code, envelope } = await run(["doctor", "--root", await application(), "--workflow", "core.missing"]);
    assert.equal(code, EXIT.invalid);
    assert.ok(codes(envelope).includes("DOCTOR_UNKNOWN_WORKFLOW"));
  });

  test("the entry script runs end to end and prints one JSON envelope", async () => {
    const root = await application();
    const outcome = await promisify(execFile)(process.execPath, [MAIN, "doctor", "--root", root, "--json"]).catch(
      (error: { code: number; stdout: string }) => error,
    );
    // From source there is no engine bundle to verify, so doctor exits 3.
    assert.equal((outcome as { code?: number }).code, EXIT.unavailable);
    const envelope = JSON.parse((outcome as { stdout: string }).stdout) as ResultEnvelope;
    assert.equal(envelope.command, "doctor");
    assert.ok(codes(envelope).includes("DOCTOR_ENGINE_UNVERIFIED"));
  });
});
