// Effective-configuration resolution (backlog B04, acceptance AT-45; design docs 03, 06 and 16).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  checkReleaseManifest,
  type Diagnostic,
  type ExtensionInput,
  effectiveConfigDigest,
  extensionDeclaredFiles,
  type ReleaseInput,
  type ResolveInput,
  resolveEffectiveConfig,
  resourceInventoryDigest,
  type SourceDocument,
  templateContentPath,
} from "@design-loom/config";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CORE = join(ROOT, "packages", "config", "resources", "core");
const EXAMPLES = join(ROOT, "tests", "fixtures", "design", "examples");

/** effective_config_digest of examples/effective-config.json, as recorded in examples/baseline.json. */
const FIXTURE_DIGEST = "8922d7247113ee502e1e45e8726e69be57223974d197fb7f558fa73eb6ccdbcc";
const ENGINE = "a".repeat(64);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

function documentAt(folder: string, path: string, origin: string): SourceDocument {
  const bytes = readFileSync(join(folder, ...path.split("/")));
  return { origin, sha256: sha256(bytes), value: JSON.parse(bytes.toString("utf8")) };
}

/** Reads the core release resources the way the loader does. */
function loadRelease(engineSha256: string | null = ENGINE): ReleaseInput {
  const manifest = documentAt(CORE, "release.json", "core/release.json");
  const { manifest: release } = checkReleaseManifest(manifest.value);
  assert.ok(release);
  const inventory = [{ path: "release.json", sha256: manifest.sha256 }];
  const workflows = release.workflows.map((path) => {
    const document = documentAt(CORE, path, `core/${path}`);
    inventory.push({ path, sha256: document.sha256 });
    return document;
  });
  const templates = release.templates.map((path) => {
    const document = documentAt(CORE, path, `core/${path}`);
    inventory.push({ path, sha256: document.sha256 });
    const content = templateContentPath(path, (document.value as { content_path: string }).content_path);
    inventory.push({ path: content, sha256: sha256(readFileSync(join(CORE, ...content.split("/")))) });
    return document;
  });
  return { manifest, workflows, templates, resourcesSha256: resourceInventoryDigest(inventory), engineSha256 };
}

const RELEASE = loadRelease();
const fixture = JSON.parse(readFileSync(join(EXAMPLES, "effective-config.json"), "utf8"));

function application(): SourceDocument {
  return documentAt(EXAMPLES, "application.json", ".design-loom/app.json");
}

/** A lock that pins exactly what is running, so lock checks pass. */
function matchingLock(extensions: { id: string; version: string; sha256: string }[] = []): SourceDocument {
  const value = {
    schema_version: "1.0",
    framework_version: "0.1.0",
    engine_sha256: ENGINE,
    resources_sha256: RELEASE.resourcesSha256,
    extensions_locked: extensions,
    schema_contract_version: "1.0",
  };
  return { origin: ".design-loom/framework.lock.json", sha256: "c".repeat(64), value };
}

function withValue(document: SourceDocument, edit: (value: Record<string, unknown>) => void): SourceDocument {
  const value = clone(document.value) as Record<string, unknown>;
  edit(value);
  return { ...document, value };
}

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return { release: RELEASE, application: application(), lock: matchingLock(), extensions: [], ...overrides };
}

/** The design fixture's inputs. Its lock pins synthetic digests (all a's and b's). */
function fixtureInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  const lock = documentAt(EXAMPLES, "framework-lock.json", ".design-loom/framework.lock.json");
  return input({ lock, ...overrides });
}

const codes = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((entry) => entry.code);

/** The design's example extension, with the lock entry that matches it. */
function exampleExtension(edit?: (manifest: Record<string, unknown>) => void): {
  extension: ExtensionInput;
  tuple: { id: string; version: string; sha256: string };
} {
  const folder = join(EXAMPLES, "extension");
  let manifest = documentAt(folder, "extension.json", "extensions/database-review/extension.json");
  if (edit) manifest = withValue(manifest, edit);
  const { files, problems } = extensionDeclaredFiles(manifest.value);
  assert.deepEqual(problems, []);
  const inventory = [
    { path: "extension.json", sha256: manifest.sha256 },
    ...files
      .filter((file) => file === "templates/database-design.md")
      .map((file) => ({ path: file, sha256: sha256(readFileSync(join(folder, ...file.split("/")))) })),
  ];
  const resourcesSha256 = resourceInventoryDigest(inventory);
  const value = manifest.value as { id: string; version: string };
  return {
    extension: { path: "extensions/database-review", manifest, resourcesSha256, descriptors: new Map() },
    tuple: { id: value.id, version: value.version, sha256: resourcesSha256 },
  };
}

