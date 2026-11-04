// Baseline lineage and current selection (backlog B05, acceptance AT-43; design doc 03).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeLineage, type LineageBaseline, selectCurrentBaseline } from "@design-loom/baseline";

const baseline = (
  id: string,
  supersedes?: string[],
  change = "CHANGE-001",
  app = "sample-catalog",
): LineageBaseline => ({
  id,
  application_id: app,
  change_id: change,
  path: `baselines/${id}.json`,
  ...(supersedes ? { supersedes } : {}),
});

const eligible =
  (...ids: string[]) =>
  (id: string): boolean =>
    ids.includes(id);

describe("current baseline selection (AT-43)", () => {
  test("no eligible baseline means no verified baseline", () => {
    assert.deepEqual(selectCurrentBaseline([baseline("B1")], "CHANGE-001", eligible()), { state: "none" });
    assert.deepEqual(selectCurrentBaseline([], "CHANGE-001", eligible()), { state: "none" });
  });

  test("a pending successor preserves the verified current baseline", () => {
    const all = [baseline("B1"), baseline("B2", ["B1"])];
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B1")), { state: "current", baselineId: "B1" });
  });

  test("once verified, the successor becomes current", () => {
    const all = [baseline("B1"), baseline("B2", ["B1"])];
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B1", "B2")), {
      state: "current",
      baselineId: "B2",
    });
  });

  test("competing verified tips block selection", () => {
    const all = [baseline("B1"), baseline("B2", ["B1"]), baseline("B3", ["B1"])];
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B1", "B2", "B3")), {
      state: "conflict",
      tips: ["B2", "B3"],
    });
  });

  test("a verified reconciliation naming both tips selects one current baseline", () => {
    const all = [baseline("B1"), baseline("B2", ["B1"]), baseline("B3", ["B1"]), baseline("B4", ["B2", "B3"])];
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B1", "B2", "B3")), {
      state: "conflict",
      tips: ["B2", "B3"],
    });
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B1", "B2", "B3", "B4")), {
      state: "current",
      baselineId: "B4",
    });
  });

  test("a reconciliation that names only one tip leaves the conflict", () => {
    const all = [baseline("B1"), baseline("B2", ["B1"]), baseline("B3", ["B1"]), baseline("B4", ["B2"])];
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B2", "B3", "B4")), {
      state: "conflict",
      tips: ["B3", "B4"],
    });
  });

  test("supersession is transitive, even through an unverified intermediate", () => {
    const all = [baseline("B1"), baseline("B2", ["B1"]), baseline("B3", ["B2"])];
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B1", "B3")), {
      state: "current",
      baselineId: "B3",
    });
  });

  test("neither IDs nor input order break ties", () => {
    const all = [baseline("Z9"), baseline("A1")];
    const forward = selectCurrentBaseline(all, "CHANGE-001", eligible("Z9", "A1"));
    const reversed = selectCurrentBaseline(all.toReversed(), "CHANGE-001", eligible("Z9", "A1"));
    assert.deepEqual(forward, { state: "conflict", tips: ["A1", "Z9"] });
    assert.deepEqual(reversed, forward);
  });

  test("other changes' baselines don't take part", () => {
    const all = [baseline("B1"), baseline("C1", undefined, "CHANGE-002")];
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-001", eligible("B1", "C1")), {
      state: "current",
      baselineId: "B1",
    });
  });
});

