/**
 * Graph queries over the store index (backlog B05; design doc 03 "Data model", doc 16
 * "File inventory completeness").
 *
 * - `referenceClosure`: everything a selection of artifacts relies on: the artifacts themselves,
 *   their transitive `depends_on`, the sources they cite, and every file that binds them. Baselines
 *   and handoffs inventory this closure.
 * - `transitiveDependents`: everything derived from an artifact, with one shortest reason path
 *   each, for impact analysis. It follows the declared graph even through artifacts whose content
 *   didn't change.
 */

import { compareCodePoints } from "@design-loom/config";
import type { StoreIndex } from "./store-index.ts";

export interface ClosureFile {
  path: string;
  sha256: string;
}

export interface ReferenceClosure {
  /** Selected artifacts and everything they depend on, in ID order. */
  artifactIds: string[];
  /** Sources any of those artifacts cite, in ID order. */
  sourceIds: string[];
  /** Sidecars, content, attachments, source records and snapshots, in path order. */
  files: ClosureFile[];
  /** Referenced IDs the index doesn't contain, in ID order. A complete closure has none. */
  missing: string[];
  /**
   * Artifacts in the closure whose content or attachments didn't match their recorded hashes, in
   * ID order. Their entries in `files` are the recorded hashes, not what is on disk, so a baseline
   * or handoff must refuse a closure with any.
   */
  unverified: string[];
}

/** The reference closure of the given artifacts. */
export function referenceClosure(index: StoreIndex, artifactIds: Iterable<string>): ReferenceClosure {
  const seen = new Set<string>();
  const sourceIds = new Set<string>();
  const missing = new Set<string>();
  const files = new Map<string, string>();
  const unverified = new Set<string>();
  const queue = [...artifactIds];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const artifact = index.artifacts.get(id);
    if (!artifact) {
      missing.add(id);
      continue;
    }
    if (!artifact.bytesVerified) unverified.add(id);
    files.set(artifact.path, artifact.sha256);
    files.set(artifact.record.content.path, artifact.record.content.sha256);
    for (const attachment of artifact.record.attachments) files.set(attachment.path, attachment.sha256);
    for (const source of artifact.record.source_ids) sourceIds.add(source);
    queue.push(...artifact.record.depends_on);
  }
  for (const id of sourceIds) {
    const source = index.sources.get(id);
    if (!source) {
      missing.add(id);
      continue;
    }
    files.set(source.path, source.sha256);
    const { snapshot_path: snapshot, sha256 } = source.record;
    if (snapshot !== undefined && sha256 !== undefined) files.set(snapshot, sha256);
  }
  return {
    artifactIds: [...seen].filter((id) => index.artifacts.has(id)).sort(compareCodePoints),
    sourceIds: [...sourceIds].filter((id) => index.sources.has(id)).sort(compareCodePoints),
    files: [...files].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => compareCodePoints(a.path, b.path)),
    missing: [...missing].sort(compareCodePoints),
    unverified: [...unverified].sort(compareCodePoints),
  };
}

export interface Dependent {
  id: string;
  /** From the changed artifact to this one, for example ["REQDOC-001", "CONTRACT-001", "DESIGN-001"]. */
  path: string[];
}

/**
 * Every artifact derived, directly or transitively, from any of the given artifacts, in ID order.
 * The given artifacts themselves are left out, even when one depends on another.
 * Each comes with one shortest reason path; ties go to the path that is first in ID order.
 */
export function transitiveDependents(index: StoreIndex, changedIds: Iterable<string>): Dependent[] {
  const starts = [...new Set(changedIds)].sort(compareCodePoints);
  const startSet = new Set(starts);
  const paths = new Map<string, string[]>();
  for (const id of starts) paths.set(id, [id]);
  let frontier = starts;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of index.dependents.get(id) ?? []) {
        if (paths.has(dependent)) continue;
        paths.set(dependent, [...(paths.get(id) as string[]), dependent]);
        next.push(dependent);
      }
    }
    frontier = next.sort(compareCodePoints);
  }
  return [...paths]
    .filter(([id]) => !startSet.has(id))
    .map(([id, path]) => ({ id, path }))
    .sort((a, b) => compareCodePoints(a.id, b.id));
}