describe("effective configuration: the design fixture (AT-45)", () => {
  test("the resolver reproduces the fixture's configuration exactly", () => {
    const result = resolveEffectiveConfig(fixtureInput());
    assert.ok(result.envelope, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.envelope.configuration, fixture.configuration);
  });

  test("its digest equals the effective_config_digest the design records", () => {
    assert.equal(effectiveConfigDigest(fixture), FIXTURE_DIGEST);
    assert.equal(resolveEffectiveConfig(fixtureInput()).digest, FIXTURE_DIGEST);
  });

  test("the fixture's own lock pins synthetic digests, so it resolves but reports a resources mismatch", () => {
    const result = resolveEffectiveConfig(fixtureInput());
    assert.equal(result.digest, FIXTURE_DIGEST);
    assert.deepEqual(result.lock, {
      ok: false,
      framework_version: "match",
      engine: "match",
      resources: "mismatch",
      extensions: "match",
    });
    assert.deepEqual(codes(result.diagnostics), ["CONFIG_LOCK_RESOURCES_MISMATCH"]);
  });

  test("a provenance-only change keeps the digest; a semantic change alters it", () => {
    const result = resolveEffectiveConfig(fixtureInput());
    assert.ok(result.envelope);
    const moved = clone(result.envelope);
    for (const entry of moved.provenance) entry.origin = `elsewhere/${entry.origin}`;
    assert.equal(effectiveConfigDigest(moved), FIXTURE_DIGEST);

    const renamed = resolveEffectiveConfig(
      input({ application: withValue(application(), (value) => Object.assign(value, { name: "Renamed" })) }),
    );
    assert.notEqual(renamed.digest, FIXTURE_DIGEST);
    const extraRule = clone(result.envelope);
    extraRule.configuration.core_rule_ids.push("DL999");
    assert.notEqual(effectiveConfigDigest(extraRule), FIXTURE_DIGEST);
  });

  test("moving the inputs keeps the digest, because origins are only provenance", () => {
    const app = { ...application(), origin: "somewhere/else/app.json" };
    assert.equal(resolveEffectiveConfig(fixtureInput({ application: app })).digest, FIXTURE_DIGEST);
  });

  test("provenance names every resolved entry with its source digest", () => {
    const { envelope } = resolveEffectiveConfig(fixtureInput());
    assert.ok(envelope);
    const byPointer = new Map(envelope.provenance.map((entry) => [entry.pointer, entry]));
    assert.equal(
      byPointer.get("/application")?.sha256,
      "224ce27c0e135b99201f2b37f0e0bb5e8cc24bb798d3e6811c84677639d1614b",
    );
    assert.equal(byPointer.get("/workflows/0")?.origin, "core/workflows/core.feature-design.json");
    assert.equal(byPointer.get("/workflows/0")?.sha256, fixture.provenance[4].sha256);
    assert.equal(byPointer.get("/templates/5")?.origin, "core/templates/test-design.template.json");
    assert.equal(byPointer.get("/templates/5")?.sha256, fixture.provenance[11].sha256);
    assert.equal(byPointer.get("/extensions")?.origin, ".design-loom/app.json");
    for (const index of envelope.configuration.artifact_types.keys())
      assert.ok(byPointer.has(`/artifact_types/${index}`));
    for (const index of envelope.configuration.core_rule_ids.keys())
      assert.ok(byPointer.has(`/core_rule_ids/${index}`));
    for (const entry of envelope.provenance) assert.ok(!entry.origin.startsWith("/"), entry.origin);
  });

  test("the result is deeply frozen and independent of the inputs", () => {
    const app = application();
    const { envelope } = resolveEffectiveConfig(fixtureInput({ application: app }));
    assert.ok(envelope);
    assert.throws(() => {
      envelope.configuration.artifact_types.push("x");
    }, TypeError);
    (app.value as { name: string }).name = "Changed later";
    assert.equal(envelope.configuration.application.name, "Sample Catalog");
  });

  test("registries are ordered by ID whatever the input order", () => {
    const reversed: ReleaseInput = { ...RELEASE, templates: RELEASE.templates.toReversed() };
    const result = resolveEffectiveConfig(fixtureInput({ release: reversed }));
    assert.equal(result.digest, FIXTURE_DIGEST);
  });
});

