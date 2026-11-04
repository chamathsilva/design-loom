/**
 * @design-loom/artifacts: Artifact and source records, project/change scope, digests and the reference graph index.
 * Pure logic over supplied bytes. Backlog B05.
 *
 * artifact-semantic-v1 (backlog B03) lives here because it is defined over artifact records.
 */

export {
  ARTIFACT_SEMANTIC_CONTRACT,
  ArtifactSemanticError,
  type ArtifactSemanticInput,
  type ArtifactSemanticProjection,
  artifactSemanticDigest,
  artifactSemanticProjection,
} from "./semantic-digest.ts";

export const PACKAGE_NAME = "@design-loom/artifacts";
