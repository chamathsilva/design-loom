/**
 * @design-loom/integrations: I/O adapters: the safe file system (backlog B03), the store reader (B05), the configuration loader (B04), and providers such as
 * GitHub review reads and source retrieval (backlog B12). With cli, the only package allowed to do I/O.
 */

export {
  APPLICATION_PATH,
  LOCK_PATH,
  type LoadedConfiguration,
  loadConfiguration,
  loadExtension,
  loadRelease,
  RELEASE_ORIGIN,
} from "./config-loader.ts";
export {
  type DirectoryEntry,
  osErrorCode,
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