describe("effective configuration: lock comparison", () => {
  test("a lock that pins what is running matches completely", () => {
    const result = resolveEffectiveConfig(input());
    assert.deepEqual(result.lock, {
      ok: true,
      framework_version: "match",
      engine: "match",
      resources: "match",
      extensions: "match",
    });
    assert.deepEqual(result.diagnostics, []);
  });

  test("running from source leaves the engine unknown, which is not a match", () => {
    const result = resolveEffectiveConfig(input({ release: loadRelease(null) }));
    assert.equal(result.lock?.engine, "unknown");
    assert.equal(result.lock?.ok, false);
    assert.deepEqual(codes(result.diagnostics), ["CONFIG_LOCK_ENGINE_UNKNOWN"]);
    assert.equal(result.diagnostics[0]?.severity, "warning");
    assert.ok(result.digest);
  });

  test("a different engine, framework version or resource set is a mismatch with both values as evidence", () => {
    const lock = withValue(matchingLock(), (value) => {
      value.engine_sha256 = "d".repeat(64);
      value.framework_version = "0.2.0";
      value.resources_sha256 = "e".repeat(64);
    });
    const app = withValue(application(), (value) => {
      value.framework_version = "0.2.0";
    });
    const result = resolveEffectiveConfig(input({ lock, application: app }));
    assert.deepEqual(result.lock, {
      ok: false,
      framework_version: "mismatch",
      engine: "mismatch",
      resources: "mismatch",
      extensions: "match",
    });
    assert.deepEqual(codes(result.diagnostics).sort(), [
      "CONFIG_LOCK_ENGINE_MISMATCH",
      "CONFIG_LOCK_FRAMEWORK_MISMATCH",
      "CONFIG_LOCK_RESOURCES_MISMATCH",
    ]);
    const engine = result.diagnostics.find((entry) => entry.code === "CONFIG_LOCK_ENGINE_MISMATCH");
    assert.deepEqual(engine?.evidence, [`locked: ${"d".repeat(64)}`, `running: ${ENGINE}`]);
    assert.equal(engine?.path, ".design-loom/framework.lock.json#/engine_sha256");
  });
});

