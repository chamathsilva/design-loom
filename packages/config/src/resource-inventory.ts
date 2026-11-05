/**
 * resource-inventory-v1: one digest over a set of resource files (the lock's `resources_sha256` and
 * each locked extension's `sha256`; design doc 03, "Lockfile").
 *
 * The design requires these digests but doesn't define them; this definition is recorded in
 * packages/config/resources/core/README.md. Each file contributes its path and the SHA-256 of its raw
 * bytes, so renaming, adding, removing or editing any file changes the digest.
 */

import { CanonicalJsonError, canonicalDigest, compareCodePoints } from "./canonical-json.ts";
import { caseFoldKey, normalizeRelativePath } from "./paths.ts";

export const RESOURCE_INVENTORY_CONTRACT = "resource-inventory-v1";

export interface InventoryFile {
  /** Path relative to the resource root, with "/" separators. */
  path: string;
  /** Lower-case hex SHA-256 of the file's raw bytes. */
  sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Digest of a resource set. Throws CanonicalJsonError for an unsafe path, a duplicate or a bad hash. */
export function resourceInventoryDigest(files: readonly InventoryFile[]): string {
  const seen = new Set<string>();
  const entries = files.map((file) => {
    const path = normalizeRelativePath(file.path);
    if (path !== file.path)
      throw new CanonicalJsonError(`inventory path is not normalized: ${JSON.stringify(file.path)}`);
    if (!SHA256.test(file.sha256))
      throw new CanonicalJsonError(`inventory sha256 is not a lower-case SHA-256: ${path}`);
    const key = caseFoldKey(path);
    if (seen.has(key)) throw new CanonicalJsonError(`inventory lists ${JSON.stringify(path)} twice (ignoring case)`);
    seen.add(key);
    return { path, sha256: file.sha256 };
  });
  entries.sort((a, b) => compareCodePoints(a.path, b.path));
  return canonicalDigest({ digest_contract: RESOURCE_INVENTORY_CONTRACT, files: entries });
}
