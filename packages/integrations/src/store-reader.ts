/**
 * Reads a design repository for the store index (backlog B05; design doc 07, `ArtifactStore.scan`).
 *
 * Lists the record folders (skipping content folders), reads and strictly parses each record, then
 * hashes the content, attachment and snapshot files the records reference. Everything goes through
 * SafeFileSystem, so symlinks can't lead outside the root and names must match on-disk case.
 * Symlinked folders are reported and not followed.
 */

import {
  buildStoreIndex,
  classifyStorePath,
  DEFAULT_STORE_LIMITS,
  isContentFolder,
  referencedFiles,
  STORE_SCAN_ROOTS,
  type StoreFile,
  type StoreIndex,
  type StoreLimits,
} from "@design-loom/artifacts";
import {
  type Diagnostic,
  diagnostic,
  normalizeRelativePath,
  parseJson,
  sha256Hex,
  sortDiagnostics,
} from "@design-loom/config";
import { osErrorCode, type SafeFileSystem, SafeFsError } from "./safe-fs.ts";

export interface StoreScan {
  records: StoreFile[];
  /** SHA-256 of each referenced file, or null when it is missing or can't be read safely. */
  referenced: Map<string, string | null>;
  /** Problems with the folders themselves, such as symlinked folders. */
  diagnostics: Diagnostic[];
}

/** Folders nested deeper than this under a scan root are not listed. */
const MAX_FOLDER_DEPTH = 8;

// ignoreBOM keeps a byte-order mark in the text, so the strict JSON parser rejects it.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A file-system failure to report: a SafeFsError, or an OS error such as EACCES or EIO. OS messages
 * name absolute local paths, so only the error code and the repository-relative path are kept.
 */
function fsProblem(error: unknown, path: string): string | null {
  if (error instanceof SafeFsError) return error.message;
  const code = osErrorCode(error);
  return code === null ? null : `${path || "."} can't be read (${code})`;
}

/** Lists and reads the store. Missing scan roots are fine: a new repository has none. */
export interface ScanOptions {
  /** Record files larger than this are reported by size and not read (default: design doc 03's 1 MB). */
  maxMetadataBytes?: number;
  /** Referenced content larger than this is not read or hashed (default: doc 03's 10 MB source limit). */
  maxReferencedBytes?: number;
}

export const DEFAULT_MAX_REFERENCED_BYTES = 10_485_760;

