// Planning for change init and artifact register (backlog B06; design docs 03 and 07).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  type ArtifactRequest,
  artifactSemanticDigest,
  buildStoreIndex,
  type Plan,
  planArtifact,
  planChange,
  type RegistrationConfig,
  registrationConfigOf,
  type StoreIndex,
} from "@design-loom/artifacts";
import type { EffectiveConfiguration } from "@design-loom/config";
import { validateAgainstSchema } from "@design-loom/validation";
import { editRecord, sampleRepository, storeInput } from "../../support/sample-store.ts";

const EXAMPLES = join(import.meta.dirname, "..", "..", "fixtures", "design", "examples");
const configuration = (
  JSON.parse(readFileSync(join(EXAMPLES, "effective-config.json"), "utf8")) as {
    configuration: EffectiveConfiguration;
  }
).configuration;
const config = registrationConfigOf(configuration);
const DIGEST = "c".repeat(64);

const indexOf = (repo = sampleRepository()): StoreIndex => buildStoreIndex(storeInput(repo));
const index = indexOf();
const codes = (plan: Plan): string[] => plan.diagnostics.map((entry) => entry.code);
const decode = (plan: Plan, path: string): Record<string, unknown> => {
  const file = plan.files.find((candidate) => candidate.path === path);
  assert.ok(file, `${path} is planned`);
  return JSON.parse(new TextDecoder().decode(file.bytes));
};

describe("registration configuration", () => {
  test("is read from the effective configuration", () => {
    assert.equal(config.applicationId, "sample-catalog");
    assert.equal(config.frameworkVersion, "0.1.0");
    assert.deepEqual(config.knownRoles, ["architecture", "engineering", "qa"]);
    assert.deepEqual(config.repositoryIds, ["catalog-design", "catalog-api"]);
    assert.ok(config.artifactTypes.includes("engineering-design"));
    assert.deepEqual(
      config.workflows[0]?.steps.find((step) => step.id === "engineering"),
      { id: "engineering", requiredOutputs: ["engineering-design"] },
    );
  });
});

