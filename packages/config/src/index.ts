/**
 * @design-loom/config: Application profile, framework lock and effective-configuration resolution.
 * Pure logic: callers read files and pass their parsed values and byte digests. Backlog B04.
 *
 * Also home to the B03 foundations every other package builds on: canonical-json-v1 hashing and
 * the portable relative-path policy.
 */

export {
  CanonicalJsonError,
  canonicalDigest,
  canonicalJson,
  canonicalJsonBytes,
  compareCodePoints,
  type JsonValue,
  parseJson,
  sha256Hex,
} from "./canonical-json.ts";
export {
  type Diagnostic,
  diagnostic,
  hasErrors,
  pointerPath,
  pointerToken,
  type Severity,
  sortDiagnostics,
} from "./diagnostics.ts";
export {
  BUILT_IN_OUTPUT_KINDS,
  checkReleaseManifest,
  EFFECTIVE_CONFIG_SCHEMA_VERSION,
  type EffectiveConfigEnvelope,
  type EffectiveConfiguration,
  type ExtensionInput,
  effectiveConfigDigest,
  extensionDeclaredFiles,
  isTemplateDescriptorPath,
  type JsonObject,
  type LockReport,
  type LockState,
  type ProvenanceEntry,
  type ReleaseInput,
  type ResolveInput,
  type ResolveResult,
  resolveEffectiveConfig,
  type SourceDocument,
  templateContentPath,
} from "./effective-config.ts";
export {
  caseFoldKey,
  findCaseFoldCollisions,
  isSafeRelativePath,
  MAX_SEGMENT_BYTES,
  type NormalizeOptions,
  normalizeRelativePath,
  PathPolicyError,
} from "./paths.ts";

export { type InventoryFile, RESOURCE_INVENTORY_CONTRACT, resourceInventoryDigest } from "./resource-inventory.ts";
export { compareVersions, parseRange, parseVersion, satisfiesRange, type Version } from "./version-range.ts";

export const PACKAGE_NAME = "@design-loom/config";
