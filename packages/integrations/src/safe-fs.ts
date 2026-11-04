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
 * - refuses to overwrite unless the caller supplies the expected SHA-256 of the current bytes.
 *
 * The expected-digest check and the final rename are separate steps, so this guards against
 * stale writes, not against two writers racing in the same instant.
 */

import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { caseFoldKey, normalizeRelativePath, sha256Hex } from "@design-loom/config";

export type SafeFsErrorCode =
  | "outside-root"
  | "symlink-target"
  | "case-collision"
  | "exists"
  | "not-found"
  | "digest-mismatch"
  | "not-a-file";

export class SafeFsError extends Error {
  override name = "SafeFsError";
  readonly code: SafeFsErrorCode;
  constructor(code: SafeFsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WriteOptions {
  /**
   * SHA-256 of the bytes the caller expects to replace. Omit to create a new file only.
   * A write with an expected digest fails if the file is missing or its bytes differ.
   */
  expectedSha256?: string;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
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

  /** Writes bytes atomically. See WriteOptions for the overwrite rules. */
  async writeAtomic(relativePath: string, bytes: Uint8Array, options: WriteOptions = {}): Promise<void> {
    const normalized = normalizeRelativePath(relativePath);
    const target = this.resolve(normalized);
    const parent = await this.ensureDirectory(dirname(target), normalized);
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

    const temp = join(parent, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const handle = await open(temp, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (options.expectedSha256 === undefined) {
        // link() fails if the target appeared in the meantime, so a new file never replaces another.
        try {
          await link(temp, target);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new SafeFsError("exists", `${normalized} already exists`);
          if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
          // File systems without hard links: re-check, then rename. This leaves a tiny race window.
          if ((await this.lstatOrUndefined(target)) !== undefined) {
            throw new SafeFsError("exists", `${normalized} already exists`);
          }
          await rename(temp, target);
        }
      } else {
        await rename(temp, target);
      }
    } finally {
      await rm(temp, { force: true });
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
      const stat = await this.lstatOrUndefined(current);
      if (stat === undefined) {
        await mkdir(current);
        continue;
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
