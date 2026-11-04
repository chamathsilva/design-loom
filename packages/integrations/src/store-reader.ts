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
import { type SafeFileSystem, SafeFsError } from "./safe-fs.ts";

export interface StoreScan {
  records: StoreFile[];
  /** SHA-256 of each referenced file, or null when it is missing or can't be read safely. */
  referenced: Map<string, string | null>;
  /** Problems with the folders themselves, such as symlinked folders. */
  diagnostics: Diagnostic[];
}

/** Folders nested deeper than this under a scan root are not listed. */
const MAX_FOLDER_DEPTH = 8;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Lists and reads the store. Missing scan roots are fine: a new repository has none. */
export async function scanStore(fs: SafeFileSystem): Promise<StoreScan> {
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
      if (error instanceof SafeFsError) {
        diagnostics.push(
          diagnostic("STORE_FOLDER_UNREADABLE", "error", error.message, {
            path: folder,
            remediation: "Replace the folder with a real folder inside the repository.",
          }),
        );
        return;
      }
      throw error;
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
        records.push(await readRecord(fs, path));
      } else {
        warn("STORE_UNEXPECTED_FILE", "special file is ignored", path, "Remove it.");
      }
    }
  };

  for (const root of STORE_SCAN_ROOTS) {
    // Check the root folder itself the same way as anything inside it.
    await walk(root, 0);
  }

  const referenced = new Map<string, string | null>();
  for (const path of referencedFiles(records)) {
    try {
      referenced.set(path, sha256Hex(await fs.readBytes(path)));
    } catch (error) {
      if (!(error instanceof SafeFsError)) throw error;
      referenced.set(path, null);
      if (error.code !== "not-found") {
        diagnostics.push(
          diagnostic("STORE_REFERENCE_UNREADABLE", "error", error.message, {
            path,
            remediation: "Referenced files must be regular files inside the repository, named with their exact case.",
          }),
        );
      }
    }
  }
  return { records, referenced, diagnostics };
}

async function readRecord(fs: SafeFileSystem, path: string): Promise<StoreFile> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readBytes(path);
  } catch (error) {
    if (!(error instanceof SafeFsError)) throw error;
    return { path, sha256: "", size: 0, readError: error.message };
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
  options: { applicationId: string; limits?: Partial<StoreLimits> },
): Promise<StoreIndex> {
  const scan = await scanStore(fs);
  const index = buildStoreIndex({
    applicationId: options.applicationId,
    records: scan.records,
    referenced: scan.referenced,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { ...index, diagnostics: sortDiagnostics([...index.diagnostics, ...scan.diagnostics]) };
}
