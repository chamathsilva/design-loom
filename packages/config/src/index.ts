/**
 * @design-loom/config: Application profile, framework lock and effective-configuration resolution.
 * Pure logic. Backlog B04.
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
  caseFoldKey,
  findCaseFoldCollisions,
  isSafeRelativePath,
  MAX_SEGMENT_BYTES,
  type NormalizeOptions,
  normalizeRelativePath,
  PathPolicyError,
} from "./paths.ts";

export const PACKAGE_NAME = "@design-loom/config";