export async function scanStore(fs: SafeFileSystem, options: ScanOptions = {}): Promise<StoreScan> {
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_STORE_LIMITS.maxMetadataBytes;
  const maxReferencedBytes = options.maxReferencedBytes ?? DEFAULT_MAX_REFERENCED_BYTES;
  const diagnostics: Diagnostic[] = [];
  const records: StoreFile[] = [];
  const warn = (code: string, message: string, path: string, remediation: string): void => {
    diagnostics.push(diagnostic(code, "warning", message, { path, remediation }));
  };

  const walk = async (folder: string, depth: number): Promise<void> => {
    let entries: Awaited<ReturnType<SafeFileSystem["listDirectory"]>>;
    try {
      entries = await fs.listDirectory(folder);
    } catch (error) {
      if (error instanceof SafeFsError && error.code === "not-found") return;
      const problem = fsProblem(error, folder);
      if (problem === null) throw error;
      diagnostics.push(
        diagnostic("STORE_FOLDER_UNREADABLE", "error", problem, {
          path: folder,
          remediation: "Make it a readable, real folder inside the repository.",
        }),
      );
      return;
    }
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      try {
        if (normalizeRelativePath(path) !== path) throw new Error("not normalized");
      } catch {
        warn("STORE_UNSAFE_NAME", "name is not portable and is ignored", path, "Rename it to a portable name.");
        continue;
      }
      if (entry.kind === "directory") {
        if (isContentFolder(path)) continue;
        if (depth >= MAX_FOLDER_DEPTH) {
          warn("STORE_FOLDER_TOO_DEEP", "folder is nested too deeply and is ignored", path, "Flatten the layout.");
          continue;
        }
        await walk(path, depth + 1);
      } else if (entry.kind === "symlink") {
        warn(
          "STORE_SYMLINK_IGNORED",
          "symlinks in record folders are not followed",
          path,
          "Store the record itself in the repository.",
        );
      } else if (entry.kind === "file") {
        records.push(await readRecord(fs, path, maxMetadataBytes));
      } else {
        warn("STORE_UNEXPECTED_FILE", "special file is ignored", path, "Remove it.");
      }
    }
  };

  // Fixed roots such as shared/artifacts: every component must be a real folder, not a symlink,
  // checked the same way as anything found inside them.
  const realFolder = async (root: string): Promise<boolean> => {
    let parent = "";
    for (const segment of root.split("/")) {
      let entries: Awaited<ReturnType<SafeFileSystem["listDirectory"]>>;
      try {
        entries = await fs.listDirectory(parent);
      } catch (error) {
        if (error instanceof SafeFsError && error.code === "not-found") return false;
        const problem = fsProblem(error, parent);
        if (problem === null) throw error;
        diagnostics.push(
          diagnostic("STORE_FOLDER_UNREADABLE", "error", problem, {
            path: parent,
            remediation: "Make it a readable, real folder inside the repository.",
          }),
        );
        return false;
      }
      const path = parent === "" ? segment : `${parent}/${segment}`;
      const entry = entries.find((candidate) => candidate.name === segment);
      if (!entry) return false;
      if (entry.kind !== "directory") {
        warn(
          entry.kind === "symlink" ? "STORE_SYMLINK_IGNORED" : "STORE_UNEXPECTED_FILE",
          entry.kind === "symlink" ? "symlinks in record folders are not followed" : "expected a folder here",
          path,
          "Store records in a real folder inside the repository.",
        );
        return false;
      }
      parent = path;
    }
    return true;
  };
  for (const root of STORE_SCAN_ROOTS) {
    if (await realFolder(root)) await walk(root, 0);
  }

  const referenced = new Map<string, string | null>();
  for (const path of referencedFiles(records)) {
    try {
      const size = await fs.sizeOf(path);
      if (size > maxReferencedBytes) {
        referenced.set(path, null);
        diagnostics.push(
          diagnostic(
            "STORE_REFERENCE_TOO_LARGE",
            "error",
            `${path} is ${size} bytes; the limit is ${maxReferencedBytes}`,
            {
              path,
              remediation: "Keep large binaries as externally versioned references, not artifact content.",
            },
          ),
        );
        continue;
      }
      referenced.set(path, sha256Hex(await fs.readBytes(path)));
    } catch (error) {
      const problem = fsProblem(error, path);
      if (problem === null) throw error;
      referenced.set(path, null);
      if (!(error instanceof SafeFsError && error.code === "not-found")) {
        diagnostics.push(
          diagnostic("STORE_REFERENCE_UNREADABLE", "error", problem, {
            path,
            remediation: "Referenced files must be regular files inside the repository, named with their exact case.",
          }),
        );
      }
    }
  }
  return { records, referenced, diagnostics };
}

async function readRecord(fs: SafeFileSystem, path: string, maxBytes: number): Promise<StoreFile> {
  let bytes: Uint8Array;
  try {
    // Oversized files are reported by size alone; the index flags them without reading them.
    const size = await fs.sizeOf(path);
    if (size > maxBytes) return { path, sha256: "", size };
    bytes = await fs.readBytes(path);
  } catch (error) {
    const problem = fsProblem(error, path);
    if (problem === null) throw error;
    return { path, sha256: "", size: 0, readError: problem };
  }
  const file: StoreFile = { path, sha256: sha256Hex(bytes), size: bytes.byteLength };
  if (classifyStorePath(path)) {
    try {
      file.value = parseJson(decoder.decode(bytes));
    } catch (error) {
      file.readError = (error as Error).message;
    }
  }
  return file;
}

/** Scans the store and builds its index; scan problems are merged into the index diagnostics. */
export async function readStoreIndex(
  fs: SafeFileSystem,
  options: { applicationId: string; limits?: Partial<StoreLimits>; maxReferencedBytes?: number },
): Promise<StoreIndex> {
  const scan = await scanStore(fs, {
    maxMetadataBytes: options.limits?.maxMetadataBytes ?? DEFAULT_STORE_LIMITS.maxMetadataBytes,
    ...(options.maxReferencedBytes === undefined ? {} : { maxReferencedBytes: options.maxReferencedBytes }),
  });
  const index = buildStoreIndex({
    applicationId: options.applicationId,
    records: scan.records,
    referenced: scan.referenced,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { ...index, diagnostics: sortDiagnostics([...index.diagnostics, ...scan.diagnostics]) };
}