describe("change init", () => {
  const request = { id: "CHANGE-010", title: "Dashboard API", workflowId: "core.feature-design" };

  test("plans the change record and an empty traceability file, change last", () => {
    const plan = planChange(request, config, index, []);
    assert.deepEqual(plan.diagnostics, []);
    assert.deepEqual(
      plan.files.map((file) => file.path),
      ["changes/CHANGE-010/traceability.json", "changes/CHANGE-010/change.json"],
    );
    const change = decode(plan, "changes/CHANGE-010/change.json");
    assert.deepEqual(change, {
      schema_version: "1.0",
      id: "CHANGE-010",
      application_id: "sample-catalog",
      title: "Dashboard API",
      workflow_id: "core.feature-design",
      workflow_version: "0.1.0",
      requirement_ids: [],
      source_ids: [],
      target_repository_ids: [],
      scope: "Dashboard API",
      exclusions: [],
      owner_roles: ["architecture", "engineering", "qa"],
    });
    assert.deepEqual(decode(plan, "changes/CHANGE-010/traceability.json"), {
      schema_version: "1.0",
      change_id: "CHANGE-010",
      requirements: [],
      tests: [],
      design_links: [],
      gaps: [],
    });
    for (const [path, kind] of [
      ["changes/CHANGE-010/change.json", "change"],
      ["changes/CHANGE-010/traceability.json", "traceability"],
    ] as const) {
      assert.equal(validateAgainstSchema(kind, decode(plan, path)).valid, true, path);
    }
  });

  test("records what the caller supplies", () => {
    const plan = planChange(
      {
        ...request,
        summary: "Dashboard endpoints only.",
        ownerRoles: ["qa", "engineering"],
        requirementIds: ["REQ-9", "REQ-2"],
        sourceIds: ["src-catalog-requirement"],
        repositoryIds: ["catalog-api"],
        exclusions: ["Exports"],
      },
      config,
      index,
      [],
    );
    assert.deepEqual(plan.diagnostics, []);
    const change = decode(plan, "changes/CHANGE-010/change.json");
    assert.equal(change.scope, "Dashboard endpoints only.");
    assert.deepEqual(change.owner_roles, ["engineering", "qa"]);
    assert.deepEqual(change.requirement_ids, ["REQ-2", "REQ-9"]);
    assert.deepEqual(change.source_ids, ["src-catalog-requirement"]);
    assert.deepEqual(change.target_repository_ids, ["catalog-api"]);
    assert.deepEqual(change.exclusions, ["Exports"]);
  });

  test("refuses an existing change, ignoring case, and a folder the index could not read", () => {
    assert.deepEqual(codes(planChange({ ...request, id: "CHANGE-001" }, config, index, [])), ["CHANGE_EXISTS"]);
    assert.deepEqual(codes(planChange({ ...request, id: "change-001" }, config, index, [])), ["CHANGE_EXISTS"]);
    assert.deepEqual(codes(planChange(request, config, index, ["Change-010"])), ["CHANGE_EXISTS"]);
    assert.deepEqual(planChange({ ...request, id: "CHANGE-001" }, config, index, []).files, []);
  });

  test("refuses bad input with a code for each problem", () => {
    const cases: [Partial<typeof request> & Record<string, unknown>, string][] = [
      [{ id: "1bad" }, "REGISTER_INVALID_ID"],
      [{ title: "  " }, "REGISTER_EMPTY_TITLE"],
      [{ workflowId: "no.such" }, "REGISTER_UNKNOWN_WORKFLOW"],
      [{ sourceIds: ["src-missing"] }, "REGISTER_UNKNOWN_SOURCE"],
      [{ repositoryIds: ["nope"] }, "REGISTER_UNKNOWN_REPOSITORY"],
      [{ requirementIds: ["REQ-1", "req-1"] }, "REGISTER_DUPLICATE_ID"],
      [{ ownerRoles: ["bad role"] }, "REGISTER_INVALID_ID"],
    ];
    for (const [change, expected] of cases) {
      const plan = planChange({ ...request, ...change }, config, index, []);
      assert.ok(codes(plan).includes(expected), `${JSON.stringify(change)} → ${codes(plan)}`);
      assert.deepEqual(plan.files, []);
    }
  });

  test("needs an owner role when the application names none", () => {
    const bare: RegistrationConfig = { ...config, knownRoles: [] };
    assert.deepEqual(codes(planChange(request, bare, index, [])), ["REGISTER_OWNER_ROLE_REQUIRED"]);
    assert.deepEqual(planChange({ ...request, ownerRoles: ["qa"] }, bare, index, []).diagnostics, []);
  });
});

