/**
 * @design-loom/artifacts: Artifact and source records, project/change scope, digests and the reference graph index.
 * Pure logic over supplied bytes. Backlog B05.
 *
 * artifact-semantic-v1 (backlog B03) lives here because it is defined over artifact records.
 */

export {
  type ClosureFile,
  type Dependent,
  type ReferenceClosure,
  referenceClosure,
  transitiveDependents,
} from "./graph.ts";
export {
  type ArtifactPlan,
  type ArtifactRequest,
  type ArtifactScopeRequest,
  type ChangeRequest,
  type FileDigest,
  type Plan,
  type PlannedFile,
  planArtifact,
  planChange,
  type RegistrationConfig,
  registrationConfigOf,
  serializeRecord,
} from "./registration.ts";
export {
  ARTIFACT_SEMANTIC_CONTRACT,
  ArtifactSemanticError,
  type ArtifactSemanticInput,
  type ArtifactSemanticProjection,
  artifactSemanticDigest,
  artifactSemanticProjection,
} from "./semantic-digest.ts";
export {
  type ArtifactRecord,
  type BaselineRecord,
  buildStoreIndex,
  type ChangeRecord,
  type ContextReference,
  DEFAULT_STORE_LIMITS,
  type FindingsRecord,
  type IndexedArtifact,
  type IndexedChange,
  type IndexedRecord,
  type IndexedSource,
  type IndexedTask,
  referencedFiles,
  type SourceRecord,
  type StoreFile,
  type StoreIndex,
  type StoreInput,
  type StoreLimits,
  type TaskRecord,
  type TraceabilityRecord,
} from "./store-index.ts";
export {
  classifyStorePath,
  isContentFolder,
  ownedFolderFor,
  STORE_SCAN_ROOTS,
  type StoreLocation,
  type StoreRecordKind,
} from "./store-layout.ts";
export const PACKAGE_NAME = "@design-loom/artifacts";