describe("effective configuration: invalid input", () => {
  test("a schema violation stops resolution and points at the field", () => {
    const app = withValue(application(), (value) => {
      value.silent_override = true;
    });
    const result = resolveEffectiveConfig(input({ application: app }));
    assert.equal(result.envelope, null);
    assert.equal(result.digest, null);
    assert.deepEqual(codes(result.diagnostics), ["CONFIG_SCHEMA_INVALID"]);
    assert.equal(result.diagnostics[0]?.path, ".design-loom/app.json");
  });

  test("an invalid lock stops resolution and reports no lock comparison", () => {
    const lock = withValue(matchingLock(), (value) => {
      delete value.engine_sha256;
    });
    const result = resolveEffectiveConfig(input({ lock }));
    assert.equal(result.envelope, null);
    assert.equal(result.lock, null);
  });

  test("a damaged release manifest is reported", () => {
    const manifest = withValue(RELEASE.manifest, (value) => {
      value.core_rule_ids = ["DL001", "dl001"];
    });
    const result = resolveEffectiveConfig(input({ release: { ...RELEASE, manifest } }));
    assert.equal(result.envelope, null);
    assert.ok(codes(result.diagnostics).includes("CONFIG_RELEASE_INVALID"));
  });

  const cases: [string, (value: Record<string, unknown>) => void, string, string][] = [
    [
      "unknown default workflow",
      (value) => {
        value.default_workflow = "core.missing";
      },
      "CONFIG_UNKNOWN_WORKFLOW",
      ".design-loom/app.json#/default_workflow",
    ],
    [
      "unknown selected template",
      (value) => {
        value.template_selections = { contract: "core.missing" };
      },
      "CONFIG_UNKNOWN_TEMPLATE",
      ".design-loom/app.json#/template_selections/contract",
    ],
    [
      "template for another artifact type",
      (value) => {
        value.template_selections = { contract: "core.review" };
      },
      "CONFIG_TEMPLATE_TYPE_MISMATCH",
      ".design-loom/app.json#/template_selections/contract",
    ],
    [
      "template selection for an unknown type",
      (value) => {
        value.template_selections = { "data/model": "core.review" };
      },
      "CONFIG_UNKNOWN_ARTIFACT_TYPE",
      ".design-loom/app.json#/template_selections/data~1model",
    ],
    [
      "required review role without reviewers",
      (value) => {
        value.required_review_roles = ["security"];
      },
      "CONFIG_REVIEW_ROLE_UNKNOWN",
      ".design-loom/app.json#/required_review_roles/0",
    ],
    [
      "unknown required artifact type",
      (value) => {
        value.required_artifact_types = ["database-design"];
      },
      "CONFIG_UNKNOWN_ARTIFACT_TYPE",
      ".design-loom/app.json#/required_artifact_types/0",
    ],
    [
      "design repository not configured",
      (value) => {
        value.design_repository_id = "catalog-docs";
      },
      "CONFIG_DESIGN_REPOSITORY",
      ".design-loom/app.json#/design_repository_id",
    ],
    [
      "repository listed twice ignoring case",
      (value) => {
        (value.repositories as { id: string }[])[1]!.id = "Catalog-Design";
      },
      "CONFIG_DUPLICATE_ID",
      ".design-loom/app.json#/repositories/1/id",
    ],
    [
      "workflow step needs a capability the application lacks",
      (value) => {
        value.capabilities = (value.capabilities as { id: string }[]).filter((entry) => entry.id !== "review.verify");
      },
      "CONFIG_UNKNOWN_CAPABILITY",
      "core/workflows/core.feature-design.json#/steps/5/capabilities",
    ],
  ];
  for (const [name, edit, code, path] of cases) {
    test(`rejects ${name}`, () => {
      const result = resolveEffectiveConfig(input({ application: withValue(application(), edit) }));
      assert.equal(result.envelope, null);
      assert.ok(
        result.diagnostics.some((entry) => entry.code === code && entry.path === path),
        JSON.stringify(result.diagnostics),
      );
    });
  }

  test("a core template selection for the same type resolves", () => {
    const app = withValue(application(), (value) => {
      value.template_selections = { contract: "core.contract" };
    });
    assert.ok(resolveEffectiveConfig(input({ application: app })).envelope);
  });
});

describe("effective configuration: workflow graphs", () => {
  function withWorkflow(edit: (steps: Record<string, unknown>[]) => void): ResolveInput {
    const [workflow] = RELEASE.workflows;
    assert.ok(workflow);
    const changed = withValue(workflow, (value) => edit(value.steps as Record<string, unknown>[]));
    return input({ release: { ...RELEASE, workflows: [changed] } });
  }

  const cases: [string, (steps: Record<string, unknown>[]) => void, string][] = [
    ["a cycle", (steps) => Object.assign(steps[0]!, { after: ["verify"] }), "has a cycle"],
    ["an unknown predecessor", (steps) => Object.assign(steps[1]!, { after: ["design"] }), "unknown step design"],
    ["a duplicate step", (steps) => Object.assign(steps[1]!, { id: "intake" }), "two steps named intake"],
    [
      "an unknown output",
      (steps) => Object.assign(steps[1]!, { required_outputs: ["schema"] }),
      "unknown output schema",
    ],
    ["an unknown rule", (steps) => Object.assign(steps[1]!, { blocking_rules: ["DL099"] }), "unknown rule DL099"],
    [
      "an undefined reviewer role",
      (steps) => Object.assign(steps[1]!, { reviewer_roles: ["security"] }),
      "reviewer role security",
    ],
  ];
  for (const [name, edit, message] of cases) {
    test(`rejects ${name}`, () => {
      const result = resolveEffectiveConfig(withWorkflow(edit));
      assert.equal(result.envelope, null);
      assert.ok(
        result.diagnostics.some((entry) => entry.message.includes(message)),
        JSON.stringify(result.diagnostics),
      );
    });
  }
});