describe("lineage checks", () => {
  test("a valid lineage has no diagnostics", () => {
    const report = analyzeLineage([baseline("B1"), baseline("B2", ["B1"])]);
    assert.deepEqual(report.diagnostics, []);
    assert.deepEqual(report.invalidChanges, []);
    assert.equal(report.byChange.size, 0);
  });

  test("a baseline ID used twice is rejected", () => {
    const report = analyzeLineage([baseline("B1"), baseline("B1", undefined, "CHANGE-002")]);
    assert.deepEqual(
      report.diagnostics.map((entry) => entry.code),
      ["LINEAGE_DUPLICATE_ID", "LINEAGE_DUPLICATE_ID"],
    );
    assert.deepEqual(report.invalidChanges, ["CHANGE-001", "CHANGE-002"]);
  });

  test("cycles are rejected and block selection for that change only", () => {
    const all = [baseline("B1", ["B2"]), baseline("B2", ["B1"]), baseline("C1", undefined, "CHANGE-002")];
    const report = analyzeLineage(all);
    assert.deepEqual(
      report.diagnostics.map((entry) => entry.code),
      ["LINEAGE_CYCLE"],
    );
    assert.deepEqual(report.diagnostics[0]?.evidence, ["B1", "B2"]);
    assert.deepEqual(report.invalidChanges, ["CHANGE-001"]);
    assert.equal(selectCurrentBaseline(all, "CHANGE-001", eligible("B1", "B2")).state, "invalid");
    assert.deepEqual(selectCurrentBaseline(all, "CHANGE-002", eligible("C1")), { state: "current", baselineId: "C1" });
  });

  test("a longer cycle is reported once", () => {
    const report = analyzeLineage([baseline("B1", ["B3"]), baseline("B2", ["B1"]), baseline("B3", ["B2"])]);
    assert.equal(report.diagnostics.length, 1);
    assert.deepEqual(report.diagnostics[0]?.evidence, ["B1", "B2", "B3"]);
  });

  test("one change's problems never appear in another change's result, even with similar paths", () => {
    const a = { ...baseline("X", ["X"]), path: "baselines/X.json" };
    const b = { ...baseline("X.json", ["X.json"], "CHANGE-002"), path: "baselines/X.json.json" };
    const forA = selectCurrentBaseline([a, b], "CHANGE-001", eligible());
    assert.equal(forA.state, "invalid");
    assert.deepEqual(forA.state === "invalid" ? forA.diagnostics.map((entry) => entry.path) : [], [
      "baselines/X.json#/supersedes/0",
    ]);
  });

  test("long lineages don't overflow the stack", () => {
    const chain = Array.from({ length: 20000 }, (_, i) => baseline(`B${i}`, i === 0 ? undefined : [`B${i - 1}`]));
    const all = chain.map((entry) => entry.id);
    assert.deepEqual(selectCurrentBaseline(chain, "CHANGE-001", eligible(...all)), {
      state: "current",
      baselineId: "B19999",
    });
    const loop = chain.map((entry, i) => (i === 0 ? { ...entry, supersedes: ["B19999"] } : entry));
    const report = analyzeLineage(loop);
    assert.deepEqual(
      report.diagnostics.map((entry) => entry.code),
      ["LINEAGE_CYCLE"],
    );
    assert.equal(report.diagnostics[0]?.evidence.length, 20000);
  });

  const invalid: [string, LineageBaseline[], string][] = [
    ["a self reference", [baseline("B1", ["B1"])], "LINEAGE_SELF_REFERENCE"],
    ["an unknown predecessor", [baseline("B2", ["B1"])], "LINEAGE_UNKNOWN_PREDECESSOR"],
    [
      "a predecessor from another change",
      [baseline("C1", undefined, "CHANGE-002"), baseline("B2", ["C1"])],
      "LINEAGE_SCOPE_MISMATCH",
    ],
    [
      "a predecessor from another application",
      [baseline("B1", undefined, "CHANGE-001", "other-app"), baseline("B2", ["B1"])],
      "LINEAGE_SCOPE_MISMATCH",
    ],
  ];
  for (const [name, all, code] of invalid) {
    test(`rejects ${name}`, () => {
      const report = analyzeLineage(all);
      assert.deepEqual(
        report.diagnostics.map((entry) => entry.code),
        [code],
      );
      assert.equal(report.diagnostics[0]?.path, "baselines/" + (all.at(-1)?.id ?? "") + ".json#/supersedes/0");
      assert.deepEqual(report.invalidChanges, ["CHANGE-001"]);
    });
  }
});
