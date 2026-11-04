// The artifact/source store index and graph queries (backlog B05; design docs 03, 07 and 16).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  buildStoreIndex,
  classifyStorePath,
  referenceClosure,
  type StoreIndex,
  transitiveDependents,
} from "@design-loom/artifacts";
import { editRecord, readRecord, sampleRepository, storeInput, writeRecord } from "../../support/sample-store.ts";

const EXAMPLES = join(import.meta.dirname, "..", "..", "fixtures", "design", "examples");
const findings = JSON.parse(readFileSync(join(EXAMPLES, "findings.json"), "utf8")) as {
  reviewed_artifacts: { id: string; sha256: string }[];
};

const index = (repo = sampleRepository(), limits?: Parameters<typeof buildStoreIndex>[0]["limits"]): StoreIndex =>
  buildStoreIndex({ ...storeInput(repo), ...(limits ? { limits } : {}) });

const codes = (result: StoreIndex): string[] => result.diagnostics.map((entry) => entry.code);

/** The sample's own warnings (its root-level attachments), so tests can look at what a change adds. */
const SAMPLE_WARNINGS = new Set(index().diagnostics.map((entry) => `${entry.code} ${entry.path}`));
const added = (result: StoreIndex): string[] =>
  result.diagnostics.filter((entry) => !SAMPLE_WARNINGS.has(`${entry.code} ${entry.path}`)).map((entry) => entry.code);

describe("store layout", () => {
  test("record locations from design doc 03", () => {
    const cases: [string, unknown][] = [
      ["changes/C-1/change.json", { kind: "change", id: "C-1", changeId: "C-1", scope: null }],
      ["changes/C-1/artifacts/A-1.json", { kind: "artifact", id: "A-1", changeId: "C-1", scope: "change" }],
      ["changes/C-1/tasks/T-1.json", { kind: "task", id: "T-1", changeId: "C-1", scope: null }],
      ["changes/C-1/traceability.json", { kind: "traceability", id: "C-1", changeId: "C-1", scope: null }],
      ["changes/C-1/findings.json", { kind: "findings", id: "C-1", changeId: "C-1", scope: null }],
      ["shared/artifacts/A-2.json", { kind: "artifact", id: "A-2", changeId: null, scope: "project" }],
      ["sources/src-1.json", { kind: "source", id: "src-1", changeId: null, scope: null }],
      ["baselines/B-1.json", { kind: "baseline", id: "B-1", changeId: null, scope: null }],
    ];
    for (const [path, expected] of cases) assert.deepEqual(classifyStorePath(path), expected, path);
  });

  test("anything else is not a record", () => {
    for (const path of [
      "changes/C-1/notes.md",
      "changes/C-1/content/a.json",
      "changes/C-1/artifacts/sub/A.json",
      "changes/C-1/artifacts/A.md",
      "changes/1bad/change.json",
      "shared/artifacts/x.json",
      "sources/snapshots/a.json",
      "baselines/B-1.json.bak",
      "artifacts/A-1.json",
    ]) {
      assert.equal(classifyStorePath(path), null, path);
    }
  });
});

