/**
 * Baseline lineage and current selection (backlog B05, acceptance AT-43; design doc 03
 * "Optional baseline lineage and current selection", doc 16 semantic rules).
 *
 * A baseline may name the baselines it replaces in `supersedes`. References are immutable; there
 * is no shared "current baseline" pointer. Instead the current baseline is derived:
 *
 * - Only eligible baselines count. Eligibility (merged and verified) comes from the approval adapter
 *   (B12–B13); pending, rejected and unverified proposals never replace a verified current baseline.
 * - An eligible baseline is a tip when no other eligible baseline supersedes it, directly or
 *   through intermediate baselines.
 * - One tip is current. No tips means no verified baseline. Several tips conflict and block
 *   automatic selection until a reviewed reconciliation names all of them in `supersedes`.
 *
 * Timestamps and ID order never break ties.
 */

import { compareCodePoints, type Diagnostic, diagnostic, pointerPath, sortDiagnostics } from "@design-loom/config";

export interface LineageBaseline {
  id: string;
  application_id: string;
  change_id: string;
  supersedes?: readonly string[];
  /** Where the record is stored, for diagnostics. */
  path: string;
}

export interface LineageReport {
  /** Unknown predecessors, cross-application or cross-change references, self references and cycles. */
  diagnostics: Diagnostic[];
  /** Changes whose lineage is broken; current selection is refused for them. */
  invalidChanges: string[];
}

/** Checks every `supersedes` reference and looks for cycles. */
export function analyzeLineage(baselines: readonly LineageBaseline[]): LineageReport {
  const diagnostics: Diagnostic[] = [];
  const invalid = new Set<string>();
  const byId = new Map(baselines.map((baseline) => [baseline.id, baseline]));
  const fail = (baseline: LineageBaseline, code: string, message: string, index: number, remediation: string): void => {
    invalid.add(baseline.change_id);
    diagnostics.push(
      diagnostic(code, "error", message, { path: pointerPath(baseline.path, `/supersedes/${index}`), remediation }),
    );
  };

  for (const baseline of baselines) {
    (baseline.supersedes ?? []).forEach((predecessorId, index) => {
      const predecessor = byId.get(predecessorId);
      if (predecessorId === baseline.id) {
        fail(
          baseline,
          "LINEAGE_SELF_REFERENCE",
          `baseline ${baseline.id} supersedes itself`,
          index,
          "Remove the entry.",
        );
      } else if (!predecessor) {
        fail(
          baseline,
          "LINEAGE_UNKNOWN_PREDECESSOR",
          `baseline ${baseline.id} supersedes unknown baseline ${predecessorId}`,
          index,
          "Name existing baselines only. Baseline files are never deleted.",
        );
      } else if (
        predecessor.application_id !== baseline.application_id ||
        predecessor.change_id !== baseline.change_id
      ) {
        fail(
          baseline,
          "LINEAGE_SCOPE_MISMATCH",
          `baseline ${baseline.id} supersedes ${predecessorId} from another change or application`,
          index,
          "A baseline replaces baselines of its own change only.",
        );
      }
    });
  }

  // Cycles: depth-first search over supersedes edges between known baselines of the same change.
  const state = new Map<string, "visiting" | "done">();
  const reported = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycle = trail.slice(trail.indexOf(id));
      const key = [...cycle].sort(compareCodePoints).join(" ");
      const first = byId.get([...cycle].sort(compareCodePoints)[0] as string);
      if (!reported.has(key) && first) {
        reported.add(key);
        invalid.add(first.change_id);
        diagnostics.push(
          diagnostic(
            "LINEAGE_CYCLE",
            "error",
            `baselines supersede each other in a cycle: ${[...cycle, id].join(" → ")}`,
            {
              path: first.path,
              evidence: cycle,
              remediation:
                "Lineage must be acyclic. Publish a new reconciliation baseline instead of editing old ones.",
            },
          ),
        );
      }
      return;
    }
    state.set(id, "visiting");
    const baseline = byId.get(id);
    for (const next of [...(baseline?.supersedes ?? [])].sort(compareCodePoints)) {
      const target = byId.get(next);
      // Self references are reported above; skip them so they aren't reported again as cycles.
      if (next === id) continue;
      if (target && target.change_id === baseline?.change_id && target.application_id === baseline.application_id) {
        visit(next, [...trail, id]);
      }
    }
    state.set(id, "done");
  };
  for (const id of [...byId.keys()].sort(compareCodePoints)) visit(id, []);

  return { diagnostics: sortDiagnostics(diagnostics), invalidChanges: [...invalid].sort(compareCodePoints) };
}

export type CurrentSelection =
  | { state: "none" }
  | { state: "current"; baselineId: string }
  | { state: "conflict"; tips: string[] }
  | { state: "invalid"; diagnostics: Diagnostic[] };

/**
 * The current baseline of a change. `isEligible` says whether a baseline is merged and verified;
 * until the approval adapter exists (B12–B13), callers have no eligible baselines.
 */
export function selectCurrentBaseline(
  baselines: readonly LineageBaseline[],
  changeId: string,
  isEligible: (baselineId: string) => boolean,
): CurrentSelection {
  const lineage = analyzeLineage(baselines);
  if (lineage.invalidChanges.includes(changeId)) {
    return {
      state: "invalid",
      diagnostics: lineage.diagnostics.filter((entry) =>
        baselines.some((baseline) => baseline.change_id === changeId && entry.path.startsWith(baseline.path)),
      ),
    };
  }
  const ofChange = baselines.filter((baseline) => baseline.change_id === changeId);
  const byId = new Map(ofChange.map((baseline) => [baseline.id, baseline]));

  // Everything each baseline supersedes, directly or through intermediate baselines.
  const supersededBy = new Map<string, Set<string>>();
  const reach = (id: string): Set<string> => {
    const cached = supersededBy.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    supersededBy.set(id, result);
    for (const predecessor of byId.get(id)?.supersedes ?? []) {
      if (!byId.has(predecessor)) continue;
      result.add(predecessor);
      for (const earlier of reach(predecessor)) result.add(earlier);
    }
    return result;
  };

  const eligible = ofChange.map((baseline) => baseline.id).filter((id) => isEligible(id));
  const replaced = new Set<string>();
  for (const id of eligible) for (const earlier of reach(id)) replaced.add(earlier);
  const tips = eligible.filter((id) => !replaced.has(id)).sort(compareCodePoints);

  if (tips.length === 0) return { state: "none" };
  if (tips.length === 1) return { state: "current", baselineId: tips[0] as string };
  return { state: "conflict", tips };
}
