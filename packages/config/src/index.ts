/**
 * @design-loom/config: Application profile, framework lock and effective-configuration resolution.
 * Pure logic. Backlog B04.
 *
 * Also home to canonical-json-v1 (backlog B03), the hashing contract every other package builds on.
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

export const PACKAGE_NAME = "@design-loom/config";