describe("store index: the sample repository", () => {
  const result = index();

  test("indexes without errors; only the examples' root-level attachments are flagged", () => {
    assert.deepEqual(
      result.diagnostics.map((entry) => [entry.code, entry.path]),
      [
        ["STORE_CONTENT_OUTSIDE_SCOPE", "changes/CHANGE-001/artifacts/QA-001.json"],
        ["STORE_CONTENT_OUTSIDE_SCOPE", "changes/CHANGE-001/artifacts/REVIEW-001.json"],
        ["STORE_CONTENT_OUTSIDE_SCOPE", "changes/QA-CAMPAIGN-001/artifacts/QA-BATCH-001.json"],
      ],
    );
    assert.deepEqual([...result.changes.keys()], ["CHANGE-001", "CHANGE-002", "QA-CAMPAIGN-001"]);
    assert.deepEqual(
      [...result.artifacts.keys()],
      [
        "CONTRACT-001",
        "DESIGN-001",
        "DESIGN-002",
        "QA-001",
        "QA-BATCH-001",
        "REQDOC-001",
        "REVIEW-001",
        "SHARED-STATUS-001",
      ],
    );
    assert.deepEqual([...result.sources.keys()], ["src-catalog-requirement", "src-optional-notes"]);
    assert.deepEqual([...result.baselines.keys()], ["BASELINE-001"]);
  });

  test("finds tasks, traceability and findings under each change", () => {
    const change = result.changes.get("CHANGE-001");
    assert.deepEqual(change?.taskIds, ["TASK-001", "TASK-EARLY-001"]);
    assert.deepEqual(change?.artifactIds, ["CONTRACT-001", "DESIGN-001", "QA-001", "REQDOC-001", "REVIEW-001"]);
    assert.equal(change?.traceability?.path, "changes/CHANGE-001/traceability.json");
    assert.equal(change?.findings?.path, "changes/CHANGE-001/findings.json");
    const campaign = result.changes.get("QA-CAMPAIGN-001");
    assert.deepEqual(campaign?.artifactIds, ["QA-BATCH-001"]);
    assert.deepEqual(campaign?.traceability?.record.covered_change_ids, ["CHANGE-001", "CHANGE-002"]);
    assert.equal(campaign?.findings, null);
    assert.equal(result.tasks.get("TASK-001")?.changeId, "CHANGE-001");
  });

  test("indexes the project artifact application-wide, outside any change", () => {
    const shared = result.artifacts.get("SHARED-STATUS-001");
    assert.equal(shared?.scope, "project");
    assert.equal(shared?.changeId, null);
    assert.deepEqual(result.dependents.get("SHARED-STATUS-001"), ["CONTRACT-001", "DESIGN-002"]);
  });

  test("semantic digests match the digests the design's findings record", () => {
    for (const reviewed of findings.reviewed_artifacts) {
      const artifact = result.artifacts.get(reviewed.id);
      assert.equal(artifact?.bytesVerified, true, reviewed.id);
      assert.equal(artifact?.semanticDigest, reviewed.sha256, reviewed.id);
    }
  });

  test("context receipts bind the current digests of what was read", () => {
    const design = result.artifacts.get("DESIGN-001");
    for (const reference of design?.record.context?.references ?? []) {
      const current =
        reference.kind === "artifact"
          ? result.artifacts.get(reference.id)?.semanticDigest
          : result.sources.get(reference.id)?.record.sha256;
      assert.equal(reference.sha256, current, reference.id);
    }
  });

  test("record and file digests are of the raw bytes", () => {
    const artifact = result.artifacts.get("REQDOC-001");
    assert.match(artifact?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(artifact?.sha256, artifact?.semanticDigest);
  });

  test("the index is the same whatever order the scan lists files in", () => {
    const input = storeInput(sampleRepository());
    const reversed = buildStoreIndex({ ...input, records: input.records.toReversed() });
    assert.deepEqual([...reversed.artifacts.keys()], [...result.artifacts.keys()]);
    assert.deepEqual(reversed.dependents, result.dependents);
    assert.deepEqual(reversed.diagnostics, result.diagnostics);
  });
});

describe("graph queries", () => {
  const result = index();

  test("the reference closure follows depends_on across changes and scopes", () => {
    const closure = referenceClosure(result, ["QA-BATCH-001"]);
    assert.deepEqual(closure.artifactIds, [
      "CONTRACT-001",
      "DESIGN-001",
      "DESIGN-002",
      "QA-BATCH-001",
      "REQDOC-001",
      "SHARED-STATUS-001",
    ]);
    assert.deepEqual(closure.sourceIds, ["src-catalog-requirement"]);
    assert.deepEqual(closure.missing, []);
    const paths = closure.files.map((file) => file.path);
    for (const expected of [
      "changes/CHANGE-001/artifacts/DESIGN-001.json",
      "changes/CHANGE-001/content/engineering.md",
      "shared/artifacts/SHARED-STATUS-001.json",
      "shared/content/item-status.md",
      "sources/src-catalog-requirement.json",
      "sources/snapshots/catalog-requirement.md",
    ]) {
      assert.ok(paths.includes(expected), expected);
    }
    assert.deepEqual(paths, [...paths].sort());
  });

  test("a closure reports IDs the index doesn't have", () => {
    assert.deepEqual(referenceClosure(result, ["NOPE-001"]).missing, ["NOPE-001"]);
  });

  test("dependents are transitive, with a shortest reason path", () => {
    const dependents = transitiveDependents(result, ["SHARED-STATUS-001"]);
    assert.deepEqual(dependents, [
      { id: "CONTRACT-001", path: ["SHARED-STATUS-001", "CONTRACT-001"] },
      { id: "DESIGN-001", path: ["SHARED-STATUS-001", "CONTRACT-001", "DESIGN-001"] },
      { id: "DESIGN-002", path: ["SHARED-STATUS-001", "DESIGN-002"] },
      { id: "QA-001", path: ["SHARED-STATUS-001", "CONTRACT-001", "QA-001"] },
      { id: "QA-BATCH-001", path: ["SHARED-STATUS-001", "DESIGN-002", "QA-BATCH-001"] },
      { id: "REVIEW-001", path: ["SHARED-STATUS-001", "CONTRACT-001", "REVIEW-001"] },
    ]);
    const fromRequirements = transitiveDependents(result, ["REQDOC-001"]).map((entry) => entry.id);
    assert.ok(fromRequirements.includes("QA-BATCH-001"));
    assert.ok(!fromRequirements.includes("REQDOC-001"));
  });
});

describe("store index: problems", () => {
  type Case = [name: string, mutate: (repo: Map<string, Uint8Array>) => void, code: string, path?: string];
  const DESIGN = "changes/CHANGE-001/artifacts/DESIGN-001.json";
  const SHARED = "shared/artifacts/SHARED-STATUS-001.json";
  const cases: Case[] = [
    [
      "a stray file in a record folder",
      (repo) => repo.set("changes/CHANGE-001/notes.md", new Uint8Array([1])),
      "STORE_UNEXPECTED_FILE",
      "changes/CHANGE-001/notes.md",
    ],
    [
      "a record whose ID differs from its file name",
      (repo) => editRecord(repo, DESIGN, (value) => Object.assign(value, { id: "DESIGN-009" })),
      "STORE_ID_MISMATCH",
      `${DESIGN}#/id`,
    ],
    [
      "a project artifact in a change folder",
      (repo) => {
        const value = readRecord(repo, SHARED);
        repo.delete(SHARED);
        writeRecord(repo, "changes/CHANGE-001/artifacts/SHARED-STATUS-001.json", value);
      },
      "STORE_SCOPE_MISMATCH",
    ],
    [
      "a change artifact in the shared folder",
      (repo) => {
        const value = readRecord(repo, DESIGN);
        repo.delete(DESIGN);
        writeRecord(repo, "shared/artifacts/DESIGN-001.json", value);
      },
      "STORE_SCOPE_MISMATCH",
    ],
    [
      "a change record stored under another change",
      (repo) => editRecord(repo, DESIGN, (value) => Object.assign(value, { change_id: "CHANGE-002" })),
      "STORE_CHANGE_MISMATCH",
    ],
    [
      "a record from another application",
      (repo) => editRecord(repo, DESIGN, (value) => Object.assign(value, { application_id: "other-app" })),
      "STORE_APPLICATION_MISMATCH",
    ],
    [
      "an author-set approved state",
      (repo) => editRecord(repo, DESIGN, (value) => Object.assign(value, { state: "approved" })),
      "STORE_SCHEMA_INVALID",
      `${DESIGN}#/state`,
    ],
    [
      "duplicate JSON keys",
      (repo) => repo.set(DESIGN, new TextEncoder().encode('{"id":"DESIGN-001","id":"DESIGN-001"}')),
      "STORE_RECORD_UNREADABLE",
    ],
    [
      "artifact IDs that differ only by case across scopes",
      (repo) => {
        const value = readRecord(repo, SHARED);
        writeRecord(repo, "shared/artifacts/design-001.json", { ...value, id: "design-001" });
      },
      "STORE_DUPLICATE_ID",
    ],
    [
      "a task ID reused in another change",
      (repo) => {
        const value = readRecord(repo, "changes/CHANGE-001/tasks/TASK-001.json");
        writeRecord(repo, "changes/CHANGE-002/tasks/TASK-001.json", {
          ...value,
          change_id: "CHANGE-002",
          baseline_id: undefined,
        });
      },
      "STORE_DUPLICATE_ID",
    ],
    [
      "artifacts under a change folder without change.json",
      (repo) => repo.delete("changes/CHANGE-002/change.json"),
      "STORE_CHANGE_MISSING",
    ],
    [
      "edited content bytes",
      (repo) => repo.set("changes/CHANGE-001/content/engineering.md", new TextEncoder().encode("# Changed\n")),
      "STORE_CONTENT_DIGEST_MISMATCH",
      `${DESIGN}#/content`,
    ],
    ["missing content", (repo) => repo.delete("changes/CHANGE-001/content/engineering.md"), "STORE_CONTENT_MISSING"],
    [
      "a dependency on an unknown artifact",
      (repo) => editRecord(repo, DESIGN, (value) => (value.depends_on as string[]).push("GHOST-001")),
      "STORE_UNKNOWN_ARTIFACT",
      `${DESIGN}#/depends_on/2`,
    ],
    [
      "a project artifact depending on a change artifact",
      (repo) => editRecord(repo, SHARED, (value) => Object.assign(value, { depends_on: ["DESIGN-001"] })),
      "STORE_PROJECT_DEPENDS_ON_CHANGE",
    ],
    [
      "a project artifact claiming coverage",
      (repo) => editRecord(repo, SHARED, (value) => Object.assign(value, { covered_change_ids: ["CHANGE-001"] })),
      "STORE_PROJECT_COVERAGE",
    ],
    [
      "an unknown source",
      (repo) => editRecord(repo, DESIGN, (value) => (value.source_ids as string[]).push("src-ghost")),
      "STORE_UNKNOWN_SOURCE",
    ],
    [
      "coverage of an unknown change",
      (repo) =>
        editRecord(repo, "changes/QA-CAMPAIGN-001/artifacts/QA-BATCH-001.json", (value) =>
          (value.covered_change_ids as string[]).push("CHANGE-404"),
        ),
      "STORE_UNKNOWN_CHANGE",
    ],
    [
      "a read input that isn't a declared dependency",
      (repo) =>
        editRecord(repo, DESIGN, (value) =>
          Object.assign(value, { depends_on: (value.depends_on as string[]).slice(0, 1) }),
        ),
      "STORE_CONTEXT_UNDECLARED",
      `${DESIGN}#/context/references/2`,
    ],
    [
      "a task naming an unknown artifact",
      (repo) =>
        editRecord(repo, "changes/CHANGE-001/tasks/TASK-001.json", (value) =>
          (value.artifact_ids as string[]).push("GHOST-001"),
        ),
      "STORE_UNKNOWN_ARTIFACT",
    ],
    [
      "a task depending on an unknown task",
      (repo) =>
        editRecord(repo, "changes/CHANGE-001/tasks/TASK-001.json", (value) =>
          Object.assign(value, { dependency_tasks: ["TASK-404"] }),
        ),
      "STORE_UNKNOWN_TASK",
    ],
    [
      "a task naming an unknown baseline",
      (repo) => repo.delete("baselines/BASELINE-001.json"),
      "STORE_UNKNOWN_BASELINE",
    ],
    [
      "findings for an unknown artifact",
      (repo) =>
        editRecord(repo, "changes/CHANGE-001/findings.json", (value) =>
          (value.reviewed_artifacts as unknown[]).push({ id: "GHOST-001", sha256: "a".repeat(64) }),
        ),
      "STORE_UNKNOWN_ARTIFACT",
    ],
    [
      "edited snapshot bytes",
      (repo) => repo.set("sources/snapshots/catalog-requirement.md", new TextEncoder().encode("changed\n")),
      "STORE_SNAPSHOT_DIGEST_MISMATCH",
    ],
    [
      "a snapshot outside sources/snapshots",
      (repo) =>
        editRecord(repo, "sources/src-catalog-requirement.json", (value) =>
          Object.assign(value, { snapshot_path: "changes/CHANGE-001/content/requirements.md" }),
        ),
      "STORE_SNAPSHOT_OUTSIDE",
    ],
    [
      "artifacts that depend on each other",
      (repo) =>
        editRecord(repo, "changes/CHANGE-001/artifacts/REQDOC-001.json", (value) =>
          Object.assign(value, { depends_on: ["DESIGN-001"] }),
        ),
      "STORE_DEPENDENCY_CYCLE",
    ],
  ];

  for (const [name, mutate, code, path] of cases) {
    test(`reports ${name}`, () => {
      const repo = sampleRepository();
      mutate(repo);
      const result = index(repo);
      const match = result.diagnostics.find((entry) => entry.code === code);
      assert.ok(match, `${code} not in ${JSON.stringify(codes(result))}`);
      if (path !== undefined) assert.equal(match.path, path);
    });
  }

  test("an untrusted record is left out; a record with broken references stays in", () => {
    const repo = sampleRepository();
    editRecord(repo, DESIGN, (value) => Object.assign(value, { state: "approved" }));
    editRecord(repo, "changes/CHANGE-001/artifacts/QA-001.json", (value) =>
      (value.depends_on as string[]).push("GHOST-001"),
    );
    const result = index(repo);
    assert.equal(result.artifacts.has("DESIGN-001"), false);
    assert.equal(result.artifacts.has("QA-001"), true);
  });

  test("unverified bytes leave the semantic digest unset", () => {
    const repo = sampleRepository();
    repo.set("changes/CHANGE-001/content/engineering.md", new TextEncoder().encode("# Changed\n"));
    const artifact = index(repo).artifacts.get("DESIGN-001");
    assert.equal(artifact?.bytesVerified, false);
    assert.equal(artifact?.semanticDigest, null);
  });

  test("content outside its scope's folder is a warning, not an error", () => {
    const repo = sampleRepository();
    const content = repo.get("changes/CHANGE-001/content/engineering.md") as Uint8Array;
    repo.set("docs/engineering.md", content);
    editRecord(repo, DESIGN, (value) =>
      Object.assign(value, { content: { ...(value.content as object), path: "docs/engineering.md" } }),
    );
    const result = index(repo);
    assert.deepEqual(added(result), ["STORE_CONTENT_OUTSIDE_SCOPE"]);
    assert.ok(result.diagnostics.every((entry) => entry.severity === "warning"));
    assert.ok(result.artifacts.get("DESIGN-001")?.semanticDigest);
  });

  test("a captured source without a snapshot is noted for the reviewer", () => {
    const repo = sampleRepository();
    editRecord(repo, "sources/src-catalog-requirement.json", (value) => {
      delete value.snapshot_path;
    });
    const result = index(repo);
    assert.deepEqual(added(result), ["STORE_SNAPSHOT_ABSENT"]);
    assert.equal(result.diagnostics.find((entry) => entry.code === "STORE_SNAPSHOT_ABSENT")?.severity, "info");
  });

  test("a cycle is reported once, naming every member", () => {
    const repo = sampleRepository();
    editRecord(repo, "changes/CHANGE-001/artifacts/REQDOC-001.json", (value) =>
      Object.assign(value, { depends_on: ["DESIGN-001"] }),
    );
    const cycles = index(repo).diagnostics.filter((entry) => entry.code === "STORE_DEPENDENCY_CYCLE");
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0]?.evidence, ["CONTRACT-001", "DESIGN-001", "REQDOC-001"]);
  });

  test("an artifact that depends on itself is a cycle", () => {
    const repo = sampleRepository();
    editRecord(repo, "changes/CHANGE-001/artifacts/REQDOC-001.json", (value) =>
      Object.assign(value, { depends_on: ["REQDOC-001"] }),
    );
    assert.ok(codes(index(repo)).includes("STORE_DEPENDENCY_CYCLE"));
  });

  test("limits: artifact count, record size and dependency depth", () => {
    const repo = sampleRepository();
    assert.deepEqual(added(index(repo, { maxArtifacts: 7 })), ["STORE_LIMIT_EXCEEDED"]);
    const tooLarge = index(repo, { maxMetadataBytes: 1024 });
    assert.ok(codes(tooLarge).includes("STORE_RECORD_TOO_LARGE"));
    const deep = index(repo, { maxDependencyDepth: 2 });
    const flagged = deep.diagnostics.filter((entry) => entry.code === "STORE_DEPENDENCY_TOO_DEEP");
    assert.deepEqual(flagged.map((entry) => entry.message.split(" ")[1]).sort(), [
      "DESIGN-001",
      "QA-001",
      "QA-BATCH-001",
      "REVIEW-001",
    ]);
  });

  test("a long dependency chain doesn't overflow the stack", () => {
    const repo = sampleRepository();
    const template = readRecord(repo, "shared/artifacts/SHARED-STATUS-001.json");
    for (let i = 0; i < 3000; i++) {
      const id = `CHAIN-${String(i).padStart(4, "0")}`;
      writeRecord(repo, `shared/artifacts/${id}.json`, {
        ...template,
        id,
        depends_on: i === 0 ? [] : [`CHAIN-${String(i - 1).padStart(4, "0")}`],
      });
    }
    const result = index(repo);
    const deep = result.diagnostics.filter((entry) => entry.code === "STORE_DEPENDENCY_TOO_DEEP");
    assert.equal(deep.length, 3000 - 100);
    assert.equal(transitiveDependents(result, ["CHAIN-0000"]).length, 2999);
  });
});
