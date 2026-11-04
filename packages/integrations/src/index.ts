/**
 * @design-loom/integrations: I/O adapters: the safe file system (backlog B03), and providers such as
 * GitHub review reads and source retrieval (backlog B12). With cli, the only package allowed to do I/O.
 */

export { SafeFileSystem, SafeFsError, type SafeFsErrorCode, type WriteOptions } from "./safe-fs.ts";

export const PACKAGE_NAME = "@design-loom/integrations";
