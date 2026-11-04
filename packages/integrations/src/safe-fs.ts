/**
 * Safe file-system adapter (design docs 03 and 07; backlog B03).
 *
 * All paths are relative to one root and pass the pure path policy in @design-loom/config.
 * On top of that, this adapter:
 * - refuses to read or write through symlinks that resolve outside the root;
 * - never writes through a symlink at the target itself;
 * - refuses case-fold collisions with existing entries;
 * - writes atomically through a temporary sibling, then a hard link (new files) or rename
 *   (replacements), so readers never see a partial file;
 * - publishes through the validated real folder, not the caller's path, and re-checks that folder
 *   just before and after publishing;
 * - refuses to overwrite unless the caller supplies the expected SHA-256 of the current bytes;
 * - serializes writes to the same file within this process, so two callers that expect the same
 *   digest can't both succeed.
 *
 * Limits: Node has no openat/renameat, so another process that swaps a folder for a symlink in the
 * instant between the re-check and the publish can still redirect a write. The same goes for two
 * processes writing one file at once. Design doc 04 puts concurrent editing in separate worktrees
 * or checkouts; this adapter detects stale writes, it doesn't arbitrate between processes.
 */

import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { caseFoldKey, compareCodePoints, normalizeRelativePath, sha256Hex } from "@design-loom/config";

export type SafeFsErrorCode =
  | "outside-root"
  | "symlink-target"
  | "case-collision"
  | "exists"
  | "not-found"
  | "digest-mismatch"
  | "invalid-digest"
  | "not-a-file"
  | "unsupported";

export class SafeFsError extends Error {
  override name = "SafeFsError";
  readonly code: SafeFsErrorCode;
  constructor(code: SafeFsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** One folder entry. Symlinks are reported as such and never followed by a listing. */
export interface DirectoryEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface WriteOptions {
  /**
   * SHA-256 of the bytes the caller expects to replace. Omit to create a new file only.
   * A write with an expected digest fails if the file is missing or its bytes differ.
   */
  expectedSha256?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** ENOENT, or ENOTDIR when a path runs through a regular file (`file.txt/x`). */
function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Writes to one file, keyed by its case-folded real path, run one at a time in this process. */
const writeQueue = new Map<string, Promise<void>>();

async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = writeQueue.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  writeQueue.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (writeQueue.get(key) === tail) writeQueue.delete(key);
  }
}

/** Flushes a folder entry (a new or renamed file) to disk. Windows can't open folders, so skip it there. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

export class SafeFileSystem {
  /** Real path of the root directory, with symlinks resolved. */
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Opens a root directory. The stored root is its real path, with symlinks resolved. */
  static async open(root: string): Promise<SafeFileSystem> {
    if (!isAbsolute(root)) throw new SafeFsError("outside-root", `root must be absolute: ${root}`);
    const real = await realpath(root);
    if (!(await lstat(real)).isDirectory()) throw new SafeFsError("not-a-file", `root is not a directory: ${root}`);
    return new SafeFileSystem(real);
  }

  /** Absolute path for a validated relative path. Does not touch the file system. */
  resolve(relativePath: string): string {
    return join(this.root, ...normalizeRelativePath(relativePath).split("/"));
  }

  /**
   * Reads a file's bytes, refusing symlinks that lead outside the root. The path must match the
   * on-disk name exactly, so a read that works on a case-insensitive disk also works on Linux.
   */
  async readBytes(relativePath: string): Promise<Uint8Array> {
    const target = this.resolve(relativePath);
    await this.assertExactNames(normalizeRelativePath(relativePath), relativePath);
    let real: string;
    try {
      real = await realpath(target);
    } catch (error) {
      if (isNotFound(error)) throw new SafeFsError("not-found", `${relativePath} does not exist`);
      throw error;
    }
    if (!isInside(this.root, real)) {
      throw new SafeFsError("outside-root", `${relativePath} resolves outside the root`);
    }
    if (!(await lstat(real)).isFile()) throw new SafeFsError("not-a-file", `${relativePath} is not a file`);
    return new Uint8Array(await readFile(real));
  }

  /**
   * Lists a folder ("" for the root), sorted by name in code-point order. The folder must resolve
   * inside the root and match its on-disk name exactly; entries are not followed.
   */
  async listDirectory(relativePath: string): Promise<DirectoryEntry[]> {
    const normalized = relativePath === "" ? "" : normalizeRelativePath(relativePath);
    if (normalized !== "") await this.assertExactNames(normalized, relativePath);
    const target = normalized === "" ? this.root : this.resolve(normalized);
    let real: string;
    try {
      real = await realpath(target);
    } catch (error) {
      if (isNotFound(error)) throw new SafeFsError("not-found", `${relativePath} does not exist`);
      throw error;
    }
    if (!isInside(this.root, real)) throw new SafeFsError("outside-root", `${relativePath} resolves outside the root`);
    if (!(await lstat(real)).isDirectory()) throw new SafeFsError("not-a-file", `${relativePath} is not a folder`);
    const entries = await readdir(real, { withFileTypes: true });
    return entries
      .map(
        (entry): DirectoryEntry => ({
          name: entry.name,
          kind: entry.isFile()
            ? "file"
            : entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
        }),
      )
      .sort((a, b) => compareCodePoints(a.name, b.name));
  }

