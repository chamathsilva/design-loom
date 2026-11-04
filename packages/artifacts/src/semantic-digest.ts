/**
 * artifact-semantic-v1: one digest for an artifact's meaning (design doc 03, "Artifact semantic digest").
 *
 * Used by context references, review findings and impact comparison. It covers what the artifact
 * says and claims (content and attachment hashes, dependencies, requirements, sources, coverage,
 * applicability, payload, extensions) and ignores lifecycle and presentation fields such as state,
 * title, context receipts, workflow step, owner role, template versions and the content file path.
 *
 * Callers must verify the content and attachment byte hashes before trusting this digest.
 */

import { canonicalDigest, compareCodePoints, type JsonValue } from "@design-loom/config";

export const ARTIFACT_SEMANTIC_CONTRACT = "artifact-semantic-v1";

/** The artifact sidecar fields this contract reads. Other fields are ignored on purpose. */
export interface ArtifactSemanticInput {
  application_id: string;
  id: string;
  type: string;
  scope?: "change" | "project";
  change_id?: string;
  content: { sha256: string };
  attachments: ReadonlyArray<{ path: string; sha256: string }>;
  depends_on: readonly string[];
  requirement_ids: readonly string[];
  source_ids: readonly string[];
  covered_change_ids?: readonly string[];
  applicability: string;
  applicability_reason?: string;
  payload?: { [key: string]: JsonValue };
  extensions?: { [key: string]: JsonValue };
}

export interface ArtifactSemanticProjection {
  [key: string]: JsonValue;
  digest_contract: typeof ARTIFACT_SEMANTIC_CONTRACT;
  application_id: string;
  id: string;
  type: string;
  scope: "change" | "project";
  change_id: string | null;
  content_sha256: string;
  attachments: Array<{ path: string; sha256: string }>;
  depends_on: string[];
  requirement_ids: string[];
  source_ids: string[];
  covered_change_ids: string[];
  applicability: string;
  applicability_reason: string;
  payload: { [key: string]: JsonValue };
  extensions: { [key: string]: JsonValue };
}

export class ArtifactSemanticError extends Error {
  override name = "ArtifactSemanticError";
}

/** Sorts IDs by Unicode scalar value, rejecting duplicates (the schema requires unique arrays). */
function sortedUnique(ids: readonly string[], field: string, artifactId: string): string[] {
  const sorted = [...ids].sort(compareCodePoints);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      throw new ArtifactSemanticError(`${artifactId}: duplicate ${field} entry ${JSON.stringify(sorted[i])}`);
    }
  }
  return sorted;
}

/** Builds the exact projection that artifact-semantic-v1 hashes. */
export function artifactSemanticProjection(artifact: ArtifactSemanticInput): ArtifactSemanticProjection {
  const scope = artifact.scope ?? "change";
  if (scope === "change" && artifact.change_id === undefined) {
    throw new ArtifactSemanticError(`${artifact.id}: change-scoped artifact has no change_id`);
  }

  const attachments = artifact.attachments
    .map((attachment) => ({ path: attachment.path, sha256: attachment.sha256 }))
    .sort((a, b) => compareCodePoints(a.path, b.path));
  for (let i = 1; i < attachments.length; i++) {
    if (attachments[i]?.path === attachments[i - 1]?.path) {
      throw new ArtifactSemanticError(`${artifact.id}: duplicate attachment path ${attachments[i]?.path}`);
    }
  }

  return {
    digest_contract: ARTIFACT_SEMANTIC_CONTRACT,
    application_id: artifact.application_id,
    id: artifact.id,
    type: artifact.type,
    scope,
    change_id: scope === "change" ? (artifact.change_id ?? null) : null,
    content_sha256: artifact.content.sha256,
    attachments,
    depends_on: sortedUnique(artifact.depends_on, "depends_on", artifact.id),
    requirement_ids: sortedUnique(artifact.requirement_ids, "requirement_ids", artifact.id),
    source_ids: sortedUnique(artifact.source_ids, "source_ids", artifact.id),
    covered_change_ids: sortedUnique(artifact.covered_change_ids ?? [], "covered_change_ids", artifact.id),
    applicability: artifact.applicability,
    applicability_reason: artifact.applicability_reason ?? "",
    payload: artifact.payload ?? {},
    extensions: artifact.extensions ?? {},
  };
}

/** Lower-case hex SHA-256 of the canonical-json-v1 form of the semantic projection. */
export function artifactSemanticDigest(artifact: ArtifactSemanticInput): string {
  return canonicalDigest(artifactSemanticProjection(artifact));
}