describe("effective configuration: extensions", () => {
  test("a locked extension resolves; its Markdown template becomes selectable", () => {
    const { extension, tuple } = exampleExtension();
    const app = withValue(application(), (value) => {
      value.extension_paths = ["extensions/database-review"];
      value.template_selections = { "engineering-design": "example.database-design" };
    });
    const result = resolveEffectiveConfig(
      input({ application: app, lock: matchingLock([tuple]), extensions: [extension] }),
    );
    assert.ok(result.envelope, JSON.stringify(result.diagnostics));
    assert.equal(result.lock?.ok, true);
    assert.deepEqual(
      result.envelope.configuration.extensions.map((entry) => entry.id),
      ["example.database-review"],
    );
    assert.equal(result.envelope.configuration.templates.length, 6);
    const trace = result.envelope.provenance.find((entry) => entry.pointer === "/extensions/0");
    assert.equal(trace?.origin, "extensions/database-review/extension.json");
    assert.notEqual(result.digest, FIXTURE_DIGEST);
  });

  test("an extension missing from the lock still resolves for diagnosis, but the lock fails", () => {
    const { extension } = exampleExtension();
    const result = resolveEffectiveConfig(input({ extensions: [extension] }));
    assert.ok(result.envelope);
    assert.equal(result.lock?.extensions, "mismatch");
    assert.equal(result.lock?.ok, false);
    assert.deepEqual(codes(result.diagnostics), ["CONFIG_EXTENSION_NOT_LOCKED"]);
  });

  test("changed extension bytes no longer match the lock", () => {
    const { extension, tuple } = exampleExtension();
    const changed = { ...extension, resourcesSha256: "f".repeat(64) };
    const result = resolveEffectiveConfig(input({ lock: matchingLock([tuple]), extensions: [changed] }));
    assert.deepEqual(codes(result.diagnostics), ["CONFIG_EXTENSION_LOCK_MISMATCH"]);
    assert.equal(result.lock?.extensions, "mismatch");
  });

  test("a locked extension the application doesn't load is reported", () => {
    const { tuple } = exampleExtension();
    const result = resolveEffectiveConfig(input({ lock: matchingLock([tuple]) }));
    assert.deepEqual(codes(result.diagnostics), ["CONFIG_EXTENSION_LOCK_UNUSED"]);
    assert.equal(result.lock?.ok, false);
  });

  const rejected: [string, (manifest: Record<string, unknown>) => void, string][] = [
    [
      "an incompatible framework range",
      (m) => Object.assign(m, { framework_range: ">=0.2.0 <0.3.0" }),
      "CONFIG_EXTENSION_INCOMPATIBLE",
    ],
    [
      "an unsupported range syntax",
      (m) => Object.assign(m, { framework_range: "^0.1.0" }),
      "CONFIG_EXTENSION_RANGE_INVALID",
    ],
    [
      "a missing dependency",
      (m) => Object.assign(m, { requires: ["example.audit"] }),
      "CONFIG_EXTENSION_DEPENDENCY_MISSING",
    ],
    [
      "a rule ID that collides with a core rule",
      (m) => Object.assign((m.rules as Record<string, unknown>[])[0]!, { id: "dl001" }),
      "CONFIG_DUPLICATE_ID",
    ],
    [
      "a rule for an unknown artifact type",
      (m) => Object.assign((m.rules as Record<string, unknown>[])[0]!, { artifact_type: "database-design" }),
      "CONFIG_UNKNOWN_ARTIFACT_TYPE",
    ],
    [
      "an artifact type that collides with a core type",
      (m) =>
        (m.resources as Record<string, unknown>[]).push({
          id: "Contract",
          kind: "artifact_type",
          path: "schemas/contract.json",
        }),
      "CONFIG_DUPLICATE_ID",
    ],
    [
      "a Markdown template without an artifact type",
      (m) => delete (m.resources as Record<string, unknown>[])[0]!.artifact_type,
      "CONFIG_EXTENSION_TEMPLATE_TYPE",
    ],
  ];
  for (const [name, edit, code] of rejected) {
    test(`rejects ${name}`, () => {
      const { extension, tuple } = exampleExtension(edit);
      const result = resolveEffectiveConfig(input({ lock: matchingLock([tuple]), extensions: [extension] }));
      assert.equal(result.envelope, null);
      assert.ok(codes(result.diagnostics).includes(code), JSON.stringify(result.diagnostics));
    });
  }

  test("two extensions with the same ID ignoring case are rejected", () => {
    const first = exampleExtension();
    const second = exampleExtension((m) => Object.assign(m, { id: "Example.Database-Review" }));
    const result = resolveEffectiveConfig(
      input({ lock: matchingLock([first.tuple]), extensions: [first.extension, second.extension] }),
    );
    assert.equal(result.envelope, null);
    assert.ok(codes(result.diagnostics).includes("CONFIG_DUPLICATE_ID"));
  });

  test("extensions that require each other are rejected as a cycle", () => {
    const a = exampleExtension((m) => Object.assign(m, { requires: ["example.b"], resources: [], rules: [] }));
    const b = exampleExtension((m) =>
      Object.assign(m, { id: "example.b", requires: ["example.database-review"], resources: [], rules: [] }),
    );
    const result = resolveEffectiveConfig(
      input({ lock: matchingLock([a.tuple, b.tuple]), extensions: [a.extension, b.extension] }),
    );
    assert.equal(result.envelope, null);
    assert.deepEqual(codes(result.diagnostics), ["CONFIG_EXTENSION_CYCLE"]);
  });

  test("extension artifact types and workflows join the registries in ID order", () => {
    const workflow = withValue(RELEASE.workflows[0]!, (value) => {
      value.id = "example.db-feature";
      (value.steps as Record<string, unknown>[])[0]!.required_outputs = ["example.migration"];
    });
    const { extension, tuple } = exampleExtension((m) => {
      m.resources = [
        { id: "example.migration", kind: "artifact_type", path: "schemas/migration.json" },
        { id: "example.db-feature", kind: "workflow", path: "workflows/db-feature.json" },
      ];
      m.rules = [];
    });
    const withDescriptor = {
      ...extension,
      descriptors: new Map([
        ["example.db-feature", { ...workflow, origin: "extensions/database-review/workflows/db-feature.json" }],
      ]),
    };
    const result = resolveEffectiveConfig(input({ lock: matchingLock([tuple]), extensions: [withDescriptor] }));
    assert.ok(result.envelope, JSON.stringify(result.diagnostics));
    assert.deepEqual(
      result.envelope.configuration.workflows.map((entry) => entry.id),
      ["core.feature-design", "example.db-feature"],
    );
    assert.ok(result.envelope.configuration.artifact_types.includes("example.migration"));
    const trace = result.envelope.provenance.find((entry) => entry.pointer === "/workflows/1");
    assert.equal(trace?.origin, "extensions/database-review/workflows/db-feature.json");
  });

  test("a workflow resource whose descriptor wasn't loaded is a loader defect", () => {
    const { extension, tuple } = exampleExtension((m) => {
      m.resources = [{ id: "example.flow", kind: "workflow", path: "workflows/flow.json" }];
      m.rules = [];
    });
    const result = resolveEffectiveConfig(input({ lock: matchingLock([tuple]), extensions: [extension] }));
    assert.equal(result.envelope, null);
    assert.ok(codes(result.diagnostics).includes("CONFIG_EXTENSION_RESOURCE_MISSING"));
  });
});