describe("artifact register: change scope", () => {
  const request: ArtifactRequest = {
    id: "DESIGN-010",
    type: "engineering-design",
    title: "Dashboard engineering",
    scope: { kind: "change", changeId: "CHANGE-002" },
    content: { path: "changes/CHANGE-002/content/dashboard.md", sha256: DIGEST },
    ownerRole: "engineering",
  };
  const path = "changes/CHANGE-002/artifacts/DESIGN-010.json";

  test("plans a draft sidecar with the step, template and framework version filled in", () => {
    const plan = planArtifact(request, config, index);
    assert.deepEqual(plan.diagnostics, []);
    assert.deepEqual(
      plan.files.map((file) => file.path),
      [path],
    );
    const record = decode(plan, path);
    assert.deepEqual(record, {
      schema_version: "1.0",
      id: "DESIGN-010",
      application_id: "sample-catalog",
      change_id: "CHANGE-002",
      type: "engineering-design",
      title: "Dashboard engineering",
      state: "draft",
      workflow_step: "engineering",
      template_id: "core.engineering-design",
      template_version: "0.1.0",
      framework_version: "0.1.0",
      content: { path: "changes/CHANGE-002/content/dashboard.md", sha256: DIGEST },
      attachments: [],
      source_ids: [],
      requirement_ids: [],
      depends_on: [],
      owner_role: "engineering",
      applicability: "applicable",
      context: { schema_version: "1.0", references: [], gaps: [] },
    });
    assert.equal(validateAgainstSchema("artifact", record).valid, true);
    assert.equal(plan.semanticDigest, artifactSemanticDigest(record as never));
  });

  test("binds a context receipt to the digests the index holds", () => {
    const plan = planArtifact(
      {
        ...request,
        dependsOn: ["REQDOC-001", "SHARED-STATUS-001"],
        sourceIds: ["src-catalog-requirement", "src-optional-notes"],
      },
      config,
      index,
    );
    assert.deepEqual(plan.diagnostics, []);
    const { context } = decode(plan, path) as { context: { references: Record<string, unknown>[] } };
    const requirement = index.artifacts.get("REQDOC-001");
    const shared = index.artifacts.get("SHARED-STATUS-001");
    assert.deepEqual(context.references, [
      {
        kind: "source",
        id: "src-catalog-requirement",
        state: "read",
        revision: "tutorial-v1",
        sha256: "63ce285f0d0a330b69118a5d650cceb60b6347ccf9d9d5dad229ca971d334e3a",
      },
      // The source has no recorded bytes, so it is named, not claimed as read.
      { kind: "source", id: "src-optional-notes", state: "linked" },
      { kind: "artifact", id: "REQDOC-001", state: "read", sha256: requirement?.semanticDigest },
      { kind: "artifact", id: "SHARED-STATUS-001", state: "read", sha256: shared?.semanticDigest },
    ]);
    assert.deepEqual((decode(plan, path) as { depends_on: string[] }).depends_on, ["REQDOC-001", "SHARED-STATUS-001"]);
  });

  test("a QA artifact can cover several changes", () => {
    const plan = planArtifact(
      {
        id: "QA-010",
        type: "test-design",
        scope: { kind: "change", changeId: "QA-CAMPAIGN-001" },
        coveredChangeIds: ["CHANGE-002", "CHANGE-001"],
        content: { path: "changes/QA-CAMPAIGN-001/content/campaign.md", sha256: DIGEST },
        dependsOn: ["DESIGN-002"],
      },
      config,
      index,
    );
    assert.deepEqual(plan.diagnostics, []);
    const record = decode(plan, "changes/QA-CAMPAIGN-001/artifacts/QA-010.json");
    assert.deepEqual(record.covered_change_ids, ["CHANGE-001", "CHANGE-002"]);
    assert.equal(record.workflow_step, "qa");
    assert.equal(record.owner_role, "qa", "the campaign has one owner role");
    assert.equal(record.title, "QA-010", "the ID is the default title");
  });

  test("attachments are hashed and kept in the content folder", () => {
    const plan = planArtifact(
      {
        ...request,
        attachments: [
          { path: "changes/CHANGE-002/content/b.png", sha256: "d".repeat(64) },
          { path: "changes/CHANGE-002/content/a.png", sha256: "e".repeat(64) },
        ],
      },
      config,
      index,
    );
    assert.deepEqual(plan.diagnostics, []);
    assert.deepEqual((decode(plan, path) as { attachments: unknown[] }).attachments, [
      { path: "changes/CHANGE-002/content/b.png", sha256: "d".repeat(64) },
      { path: "changes/CHANGE-002/content/a.png", sha256: "e".repeat(64) },
    ]);
    const outside = planArtifact({ ...request, attachments: [{ path: "docs/a.png", sha256: DIGEST }] }, config, index);
    assert.deepEqual(codes(outside), ["REGISTER_CONTENT_OUTSIDE_SCOPE"]);
  });

  test("refuses what design doc 07 says to refuse", () => {
    const cases: [Partial<ArtifactRequest>, string][] = [
      [{ scope: { kind: "change", changeId: "CHANGE-404" } }, "REGISTER_UNKNOWN_CHANGE"],
      [{ id: "DESIGN-001" }, "ARTIFACT_EXISTS"],
      [{ id: "design-001" }, "ARTIFACT_EXISTS"],
      [{ id: "SHARED-STATUS-001" }, "ARTIFACT_EXISTS"],
      [{ type: "nonsense" }, "REGISTER_UNKNOWN_ARTIFACT_TYPE"],
      [{ content: { path: "docs/design.md", sha256: DIGEST } }, "REGISTER_CONTENT_OUTSIDE_SCOPE"],
      [{ content: { path: "changes/CHANGE-001/content/design.md", sha256: DIGEST } }, "REGISTER_CONTENT_OUTSIDE_SCOPE"],
      [{ content: { path: "shared/content/design.md", sha256: DIGEST } }, "REGISTER_CONTENT_OUTSIDE_SCOPE"],
      [{ content: { path: "changes/CHANGE-002/content/", sha256: DIGEST } }, "REGISTER_UNSAFE_PATH"],
      [{ coveredChangeIds: ["CHANGE-001", "change-001"] }, "REGISTER_DUPLICATE_ID"],
      [{ content: { path: "../etc/passwd", sha256: DIGEST } }, "REGISTER_UNSAFE_PATH"],
      [{ dependsOn: ["NOPE-001"] }, "REGISTER_UNKNOWN_DEPENDENCY"],
      [{ dependsOn: ["DESIGN-010"] }, "REGISTER_SELF_DEPENDENCY"],
      [{ sourceIds: ["src-missing"] }, "REGISTER_UNKNOWN_SOURCE"],
      [{ coveredChangeIds: ["CHANGE-404"] }, "REGISTER_UNKNOWN_COVERED_CHANGE"],
      [{ workflowStep: "nope" }, "REGISTER_UNKNOWN_STEP"],
      [{ ownerRole: "product" }, "REGISTER_OWNER_ROLE_NOT_IN_CHANGE"],
      [{ dependsOn: ["REQDOC-001", "reqdoc-001"] }, "REGISTER_DUPLICATE_ID"],
    ];
    for (const [change, expected] of cases) {
      const plan = planArtifact({ ...request, ...change }, config, index);
      assert.ok(codes(plan).includes(expected), `${JSON.stringify(change)} → ${codes(plan)}`);
      assert.deepEqual(plan.files, []);
      assert.equal(plan.semanticDigest, null);
    }
  });

  test("an owner role is needed when the change allows several", () => {
    const { ownerRole: _omitted, ...without } = request;
    const plan = planArtifact({ ...without, scope: { kind: "change", changeId: "CHANGE-001" } }, config, index);
    assert.ok(codes(plan).includes("REGISTER_OWNER_ROLE_REQUIRED"));
  });

  test("a step is needed when the workflow doesn't say which one produces the type", () => {
    const twoSteps: RegistrationConfig = {
      ...config,
      workflows: config.workflows.map((workflow) => ({
        ...workflow,
        steps: [...workflow.steps, { id: "engineering-again", requiredOutputs: ["engineering-design"] }],
      })),
    };
    const plan = planArtifact(request, twoSteps, index);
    assert.deepEqual(codes(plan), ["REGISTER_STEP_REQUIRED"]);
    const chosen = planArtifact({ ...request, workflowStep: "engineering-again" }, twoSteps, index);
    assert.equal(decode(chosen, path).workflow_step, "engineering-again");
    const none: RegistrationConfig = {
      ...config,
      workflows: config.workflows.map((workflow) => ({
        ...workflow,
        steps: workflow.steps.filter((step) => step.id !== "engineering"),
      })),
    };
    assert.deepEqual(codes(planArtifact(request, none, index)), ["REGISTER_STEP_REQUIRED"]);
  });

  test("a dependency or source whose bytes no longer match is not receipted", () => {
    const repo = sampleRepository();
    repo.set("changes/CHANGE-001/content/requirements.md", new TextEncoder().encode("tampered\n"));
    editRecord(repo, "sources/src-catalog-requirement.json", (value) => {
      value.sha256 = "0".repeat(64);
    });
    const broken = indexOf(repo);
    const plan = planArtifact(
      { ...request, dependsOn: ["REQDOC-001"], sourceIds: ["src-catalog-requirement"] },
      config,
      broken,
    );
    assert.deepEqual(codes(plan).sort(), ["REGISTER_DEPENDENCY_UNVERIFIED", "REGISTER_SOURCE_UNVERIFIED"]);
  });

  test("the application's template selection wins, and an unresolved one is refused", () => {
    const selected: RegistrationConfig = {
      ...config,
      templates: [
        ...config.templates,
        { id: "acme.engineering", version: "2.0.0", artifactType: "engineering-design" },
      ],
      templateSelections: { "engineering-design": "acme.engineering" },
    };
    const plan = planArtifact(request, selected, index);
    assert.equal(decode(plan, path).template_id, "acme.engineering");
    assert.equal(decode(plan, path).template_version, "2.0.0");
    const broken: RegistrationConfig = { ...config, templateSelections: { "engineering-design": "acme.missing" } };
    assert.deepEqual(codes(planArtifact(request, broken, index)), ["REGISTER_TEMPLATE_UNRESOLVED"]);
  });
});