  /** Writes bytes atomically. See WriteOptions for the overwrite rules. */
  async writeAtomic(relativePath: string, bytes: Uint8Array, options: WriteOptions = {}): Promise<void> {
    if (options.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.expectedSha256)) {
      throw new SafeFsError("invalid-digest", "expectedSha256 must be 64 lower-case hex characters");
    }
    const normalized = normalizeRelativePath(relativePath);
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    const parent = await this.ensureDirectory(dirname(this.resolve(normalized)), normalized);
    // From here on, use the validated real folder, so an alias folder can't redirect the write.
    const target = join(parent, name);
    await serialized(caseFoldKey(target), () => this.publish(parent, target, normalized, bytes, options));
  }

  private async publish(
    parent: string,
    target: string,
    normalized: string,
    bytes: Uint8Array,
    options: WriteOptions,
  ): Promise<void> {
    await this.assertNoCaseCollision(parent, basename(target), normalized);
    const current = await this.lstatOrUndefined(target);
    if (current?.isSymbolicLink()) {
      throw new SafeFsError("symlink-target", `${normalized} is a symlink; refusing to write through it`);
    }
    if (current !== undefined && !current.isFile()) {
      throw new SafeFsError("not-a-file", `${normalized} exists and is not a file`);
    }
    if (options.expectedSha256 === undefined) {
      if (current !== undefined) throw new SafeFsError("exists", `${normalized} already exists`);
    } else {
      if (current === undefined) throw new SafeFsError("not-found", `${normalized} does not exist`);
      const actual = sha256Hex(new Uint8Array(await readFile(target)));
      if (actual !== options.expectedSha256) {
        throw new SafeFsError(
          "digest-mismatch",
          `${normalized} changed: expected ${options.expectedSha256}, found ${actual}`,
        );
      }
    }

    // Fixed-length name, so a target near the 255-byte name limit still gets a valid temp file.
    const temp = join(parent, `.dl-${randomBytes(12).toString("hex")}.tmp`);
    try {
      const handle = await open(temp, "wx");
      try {
        await handle.writeFile(bytes);
        // A replacement keeps the old file's permissions (for example an executable bit).
        if (current !== undefined) await handle.chmod(current.mode & 0o7777);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertFolderUnchanged(parent, normalized);
      if (options.expectedSha256 === undefined) {
        // link() fails if the target appeared in the meantime, so a new file never replaces another.
        try {
          await link(temp, target);
        } catch (error) {
          const code = errorCode(error);
          if (code === "EEXIST") throw new SafeFsError("exists", `${normalized} already exists`);
          if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
            // Without hard links there is no create-only atomic publish; refuse rather than risk
            // overwriting a file another process created in the meantime.
            throw new SafeFsError(
              "unsupported",
              `${normalized}: this file system has no hard links, so new files can't be created safely`,
            );
          }
          throw error;
        }
      } else {
        await rename(temp, target);
      }
      await syncDirectory(parent);
      await this.assertFolderUnchanged(parent, normalized);
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Fails if a validated folder no longer resolves to itself (it was replaced by a symlink). */
  private async assertFolderUnchanged(folder: string, forPath: string): Promise<void> {
    if ((await realpath(folder)) !== folder) {
      throw new SafeFsError("outside-root", `${forPath}: its folder changed during the write`);
    }
  }

  /** Creates missing directories one level at a time, refusing any that resolve outside the root. */
  private async ensureDirectory(directory: string, forPath: string): Promise<string> {
    const rel = relative(this.root, directory);
    let current = this.root;
    for (const segment of rel === "" ? [] : rel.split(sep)) {
      // Check before stat: on a case-insensitive disk, "Docs" would silently resolve to "docs".
      await this.assertNoCaseCollision(current, segment, forPath);
      current = join(current, segment);
      if ((await this.lstatOrUndefined(current)) === undefined) {
        try {
          await mkdir(current);
          continue;
        } catch (error) {
          // Another process created it in the meantime: check it like any existing folder.
          if (errorCode(error) !== "EEXIST") throw error;
        }
      }
      const real = await realpath(current);
      if (!isInside(this.root, real)) {
        throw new SafeFsError("outside-root", `${forPath}: folder "${segment}" resolves outside the root`);
      }
      if (!(await lstat(real)).isDirectory()) {
        throw new SafeFsError("not-a-file", `${forPath}: "${segment}" is not a folder`);
      }
    }
    const real = await realpath(directory);
    if (!isInside(this.root, real)) throw new SafeFsError("outside-root", `${forPath} resolves outside the root`);
    return real;
  }

  /** Requires every segment of an existing path to match the on-disk entry name exactly. */
  private async assertExactNames(normalized: string, original: string): Promise<void> {
    let directory = this.root;
    for (const segment of normalized.split("/")) {
      let entries: string[];
      try {
        // Check containment before listing, so a symlinked folder can't reveal outside names.
        if (!isInside(this.root, await realpath(directory))) {
          throw new SafeFsError("outside-root", `${original} resolves outside the root`);
        }
        entries = await readdir(directory);
      } catch (error) {
        if (isNotFound(error)) throw new SafeFsError("not-found", `${original} does not exist`);
        throw error;
      }
      if (!entries.includes(segment)) {
        const near = entries.find((entry) => caseFoldKey(entry) === caseFoldKey(segment));
        if (near !== undefined) {
          throw new SafeFsError("case-collision", `${original}: "${segment}" differs from on-disk "${near}"`);
        }
        throw new SafeFsError("not-found", `${original} does not exist`);
      }
      directory = join(directory, segment);
    }
  }

  /** Refuses a name that differs from an existing entry only by case or Unicode normalization. */
  private async assertNoCaseCollision(directory: string, name: string, forPath: string): Promise<void> {
    const key = caseFoldKey(name);
    for (const entry of await readdir(directory)) {
      if (entry !== name && caseFoldKey(entry) === key) {
        throw new SafeFsError("case-collision", `${forPath}: "${name}" collides with existing "${entry}"`);
      }
    }
  }

  private async lstatOrUndefined(path: string) {
    try {
      return await lstat(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
}
