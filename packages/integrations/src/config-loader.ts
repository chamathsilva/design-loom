/**
 * Reads everything the effective-configuration resolver needs (backlog B04; design doc 03,
 * "Configuration resolution"; doc 07, `ConfigResolver.resolve`).
 *
 * - The release's core resources: `release.json`, the workflow and template descriptors it lists,
 *   and each template's Markdown starter. Their inventory digest is compared with the lock.
 * - The application's `.design-loom/app.json` and `.design-loom/framework.lock.json`.
 * - Each extension folder listed in `extension_paths`: its `extension.json`, every file it
 *   declares, and the starters of its template descriptors.
 *
 * Every read goes through SafeFileSystem and every JSON file is parsed strictly. Nothing is fetched,
 * and no parent folder, home folder or environment variable is consulted (design doc 03).
 */

import {
  checkReleaseManifest,
  type Diagnostic,
  diagnostic,
  type ExtensionInput,
  extensionDeclaredFiles,
  type InventoryFile,
  isTemplateDescriptorPath,
  normalizeRelativePath,
  parseJson,
  type ResolveInput,
  resourceInventoryDigest,
  type SourceDocument,
  sha256Hex,
  sortDiagnostics,
  templateContentPath,
} from "@design-loom/config";
import { type SafeFileSystem, SafeFsError } from "./safe-fs.ts";

export const APPLICATION_PATH = ".design-loom/app.json";
export const LOCK_PATH = ".design-loom/framework.lock.json";
/** Prefix for release resource origins, so provenance never names a local install path. */
export const RELEASE_ORIGIN = "core";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** A file could not be read or parsed; it becomes a diagnostic. */
class LoadError extends Error {
  readonly code: string;
  readonly path: string;
  readonly remediation: string;
  constructor(code: string, path: string, message: string, remediation: string) {
    super(message);
    this.code = code;
    this.path = path;
    this.remediation = remediation;
  }
}

interface ReadFile {
  bytes: Uint8Array;
  sha256: string;
}

async function readFileAt(
  fs: SafeFileSystem,
  path: string,
  shownAs: string,
  missingRemediation: string,
): Promise<ReadFile> {
  try {
    const bytes = await fs.readBytes(path);
    return { bytes, sha256: sha256Hex(bytes) };
  } catch (error) {
    if (!(error instanceof SafeFsError)) throw error;
    if (error.code === "not-found")
      throw new LoadError("CONFIG_FILE_MISSING", shownAs, `${shownAs} is missing`, missingRemediation);
    throw new LoadError(
      "CONFIG_FILE_UNREADABLE",
      shownAs,
      error.message,
      "Use a regular file inside the folder, named with its exact case.",
    );
  }
}

function parse(file: ReadFile, shownAs: string): unknown {
  try {
    return parseJson(decoder.decode(file.bytes));
  } catch (error) {
    throw new LoadError(
      "CONFIG_FILE_INVALID_JSON",
      shownAs,
      `${shownAs} is not valid JSON: ${(error as Error).message}`,
      "Fix the file: one JSON value, UTF-8, no duplicate keys.",
    );
  }
}

async function readDocument(
  fs: SafeFileSystem,
  path: string,
  origin: string,
  missingRemediation: string,
): Promise<SourceDocument & { file: ReadFile }> {
  const file = await readFileAt(fs, path, origin, missingRemediation);
  return { origin, sha256: file.sha256, value: parse(file, origin), file };
}

const join = (folder: string, path: string): string => (folder === "" ? path : `${folder}/${path}`);

const REINSTALL = "Reinstall the plugin; its core resources are incomplete.";

/** Reads the release's core resources from their folder. */
export async function loadRelease(
  release: SafeFileSystem,
  engineSha256: string | null,
): Promise<ResolveInput["release"]> {
  const origin = (path: string): string => `${RELEASE_ORIGIN}/${path}`;
  const manifest = await readDocument(release, "release.json", origin("release.json"), REINSTALL);
  const checked = checkReleaseManifest(manifest.value);
  if (!checked.manifest) {
    throw new LoadError("CONFIG_RELEASE_INVALID", manifest.origin, checked.problems.join("; "), REINSTALL);
  }
  const inventory: InventoryFile[] = [{ path: "release.json", sha256: manifest.sha256 }];
  const workflows: SourceDocument[] = [];
  for (const path of checked.manifest.workflows) {
    const document = await readDocument(release, path, origin(path), REINSTALL);
    inventory.push({ path, sha256: document.sha256 });
    workflows.push({ origin: document.origin, sha256: document.sha256, value: document.value });
  }
  const templates: SourceDocument[] = [];
  for (const path of checked.manifest.templates) {
    const document = await readDocument(release, path, origin(path), REINSTALL);
    inventory.push({ path, sha256: document.sha256 });
    templates.push({ origin: document.origin, sha256: document.sha256, value: document.value });
    const contentPath = (document.value as { content_path?: unknown }).content_path;
    if (typeof contentPath === "string") {
      const content = templateContentPath(path, contentPath);
      const file = await readFileAt(release, content, origin(content), REINSTALL);
      inventory.push({ path: content, sha256: file.sha256 });
    }
  }
  return {
    manifest: { origin: manifest.origin, sha256: manifest.sha256, value: manifest.value },
    workflows,
    templates,
    resourcesSha256: resourceInventoryDigest(inventory),
    engineSha256,
  };
}