describe("artifact register: project scope", () => {
  const request: ArtifactRequest = {
    id: "SHARED-010",
    type: "contract",
    title: "Shared error format",
    scope: { kind: "project" },
    content: { path: "shared/content/errors.md", sha256: DIGEST },
    ownerRole: "architecture",
  };

  test("registers at the shared path without a change or workflow step", () => {
    const plan = planArtifact(request, config, index);
    assert.deepEqual(plan.diagnostics, []);
    assert.deepEqual(
      plan.files.map((file) => file.path),
      ["shared/artifacts/SHARED-010.json"],
    );
    const record = decode(plan, "shared/artifacts/SHARED-010.json");
    assert.equal(record.scope, "project");
    assert.equal("change_id" in record, false);
    assert.equal("workflow_step" in record, false);
    assert.equal(validateAgainstSchema("artifact", record).valid, true);
  });

  test("may depend on other project artifacts and sources", () => {
    const plan = planArtifact(
      { ...request, dependsOn: ["SHARED-STATUS-001"], sourceIds: ["src-catalog-requirement"] },
      config,
      index,
    );
    assert.deepEqual(plan.diagnostics, []);
  });

  test("refuses change artifacts as dependencies, covered changes and a missing owner role", () => {
    assert.deepEqual(codes(planArtifact({ ...request, dependsOn: ["DESIGN-001"] }, config, index)), [
      "REGISTER_PROJECT_DEPENDS_ON_CHANGE",
    ]);
    assert.deepEqual(codes(planArtifact({ ...request, coveredChangeIds: ["CHANGE-001"] }, config, index)), [
      "REGISTER_COVERED_CHANGES_NEED_CHANGE_SCOPE",
    ]);
    const { ownerRole: _omitted, ...without } = request;
    assert.deepEqual(codes(planArtifact(without, config, index)), ["REGISTER_OWNER_ROLE_REQUIRED"]);
  });

  test("content must be under shared/content/", () => {
    for (const path of ["changes/CHANGE-001/content/x.md", "shared/x.md", "shared/artifacts/x.md"]) {
      const plan = planArtifact({ ...request, content: { path, sha256: DIGEST } }, config, index);
      assert.deepEqual(codes(plan), ["REGISTER_CONTENT_OUTSIDE_SCOPE"], path);
    }
  });
});
