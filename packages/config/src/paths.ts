/**
 * Repository-relative path policy (design doc 03, "Limits and paths"; backlog B03).
 *
 * Every path Design Loom stores or writes is relative to a root, uses "/" separators and is
 * portable across Windows, macOS and Linux. This module is pure: it validates strings only.
 * Symlink containment needs the file system and lives in @design-loom/integrations.
 */

export class PathPolicyError extends Error {
  override name = "PathPolicyError";
}

/** Device names Windows reserves in any directory, with or without an extension. */
// Windows also maps "CON .txt" (spaces before the extension) to the device.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\..*)?$/i;

/** Longest file or folder name most file systems accept, in UTF-8 bytes. */
export const MAX_SEGMENT_BYTES = 255;

/** Characters that are invalid in Windows file names; ":" also blocks drive letters and NTFS streams. */
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;

export interface NormalizeOptions {
  /** Accept a trailing "/" that marks a directory prefix, such as "src/" in a task's allowed paths. */
  allowDirectoryPrefix?: boolean;
}

/**
 * Validates a relative path and returns its normalized form with "/" separators.
 * Throws PathPolicyError for anything absolute, escaping, ambiguous or not portable.
 */
export function normalizeRelativePath(input: string, options: NormalizeOptions = {}): string {
  const fail = (reason: string): never => {
    throw new PathPolicyError(`${JSON.stringify(input)}: ${reason}`);
  };

  if (input.length === 0) fail("path is empty");
  if (input.includes("\0")) fail("path contains a NUL character");
  if (!input.isWellFormed()) fail("path contains an unpaired surrogate");

  let path = input.replaceAll("\\", "/");
  if (path.startsWith("/")) fail("absolute, root-relative or UNC paths are not allowed");
  if (/^[A-Za-z]:/.test(path)) fail("drive-letter paths are not allowed");

  const isDirectory = path.endsWith("/");
  if (isDirectory) {
    if (!options.allowDirectoryPrefix) fail("trailing separator is not allowed here");
    path = path.slice(0, -1);
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") fail("empty path segment");
    if (segment === "." || segment === "..") fail(`"${segment}" segments are not allowed`);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\u0001-\u001f\u007f]/.test(segment)) fail("path contains a control character");
    if (WINDOWS_INVALID_CHARS.test(segment)) fail(`segment "${segment}" contains a character invalid on Windows`);
    if (/[. ]$/.test(segment)) fail(`segment "${segment}" ends with a dot or space, which Windows drops`);
    if (WINDOWS_RESERVED.test(segment)) fail(`segment "${segment}" is a reserved Windows device name`);
    if (new TextEncoder().encode(segment).length > MAX_SEGMENT_BYTES) {
      fail(`segment is longer than ${MAX_SEGMENT_BYTES} bytes`);
    }
  }

  return isDirectory ? `${segments.join("/")}/` : segments.join("/");
}

/** True when the path passes normalizeRelativePath with the given options. */
export function isSafeRelativePath(input: string, options: NormalizeOptions = {}): boolean {
  try {
    normalizeRelativePath(input, options);
    return true;
  } catch (error) {
    if (error instanceof PathPolicyError) return false;
    throw error;
  }
}

/**
 * Key under which two paths collide on a case-insensitive or normalization-insensitive file
 * system (Windows, default macOS). Approximates Unicode case folding: upper- then lower-casing
 * maps "ß" and "SS" together, and NFC makes composed and decomposed accents equal.
 */
export function caseFoldKey(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/**
 * Groups of distinct paths or folder prefixes that would collide on some supported platform.
 * Checks every folder level, so "Docs/a.md" and "docs/b.md" collide on "Docs" vs "docs".
 */
export function findCaseFoldCollisions(paths: Iterable<string>): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const path of paths) {
    const segments = path.replace(/\/$/, "").split("/");
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      const key = caseFoldKey(prefix);
      const group = groups.get(key) ?? new Set<string>();
      group.add(prefix);
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter((group) => group.size > 1).map((group) => [...group].sort());
}
