/**
 * @design-loom/integrations: I/O adapters: the safe file system (backlog B03), the store reader (B05), and providers such as
 * GitHub review reads and source retrieval (backlog B12). With cli, the only package allowed to do I/O.
 */

export {
  type DirectoryEntry,
  SafeFileSystem,
  SafeFsError,
  type SafeFsErrorCode,
  type WriteOptions,
} from "./safe-fs.ts";
export {
  DEFAULT_MAX_REFERENCED_BYTES,
  readStoreIndex,
  type ScanOptions,
  type StoreScan,
  scanStore,
} from "./store-reader.ts";

export const PACKAGE_NAME = "@design-loom/integrations";
