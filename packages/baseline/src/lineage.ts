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
 * Timestamps and ID order never break ties. Every traversal is iterative, so long chains are safe.
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
  /** The same diagnostics, grouped by the change of the baseline they are about. */
  byChange: ReadonlyMap<string, readonly Diagnostic[]>;
}

/** Predecessors in the same application and change, excluding the baseline itself. */
function edges(baseline: LineageBaseline, byId: ReadonlyMap<string, LineageBaseline>): string[] {
  return (baseline.supersedes ?? []).filter((id) => {
    const target = byId.get(id);
    return (
      id !== baseline.id &&
      target !== undefined &&
      target.change_id === baseline.change_id &&
      target.application_id === baseline.application_id
    );
  });
}

/** Groups of baselines that supersede each other in a cycle (Tarjan's algorithm, iterative). */
function cycles(byId: ReadonlyMap<string, LineageBaseline>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;
  const enter = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter++;
    stack.push(id);
    onStack.add(id);
  };
  for (const start of [...byId.keys()].sort(compareCodePoints)) {
    if (index.has(start)) continue;
    enter(start);
    const work: { id: string; targets: string[]; next: number }[] = [
      { id: start, targets: edges(byId.get(start) as LineageBaseline, byId), next: 0 },
    ];
    while (work.length > 0) {
      const frame = work[work.length - 1] as (typeof work)[number];
      if (frame.next < frame.targets.length) {
        const target = frame.targets[frame.next++] as string;
        if (!index.has(target)) {
          enter(target);
          work.push({ id: target, targets: edges(byId.get(target) as LineageBaseline, byId), next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(target) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      if (low.get(frame.id) !== index.get(frame.id)) continue;
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        group.push(member);
      } while (member !== frame.id);
      if (group.length > 1) groups.push(group.sort(compareCodePoints));
    }
  }
  return groups;
}

/** Checks every `supersedes` reference and looks for cycles. */
export function analyzeLineage(baselines: readonly LineageBaseline[]): LineageReport {
  const byChange = new Map<string, Diagnostic[]>();
  const byId = new Map(baselines.map((baseline) => [baseline.id, baseline]));
  const add = (changeId: string, entry: Diagnostic): void => {
    byChange.set(changeId, [...(byChange.get(changeId) ?? []), entry]);
  };
  const fail = (baseline: LineageBaseline, code: string, message: string, index: number, remediation: string): void => {
    add(
      baseline.change_id,
      diagnostic(code, "error", message, { path: pointerPath(baseline.path, `/supersedes/${index}`), remediation }),
    );
  };

  for (const baseline of baselines) {
    for (const [index, predecessorId] of (baseline.supersedes ?? []).entries()) {
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
    }
  }

  for (const group of cycles(byId)) {
    const first = byId.get(group[0] as string) as LineageBaseline;
    add(
      first.change_id,
      diagnostic("LINEAGE_CYCLE", "error", `baselines supersede each other in a cycle: ${group.join(", ")}`, {
        path: first.path,
        evidence: group,
        remediation: "Lineage must be acyclic. Publish a new reconciliation baseline instead of editing old ones.",
      }),
    );
  }

  const sorted = new Map([...byChange].map(([change, entries]) => [change, sortDiagnostics(entries)]));
  return {
    diagnostics: sortDiagnostics([...byChange.values()].flat()),
    invalidChanges: [...byChange.keys()].sort(compareCodePoints),
    byChange: sorted,
  };
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
  const problems = lineage.byChange.get(changeId);
  if (problems) return { state: "invalid", diagnostics: [...problems] };

  const ofChange = baselines.filter((baseline) => baseline.change_id === changeId);
  const byId = new Map(ofChange.map((baseline) => [baseline.id, baseline]));
  const eligible = ofChange.map((baseline) => baseline.id).filter((id) => isEligible(id));

  // Everything an eligible baseline supersedes, directly or through intermediate baselines.
  const replaced = new Set<string>();
  for (const id of eligible) {
    if (replaced.has(id)) continue;
    const queue = edges(byId.get(id) as LineageBaseline, byId);
    while (queue.length > 0) {
      const earlier = queue.pop() as string;
      if (replaced.has(earlier)) continue;
      replaced.add(earlier);
      queue.push(...edges(byId.get(earlier) as LineageBaseline, byId));
    }
  }
  const tips = eligible.filter((id) => !replaced.has(id)).sort(compareCodePoints);

  if (tips.length === 0) return { state: "none" };
  if (tips.length === 1) return { state: "current", baselineId: tips[0] as string };
  return { state: "conflict", tips };
}
