// Framework schemas and structural validation (backlog B02, rule DL001).
// Mirrors the design package's own checker: same instance mapping, same negative mutations.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  compileAllSchemas,
  SCHEMA_KINDS,
  SCHEMA_NAMESPACE,
  type SchemaKind,
  schemaFor,
  schemaId,
  validateAgainstSchema,
} from "@design-loom/validation";

const DESIGN = join(import.meta.dirname, "..", "..", "fixtures", "design");
const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(DESIGN, path), "utf8"));
const jsonIn = (folder: string): string[] =>
  readdirSync(join(DESIGN, folder))
    .filter((file) => file.endsWith(".json"))
    .map((file) => `${folder}/${file}`);

/** Same mapping as the design package's validation/validate_package.py. */
const INSTANCES: Record<SchemaKind, string[]> = {
  application: ["examples/application.json"],
  "approval-evidence": ["examples/approval-evidence.json"],
  artifact: [
    ...jsonIn("examples/artifacts"),
    ...jsonIn("examples/shared/artifacts"),
    "examples/late-qa/DESIGN-002.json",
    "examples/late-qa/QA-BATCH-001.json",
  ],
  baseline: ["examples/baseline.json"],
  change: ["examples/change.json", "examples/late-qa/change-engineering.json", "examples/late-qa/change-qa.json"],
  context: ["examples/context.json"],
  "effective-config": ["examples/effective-config.json"],
  extension: ["examples/extension/extension.json"],
  findings: ["examples/findings.json"],
  "framework-lock": ["examples/framework-lock.json"],
  handoff: ["examples/handoff.json", "examples/handoff-unreviewed.json"],
  run: ["examples/run.json"],
  source: ["examples/source.json", "examples/source-unavailable.json"],
  task: ["examples/task.json", "examples/task-unreviewed.json"],
  template: jsonIn("templates"),
  traceability: ["examples/traceability.json", "examples/late-qa/traceability.json"],
  workflow: ["examples/workflow.json"],
  workspace: ["examples/workspace.json"],
};

/** Collects every "$ref" value in a schema document. */
function refs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refs);
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [value] : refs(value),
  );
}

describe("bundled schemas", () => {
  test("cover the 18 framework object kinds", () => {
    assert.equal(SCHEMA_KINDS.length, 18);
  });

  test("all compile under Ajv's strict schema checks", () => {
    compileAllSchemas();
  });

  test("declare Draft 2020-12 and an $id in the design namespace", () => {
    for (const kind of SCHEMA_KINDS) {
      const schema = schemaFor(kind);
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", kind);
      assert.equal(schema.$id, schemaId(kind), kind);
      assert.ok(String(schema.$id).startsWith(SCHEMA_NAMESPACE), kind);
    }
  });

  test("only reference other bundled schemas or themselves (no remote references)", () => {
    const ids = new Set(SCHEMA_KINDS.map(schemaId));
    for (const kind of SCHEMA_KINDS) {
      for (const ref of refs(schemaFor(kind))) {
        assert.ok(ref.startsWith("#") || ids.has(ref.split("#")[0] ?? ""), `${kind} references ${ref}`);
      }
    }
  });
});

describe("design package examples are valid", () => {
  test("the mapping covers all 36 instances the design checker validates", () => {
    assert.equal(Object.values(INSTANCES).flat().length, 36);
  });

  for (const kind of SCHEMA_KINDS) {
    for (const path of INSTANCES[kind]) {
      test(`${kind}: ${path}`, () => {
        const result = validateAgainstSchema(kind, read(path));
        assert.deepEqual(result.issues, []);
        assert.equal(result.valid, true);
      });
    }
  }
});