/** Reads one extension folder: its manifest, declared files and descriptor starters. */
export async function loadExtension(app: SafeFileSystem, folder: string): Promise<ExtensionInput> {
  const manifestPath = join(folder, "extension.json");
  const manifest = await readDocument(
    app,
    manifestPath,
    manifestPath,
    "Add extension.json to the extension folder, or remove the folder from extension_paths.",
  );
  const declared = extensionDeclaredFiles(manifest.value);
  if (declared.problems.length > 0) {
    throw new LoadError(
      "CONFIG_EXTENSION_INVALID",
      manifestPath,
      declared.problems.join("; "),
      "Fix the extension manifest.",
    );
  }
  const inventory: InventoryFile[] = [{ path: "extension.json", sha256: manifest.sha256 }];
  const descriptors = new Map<string, SourceDocument>();
  const resources = (manifest.value as { resources: { id: string; kind: string; path: string }[] }).resources;
  const missing = "Restore the file, or remove it from the extension manifest.";
  const seen = new Set<string>(["extension.json"]);
  const addFile = async (relative: string): Promise<ReadFile> => {
    const file = await readFileAt(app, join(folder, relative), join(folder, relative), missing);
    if (!seen.has(relative)) inventory.push({ path: relative, sha256: file.sha256 });
    seen.add(relative);
    return file;
  };
  for (const relative of declared.files) await addFile(relative);
  for (const resource of resources) {
    const relative = normalizeRelativePath(resource.path);
    const isDescriptor =
      resource.kind === "workflow" || (resource.kind === "template" && isTemplateDescriptorPath(relative));
    if (!isDescriptor) continue;
    const shownAs = join(folder, relative);
    const file = await readFileAt(app, shownAs, shownAs, missing);
    const value = parse(file, shownAs);
    descriptors.set(resource.id, { origin: shownAs, sha256: file.sha256, value });
    const contentPath = (value as { content_path?: unknown }).content_path;
    if (resource.kind === "template" && typeof contentPath === "string") {
      await addFile(templateContentPath(relative, contentPath));
    }
  }
  return {
    path: folder,
    manifest: { origin: manifest.origin, sha256: manifest.sha256, value: manifest.value },
    resourcesSha256: resourceInventoryDigest(inventory),
    descriptors,
  };
}

export interface LoadedConfiguration {
  /** Null when a required file is missing or unreadable; the diagnostics say why. */
  input: ResolveInput | null;
  diagnostics: Diagnostic[];
  /** False when the plugin's own core resources couldn't be loaded: a broken install, not bad input. */
  releaseLoaded: boolean;
}

/**
 * Reads the resolver inputs. `app` is opened at the application root, `release` at the core
 * resource folder of the running plugin. `engineSha256` is the running bundle's digest, or null.
 */
export async function loadConfiguration(
  app: SafeFileSystem,
  release: SafeFileSystem,
  engineSha256: string | null,
): Promise<LoadedConfiguration> {
  const diagnostics: Diagnostic[] = [];
  const capture = (error: unknown): null => {
    if (error instanceof LoadError) {
      diagnostics.push(
        diagnostic(error.code, "error", error.message, { path: error.path, remediation: error.remediation }),
      );
      return null;
    }
    // A declared path that fails the path policy, or an inventory that can't be hashed.
    const name = (error as Error | undefined)?.name;
    if (name === "PathPolicyError" || name === "CanonicalJsonError") {
      diagnostics.push(
        diagnostic("CONFIG_RESOURCE_INVALID", "error", (error as Error).message, {
          remediation: "Fix the resource paths in the manifest or descriptor.",
        }),
      );
      return null;
    }
    throw error;
  };

  const releaseInput = await loadRelease(release, engineSha256).catch(capture);
  const application = await readDocument(
    app,
    APPLICATION_PATH,
    APPLICATION_PATH,
    "Initialize the application, or pass the root of a Design Loom design repository.",
  ).catch(capture);
  const lock = await readDocument(
    app,
    LOCK_PATH,
    LOCK_PATH,
    "Commit the framework lock the application was reviewed with.",
  ).catch(capture);

  const extensions: ExtensionInput[] = [];
  const paths = (application?.value as { extension_paths?: unknown } | undefined)?.extension_paths;
  if (Array.isArray(paths)) {
    for (const raw of paths) {
      let folder: string;
      try {
        if (typeof raw !== "string")
          throw new Error(`extension_paths entries must be strings, not ${JSON.stringify(raw)}`);
        folder = normalizeRelativePath(raw);
      } catch (error) {
        diagnostics.push(
          diagnostic("CONFIG_EXTENSION_INVALID", "error", (error as Error).message, {
            path: APPLICATION_PATH,
            remediation: "List extension folders by safe relative paths.",
          }),
        );
        continue;
      }
      const extension = await loadExtension(app, folder).catch(capture);
      if (extension) extensions.push(extension);
    }
  }

  if (!releaseInput || !application || !lock || diagnostics.length > 0) {
    return { input: null, diagnostics: sortDiagnostics(diagnostics), releaseLoaded: releaseInput !== null };
  }
  const strip = ({ origin, sha256, value }: SourceDocument): SourceDocument => ({ origin, sha256, value });
  return {
    input: { release: releaseInput, application: strip(application), lock: strip(lock), extensions },
    diagnostics: [],
    releaseLoaded: true,
  };
}
