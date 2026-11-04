// artifact-semantic-v1 (backlog B03, design doc 03 "Artifact semantic digest", acceptance AT-53).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  ArtifactSemanticError,
  type ArtifactSemanticInput,
  artifactSemanticDigest,
  artifactSemanticProjection,
} from "@design-loom/artifacts";
import { parseJson } from "@design-loom/config";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "design");

interface Vector {
  id: string;
  artifact: ArtifactSemanticInput & Record<string, unknown>;
  projection: unknown;
  sha256: string;
}

const vectorFile = parseJson(readFileSync(join(FIXTURES, "artifact-semantic-v1-vectors.json"), "utf8")) as unknown as {
  contract: string;
  vectors: Vector[];
};

const byId = (id: string): Vector["artifact"] => {
  const vector = vectorFile.vectors.find((v) => v.id === id);
  assert.ok(vector, `missing vector ${id}`);
  return structuredClone(vector.artifact);
};

describe("design package vectors", () => {
  test("the fixture declares the artifact-semantic-v1 contract", () => {
    assert.equal(vectorFile.contract, "artifact-semantic-v1");
    assert.deepEqual(
      vectorFile.vectors.map((v) => v.id),
      ["change-artifact", "project-artifact"],
    );
  });

  for (const vector of vectorFile.vectors) {
    test(`${vector.id}: exact projection and SHA-256`, () => {
      assert.deepEqual(artifactSemanticProjection(vector.artifact), vector.projection);
      assert.equal(artifactSemanticDigest(vector.artifact), vector.sha256);
    });
  }
});

describe("lifecycle and presentation edits keep the digest", () => {
  const edits: Array<[string, (a: Record<string, unknown>) => void]> = [
    ["state change", (a) => Object.assign(a, { state: "superseded" })],
    ["title change", (a) => Object.assign(a, { title: "Renamed" })],
    [
      "context receipt change",
      (a) => Object.assign(a, { context: { schema_version: "1.0", references: [], gaps: [] } }),
    ],
    ["workflow step change", (a) => Object.assign(a, { workflow_step: "review" })],
    ["owner role change", (a) => Object.assign(a, { owner_role: "architecture" })],
    ["template version bump", (a) => Object.assign(a, { template_version: "9.9.9" })],
    [
      "content moved without byte changes",
      (a) => Object.assign(a, { content: { ...(a.content as object), path: "x.md" } }),
    ],
    ["dependency order reversed", (a) => Object.assign(a, { depends_on: [...(a.depends_on as string[])].reverse() })],
    ["absent vs empty applicability_reason", (a) => Object.assign(a, { applicability_reason: "" })],
    ["absent vs empty payload", (a) => Object.assign(a, { payload: {} })],
  ];
  for (const [name, edit] of edits) {
    test(name, () => {
      const original = byId("change-artifact");
      const edited = byId("change-artifact");
      edit(edited);
      assert.equal(artifactSemanticDigest(edited), artifactSemanticDigest(original));
    });
  }

  test("attachment order", () => {
    const a = byId("change-artifact");
    a.attachments = [
      { path: "b.json", sha256: "1".repeat(64) },
      { path: "a.json", sha256: "2".repeat(64) },
    ];
    const b = structuredClone(a);
    b.attachments = [...b.attachments].reverse();
    assert.equal(artifactSemanticDigest(a), artifactSemanticDigest(b));
  });

  test("explicit change scope equals the legacy default", () => {
    const legacy = byId("change-artifact");
    delete legacy.scope;
    const explicit = byId("change-artifact");
    explicit.scope = "change";
    assert.equal(artifactSemanticDigest(legacy), artifactSemanticDigest(explicit));
  });
});

describe("meaningful edits change the digest", () => {
  const edits: Array<[string, (a: Record<string, unknown>) => void]> = [
    ["content bytes", (a) => Object.assign(a, { content: { ...(a.content as object), sha256: "0".repeat(64) } })],
    ["added attachment", (a) => Object.assign(a, { attachments: [{ path: "x.json", sha256: "1".repeat(64) }] })],
    ["added dependency", (a) => Object.assign(a, { depends_on: [...(a.depends_on as string[]), "SHARED-001"] })],
    [
      "added requirement",
      (a) => Object.assign(a, { requirement_ids: [...(a.requirement_ids as string[]), "REQ-999"] }),
    ],
    ["added source", (a) => Object.assign(a, { source_ids: [...(a.source_ids as string[]), "src-new"] })],
    ["coverage", (a) => Object.assign(a, { covered_change_ids: ["CHANGE-002"] })],
    ["applicability", (a) => Object.assign(a, { applicability: "not_applicable", applicability_reason: "No UI" })],
    ["payload", (a) => Object.assign(a, { payload: { limit: 10 } })],
    ["extension data", (a) => Object.assign(a, { extensions: { "acme.review": { level: 1 } } })],
    ["owning change", (a) => Object.assign(a, { change_id: "CHANGE-999" })],
    ["type", (a) => Object.assign(a, { type: "contract" })],
  ];
  for (const [name, edit] of edits) {
    test(name, () => {
      const original = byId("change-artifact");
      const edited = byId("change-artifact");
      edit(edited);
      assert.notEqual(artifactSemanticDigest(edited), artifactSemanticDigest(original));
    });
  }

  test("attachment bytes", () => {
    const a = byId("change-artifact");
    a.attachments = [{ path: "a.json", sha256: "1".repeat(64) }];
    const b = structuredClone(a);
    b.attachments = [{ path: "a.json", sha256: "2".repeat(64) }];
    assert.notEqual(artifactSemanticDigest(a), artifactSemanticDigest(b));
  });
});

describe("invalid input", () => {
  test("rejects duplicate IDs", () => {
    const a = byId("change-artifact");
    a.depends_on = ["REQDOC-001", "REQDOC-001"];
    assert.throws(() => artifactSemanticDigest(a), ArtifactSemanticError);
  });

  test("rejects duplicate attachment paths", () => {
    const a = byId("change-artifact");
    a.attachments = [
      { path: "a.json", sha256: "1".repeat(64) },
      { path: "a.json", sha256: "2".repeat(64) },
    ];
    assert.throws(() => artifactSemanticDigest(a), ArtifactSemanticError);
  });

  test("rejects a change-scoped artifact without change_id", () => {
    const a = byId("change-artifact");
    delete a.change_id;
    assert.throws(() => artifactSemanticDigest(a), ArtifactSemanticError);
  });

  test("project scope always projects change_id as null", () => {
    const a = byId("project-artifact");
    assert.equal(artifactSemanticProjection(a).change_id, null);
  });
});