describe("loader helpers", () => {
  test("an extension declares its resource files and json_schema rule schemas", () => {
    const manifest = JSON.parse(readFileSync(join(EXAMPLES, "extension", "extension.json"), "utf8"));
    assert.deepEqual(extensionDeclaredFiles(manifest), { files: ["templates/database-design.md"], problems: [] });
    manifest.rules.push({
      id: "EXDB002",
      kind: "json_schema",
      artifact_type: "engineering-design",
      parameters: { payload_pointer: "/payload", schema_path: "schemas\\payload.json" },
    });
    assert.deepEqual(extensionDeclaredFiles(manifest).files, ["schemas/payload.json", "templates/database-design.md"]);
  });

  test("extension files must stay inside the extension folder", () => {
    const manifest = JSON.parse(readFileSync(join(EXAMPLES, "extension", "extension.json"), "utf8"));
    manifest.rules.push({
      id: "EXDB002",
      kind: "json_schema",
      artifact_type: "engineering-design",
      parameters: { payload_pointer: "/payload", schema_path: "../outside.json" },
    });
    const { problems } = extensionDeclaredFiles(manifest);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /schema_path/);
  });

  test("a template's starter path resolves next to its descriptor and can't escape", () => {
    assert.equal(templateContentPath("templates/review.template.json", "review.md"), "templates/review.md");
    assert.equal(templateContentPath("review.template.json", "starters/review.md"), "starters/review.md");
    assert.throws(() => templateContentPath("templates/review.template.json", "../../secret.md"));
  });
});