describe("negative mutations are rejected", () => {
  // The design package's 23 negative cases, in the same order.
  // biome-ignore lint/suspicious/noExplicitAny: mutations reach into arbitrary nested fixture JSON
  const cases: Array<[string, SchemaKind, string, (value: any) => void]> = [
    [
      "author-approved state",
      "artifact",
      "examples/artifacts/DESIGN-001.json",
      (a) => {
        a.state = "approved";
      },
    ],
    [
      "unknown config field",
      "application",
      "examples/application.json",
      (a) => {
        a.silent_override = true;
      },
    ],
    [
      "parent traversal",
      "artifact",
      "examples/artifacts/DESIGN-001.json",
      (a) => {
        a.content.path = "../outside.md";
      },
    ],
    [
      "Windows absolute path",
      "artifact",
      "examples/artifacts/DESIGN-001.json",
      (a) => {
        a.content.path = "C:\\outside.md";
      },
    ],
    [
      "floating branch",
      "handoff",
      "examples/handoff.json",
      (a) => {
        a.target.starting_commit = "main";
      },
    ],
    [
      "captured source without digest",
      "source",
      "examples/source.json",
      (a) => {
        delete a.sha256;
      },
    ],
    [
      "executable extension rule",
      "extension",
      "examples/extension/extension.json",
      (a) => {
        a.rules[0].kind = "shell";
      },
    ],
    [
      "duplicate requested baseline role",
      "baseline",
      "examples/baseline.json",
      (a) => {
        a.required_review_roles = ["qa", "qa"];
      },
    ],
    [
      "duplicate configured reviewer role",
      "application",
      "examples/application.json",
      (a) => {
        a.required_review_roles = ["qa", "qa"];
      },
    ],
    [
      "empty command argv",
      "task",
      "examples/task.json",
      (a) => {
        a.checks[0].argv = [];
      },
    ],
    [
      "unbound task digest",
      "handoff",
      "examples/handoff.json",
      (a) => {
        delete a.task_digest;
      },
    ],
    [
      "project artifact with change owner",
      "artifact",
      "examples/shared/artifacts/SHARED-STATUS-001.json",
      (a) => {
        a.change_id = "CHANGE-001";
      },
    ],
    [
      "project artifact with workflow step",
      "artifact",
      "examples/shared/artifacts/SHARED-STATUS-001.json",
      (a) => {
        a.workflow_step = "contracts";
      },
    ],
    [
      "legacy change artifact without change owner",
      "artifact",
      "examples/artifacts/DESIGN-001.json",
      (a) => {
        delete a.change_id;
      },
    ],
    [
      "empty baseline predecessor list",
      "baseline",
      "examples/baseline.json",
      (a) => {
        a.supersedes = [];
      },
    ],
    [
      "nested effective application field",
      "effective-config",
      "examples/effective-config.json",
      (a) => {
        a.configuration.application.silent_override = true;
      },
    ],
    [
      "read context without digest",
      "context",
      "examples/context.json",
      (a) => {
        delete a.references[0].sha256;
      },
    ],
    [
      "read source context without revision",
      "context",
      "examples/context.json",
      (a) => {
        delete a.references[0].revision;
      },
    ],
    [
      "verified review without baseline binding",
      "handoff",
      "examples/handoff-unreviewed.json",
      (a) => {
        a.review_status = "verified";
      },
    ],
    [
      "partial baseline binding",
      "handoff",
      "examples/handoff-unreviewed.json",
      (a) => {
        a.baseline_id = "BASELINE-001";
      },
    ],
    [
      "empty declared campaign coverage",
      "artifact",
      "examples/late-qa/QA-BATCH-001.json",
      (a) => {
        a.covered_change_ids = [];
      },
    ],
    [
      "unavailable context without recorded gap",
      "context",
      "examples/context.json",
      (a) => {
        a.gaps = [];
      },
    ],
    [
      "legacy handoff readiness field",
      "handoff",
      "examples/handoff-unreviewed.json",
      (a) => {
        a.readiness = a.snapshot_integrity;
        delete a.snapshot_integrity;
      },
    ],
  ];

  test("there are 23 cases, matching the design checker", () => {
    assert.equal(cases.length, 23);
  });

  for (const [name, kind, path, mutate] of cases) {
    test(name, () => {
      const value = read(path);
      mutate(value);
      const result = validateAgainstSchema(kind, value);
      assert.equal(result.valid, false);
      assert.ok(result.issues.length > 0);
    });
  }
});

describe("results", () => {
  test("are deterministic: the same input gives the same sorted issues", () => {
    const value = { id: 7, extra: true };
    const first = validateAgainstSchema("change", value);
    const second = validateAgainstSchema("change", structuredClone(value));
    assert.deepEqual(first, second);
    const sorted = [...first.issues].sort((a, b) =>
      a.instancePath === b.instancePath ? a.keyword.localeCompare(b.keyword) : a.instancePath < b.instancePath ? -1 : 1,
    );
    assert.deepEqual(
      first.issues.map((i) => i.instancePath),
      sorted.map((i) => i.instancePath),
    );
  });

  test("check formats: an invalid date-time is rejected", () => {
    const value = read("examples/source.json");
    value.retrieved_at = "yesterday";
    const result = validateAgainstSchema("source", value);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.keyword === "format"));
  });
});
