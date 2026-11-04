/**
 * Effective-configuration resolution (backlog B04; design doc 03, "Configuration resolution" and
 * "Effective-configuration contract"; doc 06, "Resolution algorithm"; doc 16, semantic rules).
 *
 * Pure: the caller reads every file and passes its parsed value with the SHA-256 of its raw bytes.
 * The result is the effective-config envelope, its digest, a comparison with the framework lock and
 * sorted diagnostics. Lock mismatches still produce an envelope, so read-only diagnostics such as
 * `doctor` and `config resolve` can explain them; commands that produce certified output must refuse
 * to run unless `lock.ok` is true (design doc 06, "Upgrade and rollback").
 */

import { type SchemaKind, validateAgainstSchema } from "@design-loom/validation";
import { CanonicalJsonError, canonicalDigest, compareCodePoints, type JsonValue } from "./canonical-json.ts";
import { type Diagnostic, diagnostic, hasErrors, pointerPath, pointerToken, sortDiagnostics } from "./diagnostics.ts";
import { caseFoldKey, findCaseFoldCollisions, normalizeRelativePath } from "./paths.ts";
import { parseRange, parseVersion, satisfiesRange } from "./version-range.ts";

export const EFFECTIVE_CONFIG_SCHEMA_VERSION = "1.0";

/** Output kinds that name framework objects, not artifact types (design doc 16). */
export const BUILT_IN_OUTPUT_KINDS: readonly string[] = ["baseline", "handoff"];

const ID = /^[A-Za-z][A-Za-z0-9._-]{1,79}$/;
const RULE_ID = /^DL\d{3}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------------
// Inputs and outputs

/** One parsed input file. */
export interface SourceDocument {
  /**
   * Portable identifier: a release resource such as `core/templates/review.template.json`, or a
   * path relative to the application root such as `.design-loom/app.json`. Never a local absolute path.
   */
  origin: string;
  /** SHA-256 of the raw bytes `value` was parsed from. */
  sha256: string;
  value: unknown;
}

/** The running release's built-in definitions (design doc 03, step 1). */
export interface ReleaseInput {
  /** `core/release.json`. */
  manifest: SourceDocument;
  workflows: readonly SourceDocument[];
  templates: readonly SourceDocument[];
  /** resource-inventory-v1 digest of every core resource file, compared with the lock's `resources_sha256`. */
  resourcesSha256: string;
  /** SHA-256 of the running engine bundle, or null when running from source, where there is no bundle to hash. */
  engineSha256: string | null;
}

/** One extension the application lists in `extension_paths`. */
export interface ExtensionInput {
  /** The `extension_paths` entry that selected it. */
  path: string;
  /** `<path>/extension.json`. */
  manifest: SourceDocument;
  /** resource-inventory-v1 digest of the manifest and every file it declares. */
  resourcesSha256: string;
  /** Parsed workflow descriptors and `.template.json` template descriptors, keyed by resource ID. */
  descriptors: ReadonlyMap<string, SourceDocument>;
}

export interface ResolveInput {
  release: ReleaseInput;
  /** `.design-loom/app.json`. */
  application: SourceDocument;
  /** `.design-loom/framework.lock.json`. */
  lock: SourceDocument;
  /** In any order; the resolver sorts them. */
  extensions: readonly ExtensionInput[];
}

export type JsonObject = { [key: string]: JsonValue };

export interface EffectiveConfiguration {
  application: JsonObject;
  framework_lock: JsonObject;
  artifact_types: string[];
  core_rule_ids: string[];
  workflows: JsonObject[];
  templates: JsonObject[];
  extensions: JsonObject[];
}

export interface ProvenanceEntry {
  /** JSON Pointer into `configuration`. */
  pointer: string;
  origin: string;
  sha256: string;
}

export interface EffectiveConfigEnvelope {
  schema_version: typeof EFFECTIVE_CONFIG_SCHEMA_VERSION;
  configuration: EffectiveConfiguration;
  provenance: ProvenanceEntry[];
}

/** `match`: equal. `mismatch`: different. `unknown`: the actual value couldn't be established. */
export type LockState = "match" | "mismatch" | "unknown";

export interface LockReport {
  /** True only when every check matches. */
  ok: boolean;
  framework_version: LockState;
  engine: LockState;
  resources: LockState;
  extensions: LockState;
}

export interface ResolveResult {
  /** Null when the inputs are invalid or a selection can't be resolved. Deeply frozen. */
  envelope: EffectiveConfigEnvelope | null;
  /** effective_config_digest of the envelope, or null without one. */
  digest: string | null;
  /** Null when the lock itself is invalid. */
  lock: LockReport | null;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------------------------------
// Typed views of the inputs, used only after schema validation

interface ReleaseManifest {
  schema_version: "1.0";
  framework_version: string;
  artifact_types: string[];
  core_rule_ids: string[];
  workflows: string[];
  templates: string[];
}

interface ApplicationView {
  application_id: string;
  design_repository_id: string;
  repositories: { id: string }[];
  default_workflow: string;
  framework_version: string;
  extension_paths: string[];
  template_selections: Record<string, string>;
  capabilities: { id: string }[];
  reviewer_roles: Record<string, string[]>;
  required_review_roles: string[];
  required_artifact_types?: string[];
}

interface LockView {
  framework_version: string;
  engine_sha256: string;
  resources_sha256: string;
  extensions_locked: { id: string; version: string; sha256: string }[];
}

interface WorkflowView {
  id: string;
  steps: {
    id: string;
    after: string[];
    capabilities: string[];
    required_outputs: string[];
    blocking_rules: string[];
    reviewer_roles: string[];
  }[];
}

interface TemplateView {
  id: string;
  artifact_type: string;
  sections: { heading: string; required: boolean }[];
}

interface ExtensionResource {
  id: string;
  kind: "template" | "artifact_type" | "workflow" | "instructions";
  path: string;
  artifact_type?: string;
}

interface ExtensionView {
  id: string;
  version: string;
  framework_range: string;
  requires: string[];
  resources: ExtensionResource[];
  rules: { id: string; kind: string; artifact_type: string; parameters: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------------------------------
// Helpers the file loader shares with the resolver

/** Checks `core/release.json`. It has no framework schema because it ships with the engine. */
export function checkReleaseManifest(value: unknown): { manifest: ReleaseManifest | null; problems: string[] } {
  const problems: string[] = [];
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const record = (isObject ? value : {}) as Record<string, unknown>;
  if (!isObject) problems.push("release manifest must be a JSON object");
  const allowed = new Set([
    "schema_version",
    "framework_version",
    "artifact_types",
    "core_rule_ids",
    "workflows",
    "templates",
  ]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) problems.push(`unknown key ${JSON.stringify(key)}`);
  if (record.schema_version !== "1.0") problems.push('schema_version must be "1.0"');
  if (typeof record.framework_version !== "string" || !parseVersion(record.framework_version)) {
    problems.push("framework_version must be MAJOR.MINOR.PATCH");
  }
  const stringList = (key: string, pattern: RegExp | null, minItems: number): void => {
    const list = record[key];
    if (!Array.isArray(list) || list.length < minItems) {
      problems.push(`${key} must be an array with at least ${minItems} item(s)`);
      return;
    }
    const seen = new Set<string>();
    for (const item of list) {
      if (typeof item !== "string") {
        problems.push(`${key} must contain strings only`);
        continue;
      }
      if (pattern && !pattern.test(item)) problems.push(`${key}: ${JSON.stringify(item)} is not a valid ID`);
      if (!pattern) {
        try {
          if (normalizeRelativePath(item) !== item) problems.push(`${key}: ${JSON.stringify(item)} is not normalized`);
        } catch (error) {
          problems.push(`${key}: ${(error as Error).message}`);
        }
      }
      if (seen.has(caseFoldKey(item))) problems.push(`${key}: ${JSON.stringify(item)} is listed twice`);
      seen.add(caseFoldKey(item));
    }
  };
  stringList("artifact_types", ID, 1);
  stringList("core_rule_ids", RULE_ID, 1);
  stringList("workflows", null, 1);
  stringList("templates", null, 1);
  return { manifest: problems.length === 0 ? (value as ReleaseManifest) : null, problems };
}

/**
 * The file a template descriptor names in `content_path`, relative to the same root as the
 * descriptor. Throws PathPolicyError when the result would leave that root.
 */
export function templateContentPath(descriptorPath: string, contentPath: string): string {
  const slash = descriptorPath.lastIndexOf("/");
  const folder = slash === -1 ? "" : descriptorPath.slice(0, slash + 1);
  return normalizeRelativePath(`${folder}${normalizeRelativePath(contentPath)}`);
}

/**
 * Files an extension manifest declares, relative to the extension folder: every resource path and
 * every `json_schema` rule's `schema_path`. Template descriptor starters (`content_path`) are added
 * by the loader after it parses the descriptor.
 */
export function extensionDeclaredFiles(manifest: unknown): { files: string[]; problems: string[] } {
  const result = validateAgainstSchema("extension", manifest);
  if (!result.valid)
    return { files: [], problems: result.issues.map((issue) => `${issue.instancePath}: ${issue.message}`) };
  const view = manifest as ExtensionView;
  const problems: string[] = [];
  const files = new Set<string>();
  const add = (raw: unknown, where: string): void => {
    if (typeof raw !== "string") {
      problems.push(`${where} must be a string`);
      return;
    }
    try {
      const path = normalizeRelativePath(raw);
      if (caseFoldKey(path) === "extension.json") problems.push(`${where} must not name the manifest itself`);
      files.add(path);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
    }
  };
  view.resources.forEach((resource, index) => {
    add(resource.path, `/resources/${index}/path`);
  });
  view.rules.forEach((rule, index) => {
    if (rule.kind === "json_schema") add(rule.parameters.schema_path, `/rules/${index}/parameters/schema_path`);
  });
  // Names that differ only in case at any folder level are one file on Windows and macOS but two on
  // Linux, so the inventory would depend on the platform.
  for (const group of findCaseFoldCollisions([...files, "extension.json"])) {
    problems.push(`${group.map((name) => JSON.stringify(name)).join(" and ")} differ only in case`);
  }
  return { files: [...files].sort(compareCodePoints), problems };
}

/** True when an extension resource is a parsed template descriptor rather than a Markdown starter. */
export function isTemplateDescriptorPath(path: string): boolean {
  return path.endsWith(".template.json");
}

/** effective_config_digest: canonical-json-v1 SHA-256 of exactly `schema_version` and `configuration`. */
export function effectiveConfigDigest(envelope: { schema_version: string; configuration: unknown }): string {
  return canonicalDigest({ schema_version: envelope.schema_version, configuration: envelope.configuration });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Orders extensions so each comes after the ones it requires, breaking ties by ID; null on a cycle. */
function topologicalOrder(extensions: readonly ExtensionView[]): string[] | null {
  const remaining = new Map(extensions.map((extension) => [extension.id, new Set(extension.requires)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, needs]) => needs.size === 0).map(([id]) => id);
    if (ready.length === 0) return null;
    ready.sort(compareCodePoints);
    const next = ready[0] as string;
    order.push(next);
    remaining.delete(next);
    for (const needs of remaining.values()) needs.delete(next);
  }
  return order;
}

// ---------------------------------------------------------------------------------------------------
// The resolver, one function per step of design doc 03 "Configuration resolution"

/** Diagnostics from one resolution: problems that stop it, and lock comparisons, which don't. */
class Findings {
  readonly blocking: Diagnostic[] = [];
  readonly lock: Diagnostic[] = [];

  error(code: string, message: string, path: string, remediation: string, evidence: string[] = []): void {
    this.blocking.push(diagnostic(code, "error", message, { path, evidence, remediation }));
  }

  lockError(code: string, message: string, path: string, remediation: string, evidence: string[] = []): void {
    this.lock.push(diagnostic(code, "error", message, { path, evidence, remediation }));
  }

  get failed(): boolean {
    return hasErrors(this.blocking);
  }

  all(): Diagnostic[] {
    return sortDiagnostics([...this.blocking, ...this.lock]);
  }
}

type ExtensionEntry = { input: ExtensionInput; view: ExtensionView };

interface Registries {
  artifactTypes: Map<string, { id: string; origin: SourceDocument }>;
  ruleIds: Map<string, string>;
  workflows: Map<string, { document: SourceDocument; view: WorkflowView }>;
  templates: Map<string, { document: SourceDocument; view: TemplateView }>;
  /** Every selectable template, including extension Markdown templates that have no descriptor. */
  templateTypes: Map<string, { id: string; artifactType: string; path: string }>;
  resourceIds: Map<string, string>;
  /** The release's own template for each artifact type, whose required sections selections must keep. */
  coreTemplateByType: Map<string, TemplateView>;
}

const knownType = (registries: Registries, type: string): boolean =>
  registries.artifactTypes.get(caseFoldKey(type))?.id === type;

/** Adds an ID to a registry unless it is already there ignoring case; there is no override (design doc 06). */
function register<T>(
  registry: Map<string, T>,
  id: string,
  value: T,
  label: string,
  path: string,
  out: Findings,
): boolean {
  if (registry.has(caseFoldKey(id))) {
    out.error(
      "CONFIG_DUPLICATE_ID",
      `${label} ${id} is defined twice`,
      path,
      `Rename one of the ${label}s; nothing can override another.`,
    );
    return false;
  }
  registry.set(caseFoldKey(id), value);
  return true;
}

function checkSchema(kind: SchemaKind, document: SourceDocument, out: Findings): boolean {
  const result = validateAgainstSchema(kind, document.value);
  for (const issue of result.issues) {
    out.error(
      "CONFIG_SCHEMA_INVALID",
      `${kind}: ${issue.message}`,
      pointerPath(document.origin, issue.instancePath),
      `Fix the file so it matches ${kind}.schema.json.`,
      [issue.schemaPath],
    );
  }
  return result.valid;
}

function checkDigest(digest: string, what: string, path: string, out: Findings): void {
  if (!SHA256.test(digest))
    out.error("CONFIG_INPUT_INVALID", `${what} is not a lower-case SHA-256`, path, "Report this as a defect.");
}

/** Every workflow and template descriptor an extension declares must have been loaded, and be valid. */
function checkExtensionDescriptors(extension: ExtensionInput, out: Findings): void {
  const view = extension.manifest.value as ExtensionView;
  for (const resource of view.resources) {
    const needsDescriptor =
      resource.kind === "workflow" || (resource.kind === "template" && isTemplateDescriptorPath(resource.path));
    const descriptor = extension.descriptors.get(resource.id);
    if (descriptor) {
      checkSchema(resource.kind === "workflow" ? "workflow" : "template", descriptor, out);
    } else if (needsDescriptor) {
      out.error(
        "CONFIG_EXTENSION_RESOURCE_MISSING",
        `resource ${resource.id} was not loaded`,
        extension.manifest.origin,
        "Report this as a defect: the loader must parse every workflow and template descriptor.",
      );
    }
  }
}

/** The extensions supplied must be exactly the folders the application lists in extension_paths. */
function checkExtensionPaths(input: ResolveInput, out: Findings): void {
  const listed = (input.application.value as ApplicationView).extension_paths;
  const supplied = input.extensions.map((extension) => extension.path);
  const missing = listed.filter((path) => !supplied.includes(path));
  const extra = supplied.filter((path) => !listed.includes(path));
  const repeated = supplied.filter((path, index) => supplied.indexOf(path) !== index);
  if (missing.length + extra.length + repeated.length === 0) return;
  out.error(
    "CONFIG_EXTENSION_PATHS_MISMATCH",
    "the extensions supplied don't match the application's extension_paths",
    pointerPath(input.application.origin, "/extension_paths"),
    "Report this as a defect: the loader must load each listed folder exactly once, and nothing else.",
    [
      ...missing.map((path) => `not loaded: ${path}`),
      ...extra.map((path) => `not listed: ${path}`),
      ...repeated.map((path) => `loaded twice: ${path}`),
    ],
  );
}

/** Step 1: every input matches its contract. */
function checkInputs(
  input: ResolveInput,
  out: Findings,
): { manifest: ReleaseManifest | null; applicationValid: boolean; lockValid: boolean } {
  const { release } = input;
  const releaseCheck = checkReleaseManifest(release.manifest.value);
  for (const problem of releaseCheck.problems) {
    out.error(
      "CONFIG_RELEASE_INVALID",
      problem,
      release.manifest.origin,
      "Reinstall the plugin; its core resources are damaged.",
    );
  }
  const documents = [
    release.manifest,
    ...release.workflows,
    ...release.templates,
    input.application,
    input.lock,
    ...input.extensions.flatMap((extension) => [extension.manifest, ...extension.descriptors.values()]),
  ];
  for (const document of documents) checkDigest(document.sha256, "input digest", document.origin, out);
  checkDigest(release.resourcesSha256, "resource digest", "", out);
  for (const extension of input.extensions)
    checkDigest(extension.resourcesSha256, "resource digest", extension.path, out);
  if (release.engineSha256 !== null) checkDigest(release.engineSha256, "engine digest", "", out);

  const applicationValid = checkSchema("application", input.application, out);
  const lockValid = checkSchema("framework-lock", input.lock, out);
  for (const document of release.workflows) checkSchema("workflow", document, out);
  for (const document of release.templates) checkSchema("template", document, out);
  for (const extension of input.extensions) {
    if (checkSchema("extension", extension.manifest, out)) checkExtensionDescriptors(extension, out);
  }
  return { manifest: releaseCheck.manifest, applicationValid, lockValid };
}

const compareState = (expected: string, actual: string | null): LockState => {
  if (actual === null) return "unknown";
  return expected === actual ? "match" : "mismatch";
};

/** Step 2a: framework version, engine and core resources against the lock (design doc 03, "Lockfile"). */
function compareCoreLock(
  pinned: LockView,
  lockPath: string,
  release: ReleaseInput,
  frameworkVersion: string,
  out: Findings,
): [LockState, LockState, LockState] {
  const framework = compareState(pinned.framework_version, frameworkVersion);
  const engine = compareState(pinned.engine_sha256, release.engineSha256);
  const resources = compareState(pinned.resources_sha256, release.resourcesSha256);
  const remediation = "Install the pinned plugin build, or review and commit a lock update for this one.";
  if (framework === "mismatch") {
    out.lockError(
      "CONFIG_LOCK_FRAMEWORK_MISMATCH",
      `the lock pins framework ${pinned.framework_version} but ${frameworkVersion} is running`,
      pointerPath(lockPath, "/framework_version"),
      "Install the pinned plugin version, or review and commit a lock update for the new one.",
      [`locked: ${pinned.framework_version}`, `running: ${frameworkVersion}`],
    );
  }
  if (engine === "mismatch") {
    out.lockError(
      "CONFIG_LOCK_ENGINE_MISMATCH",
      "the running engine differs from the locked engine",
      pointerPath(lockPath, "/engine_sha256"),
      remediation,
      [`locked: ${pinned.engine_sha256}`, `running: ${release.engineSha256}`],
    );
  } else if (engine === "unknown") {
    out.lock.push(
      diagnostic("CONFIG_LOCK_ENGINE_UNKNOWN", "warning", "the running engine has no digest to compare with the lock", {
        path: pointerPath(lockPath, "/engine_sha256"),
        evidence: ["running from source, not from a built plugin"],
        remediation: "Run a built plugin to verify the engine. Certified commands refuse to run until it matches.",
      }),
    );
  }
  if (resources === "mismatch") {
    out.lockError(
      "CONFIG_LOCK_RESOURCES_MISMATCH",
      "the running core resources differ from the locked resources",
      pointerPath(lockPath, "/resources_sha256"),
      remediation,
      [`locked: ${pinned.resources_sha256}`, `running: ${release.resourcesSha256}`],
    );
  }
  return [framework, engine, resources];
}

/** Step 2b: each loaded extension against its lock tuple, and every tuple against a loaded extension. */
function compareExtensionLock(
  pinned: LockView,
  lockPath: string,
  extensions: readonly ExtensionInput[],
  out: Findings,
): LockState {
  let state: LockState = "match";
  const locked = new Map<string, { id: string; version: string; sha256: string }>();
  for (const [index, tuple] of pinned.extensions_locked.entries()) {
    if (locked.has(caseFoldKey(tuple.id))) {
      state = "mismatch";
      out.lockError(
        "CONFIG_LOCK_DUPLICATE_EXTENSION",
        `the lock lists extension ${tuple.id} twice`,
        pointerPath(lockPath, `/extensions_locked/${index}`),
        "Keep one entry per extension.",
      );
    }
    locked.set(caseFoldKey(tuple.id), tuple);
  }
  const loaded = new Set<string>();
  for (const extension of extensions) {
    const value = extension.manifest.value;
    // A manifest that fails its schema is reported by the schema check; don't compare it here.
    if (!validateAgainstSchema("extension", value).valid) continue;
    const view = value as Partial<ExtensionView>;
    if (typeof view.id !== "string") continue;
    loaded.add(caseFoldKey(view.id));
    const tuple = locked.get(caseFoldKey(view.id));
    if (!tuple) {
      state = "mismatch";
      out.lockError(
        "CONFIG_EXTENSION_NOT_LOCKED",
        `extension ${view.id} is not in the lock`,
        extension.manifest.origin,
        "Review the extension, then add its ID, version and digest to the lock.",
        [`digest: ${extension.resourcesSha256}`],
      );
    } else if (tuple.id !== view.id || tuple.version !== view.version || tuple.sha256 !== extension.resourcesSha256) {
      state = "mismatch";
      out.lockError(
        "CONFIG_EXTENSION_LOCK_MISMATCH",
        `extension ${view.id} differs from its lock entry`,
        extension.manifest.origin,
        "Restore the reviewed extension files, or review the change and update the lock entry.",
        [
          `locked: ${tuple.id} ${tuple.version} ${tuple.sha256}`,
          `found: ${view.id} ${String(view.version)} ${extension.resourcesSha256}`,
        ],
      );
    }
  }
  for (const [key, tuple] of locked) {
    if (loaded.has(key)) continue;
    state = "mismatch";
    out.lockError(
      "CONFIG_EXTENSION_LOCK_UNUSED",
      `the lock pins extension ${tuple.id}, but the application doesn't load it`,
      lockPath,
      "Add the extension's folder to extension_paths, or remove it from the lock in a reviewed change.",
    );
  }
  return state;
}

/** Step 2: compare what the application pinned with what is actually running. */
function compareLock(input: ResolveInput, frameworkVersion: string, out: Findings): LockReport {
  const pinned = input.lock.value as LockView;
  const [framework, engine, resources] = compareCoreLock(
    pinned,
    input.lock.origin,
    input.release,
    frameworkVersion,
    out,
  );
  const extensions = compareExtensionLock(pinned, input.lock.origin, input.extensions, out);
  // The application profile pins a framework version too; it must agree with the lock.
  const appVersion = (input.application.value as { framework_version?: unknown } | null)?.framework_version;
  let frameworkState = framework;
  if (typeof appVersion === "string" && appVersion !== pinned.framework_version) {
    frameworkState = "mismatch";
    out.lockError(
      "CONFIG_APP_FRAMEWORK_MISMATCH",
      `the application profile pins framework ${appVersion} but the lock pins ${pinned.framework_version}`,
      pointerPath(input.application.origin, "/framework_version"),
      "Update the profile and the lock together in one reviewed change.",
      [`profile: ${appVersion}`, `lock: ${pinned.framework_version}`],
    );
  }
  return {
    ok: [frameworkState, engine, resources, extensions].every((state) => state === "match"),
    framework_version: frameworkState,
    engine,
    resources,
    extensions,
  };
}

/** Step 3: unique extension IDs, compatible framework ranges, dependencies present and acyclic. */
function orderExtensions(
  entries: readonly ExtensionEntry[],
  frameworkVersion: string,
  appPath: string,
  out: Findings,
): Map<string, ExtensionEntry> | null {
  const byId = new Map<string, ExtensionEntry>();
  for (const entry of entries) {
    const existing = byId.get(caseFoldKey(entry.view.id));
    if (existing) {
      out.error(
        "CONFIG_DUPLICATE_ID",
        `extension ID ${entry.view.id} is used by two extensions`,
        entry.input.manifest.origin,
        "Give each extension a unique ID.",
        [existing.input.manifest.origin],
      );
    }
    byId.set(caseFoldKey(entry.view.id), entry);
    const where = pointerPath(entry.input.manifest.origin, "/framework_range");
    const range = entry.view.framework_range;
    if (!parseRange(range)) {
      out.error(
        "CONFIG_EXTENSION_RANGE_INVALID",
        `framework_range ${JSON.stringify(range)} is not supported`,
        where,
        'Use comparators such as ">=0.1.0 <0.2.0".',
      );
    } else if (!satisfiesRange(frameworkVersion, range)) {
      out.error(
        "CONFIG_EXTENSION_INCOMPATIBLE",
        `extension ${entry.view.id} supports framework ${range}, not ${frameworkVersion}`,
        where,
        "Use an extension version built for this framework version.",
      );
    }
  }
  for (const entry of entries) {
    // Dependencies name exact IDs (design doc 06); a case variant is a missing dependency.
    for (const required of entry.view.requires.filter((id) => byId.get(caseFoldKey(id))?.view.id !== id)) {
      out.error(
        "CONFIG_EXTENSION_DEPENDENCY_MISSING",
        `extension ${entry.view.id} requires ${required}, which is not loaded`,
        pointerPath(entry.input.manifest.origin, "/requires"),
        "Add the required extension to extension_paths and the lock.",
      );
    }
  }
  if (out.failed) return null;
  const order = topologicalOrder(entries.map((entry) => entry.view));
  if (!order) {
    out.error(
      "CONFIG_EXTENSION_CYCLE",
      "extensions require each other in a cycle",
      appPath,
      "Remove the circular requires entries.",
      entries.map((entry) => `${entry.view.id} requires ${entry.view.requires.join(", ") || "nothing"}`),
    );
    return null;
  }
  return new Map(order.map((id) => [id, byId.get(caseFoldKey(id)) as ExtensionEntry]));
}

/** Registers the release's built-in definitions. */
function registerCore(release: ReleaseInput, manifest: ReleaseManifest, registries: Registries, out: Findings): void {
  const origin = release.manifest.origin;
  for (const type of manifest.artifact_types) {
    register(registries.artifactTypes, type, { id: type, origin: release.manifest }, "artifact type", origin, out);
  }
  for (const rule of manifest.core_rule_ids) register(registries.ruleIds, rule, rule, "rule", origin, out);
  for (const document of release.workflows) {
    const view = document.value as WorkflowView;
    register(registries.workflows, view.id, { document, view }, "workflow", document.origin, out);
  }
  for (const document of release.templates) {
    const view = document.value as TemplateView;
    if (register(registries.templates, view.id, { document, view }, "template", document.origin, out)) {
      registries.templateTypes.set(caseFoldKey(view.id), {
        id: view.id,
        artifactType: view.artifact_type,
        path: document.origin,
      });
      if (!registries.coreTemplateByType.has(view.artifact_type))
        registries.coreTemplateByType.set(view.artifact_type, view);
    }
  }
}

/** Registers one extension template: a descriptor joins `templates`; a Markdown template is only selectable. */
function registerExtensionTemplate(
  resource: ExtensionResource,
  descriptor: SourceDocument | undefined,
  where: string,
  registries: Registries,
  out: Findings,
): void {
  if (!descriptor) {
    if (resource.artifact_type === undefined) {
      out.error(
        "CONFIG_EXTENSION_TEMPLATE_TYPE",
        `template ${resource.id} doesn't name an artifact type`,
        where,
        "Add artifact_type to the template resource.",
      );
      return;
    }
    // Its headings are checked by the rule engine (B07), which parses Markdown.
    const entry = { id: resource.id, artifactType: resource.artifact_type, path: where };
    register(registries.templateTypes, resource.id, entry, "template", where, out);
    return;
  }
  const template = descriptor.value as TemplateView;
  if (template.id !== resource.id) {
    out.error(
      "CONFIG_EXTENSION_RESOURCE_ID",
      `template descriptor ID ${template.id} differs from resource ID ${resource.id}`,
      where,
      "Use the same ID in both places.",
    );
  }
  if (resource.artifact_type !== undefined && resource.artifact_type !== template.artifact_type) {
    out.error(
      "CONFIG_EXTENSION_RESOURCE_ID",
      `template ${resource.id} names two different artifact types`,
      where,
      "Use the same artifact type in the manifest and the descriptor.",
    );
  }
  if (register(registries.templates, template.id, { document: descriptor, view: template }, "template", where, out)) {
    registries.templateTypes.set(caseFoldKey(template.id), {
      id: template.id,
      artifactType: template.artifact_type,
      path: where,
    });
  }
}

/** Registers one extension's resources and rules. */
function registerExtension({ input: extension, view }: ExtensionEntry, registries: Registries, out: Findings): void {
  const origin = extension.manifest.origin;
  for (const [index, resource] of view.resources.entries()) {
    const where = pointerPath(origin, `/resources/${index}`);
    register(registries.resourceIds, resource.id, resource.id, "extension resource", where, out);
    const descriptor = extension.descriptors.get(resource.id);
    if (resource.kind === "artifact_type") {
      register(
        registries.artifactTypes,
        resource.id,
        { id: resource.id, origin: extension.manifest },
        "artifact type",
        where,
        out,
      );
    } else if (resource.kind === "workflow" && descriptor) {
      const workflow = descriptor.value as WorkflowView;
      if (workflow.id !== resource.id) {
        out.error(
          "CONFIG_EXTENSION_RESOURCE_ID",
          `workflow descriptor ID ${workflow.id} differs from resource ID ${resource.id}`,
          where,
          "Use the same ID in both places.",
        );
      }
      register(registries.workflows, workflow.id, { document: descriptor, view: workflow }, "workflow", where, out);
    } else if (resource.kind === "template") {
      registerExtensionTemplate(resource, descriptor, where, registries, out);
    }
  }
  for (const [index, rule] of view.rules.entries()) {
    register(registries.ruleIds, rule.id, rule.id, "rule", pointerPath(origin, `/rules/${index}`), out);
  }
}

/** Step 4: registries. */
function buildRegistries(
  input: ResolveInput,
  manifest: ReleaseManifest,
  ordered: ReadonlyMap<string, ExtensionEntry>,
  out: Findings,
): Registries {
  const registries: Registries = {
    artifactTypes: new Map(),
    ruleIds: new Map(),
    workflows: new Map(),
    templates: new Map(),
    templateTypes: new Map(),
    resourceIds: new Map(),
    coreTemplateByType: new Map(),
  };
  registerCore(input.release, manifest, registries, out);
  for (const entry of ordered.values()) registerExtension(entry, registries, out);
  return registries;
}

/** Step 5a: templates and extension rules name registered artifact types. */
function checkRegisteredTypes(entries: readonly ExtensionEntry[], registries: Registries, out: Findings): void {
  for (const template of registries.templateTypes.values()) {
    if (!knownType(registries, template.artifactType)) {
      out.error(
        "CONFIG_UNKNOWN_ARTIFACT_TYPE",
        `template ${template.id} is for unknown artifact type ${template.artifactType}`,
        template.path,
        "Register the artifact type, or fix the template.",
      );
    }
  }
  for (const entry of entries) {
    for (const [index, rule] of entry.view.rules.entries()) {
      if (knownType(registries, rule.artifact_type)) continue;
      out.error(
        "CONFIG_UNKNOWN_ARTIFACT_TYPE",
        `rule ${rule.id} is for unknown artifact type ${rule.artifact_type}`,
        pointerPath(entry.input.manifest.origin, `/rules/${index}/artifact_type`),
        "Register the artifact type, or fix the rule.",
      );
    }
  }
}

/** Step 5b: repositories and capabilities are unique; the design repository is one of them. */
function checkRepositoriesAndCapabilities(application: ApplicationView, appPath: string, out: Findings): Set<string> {
  const repositoryIds = new Set<string>();
  for (const [index, repository] of application.repositories.entries()) {
    if (repositoryIds.has(caseFoldKey(repository.id))) {
      out.error(
        "CONFIG_DUPLICATE_ID",
        `repository ${repository.id} is listed twice`,
        pointerPath(appPath, `/repositories/${index}/id`),
        "Give each repository a unique ID.",
      );
    }
    repositoryIds.add(caseFoldKey(repository.id));
  }
  if (!application.repositories.some((repository) => repository.id === application.design_repository_id)) {
    out.error(
      "CONFIG_DESIGN_REPOSITORY",
      `design_repository_id ${application.design_repository_id} doesn't match a configured repository`,
      pointerPath(appPath, "/design_repository_id"),
      "Use the ID of the repository that holds the design artifacts.",
    );
  }
  const capabilityIds = new Set<string>();
  for (const [index, capability] of application.capabilities.entries()) {
    if (capabilityIds.has(capability.id)) {
      out.error(
        "CONFIG_DUPLICATE_ID",
        `capability ${capability.id} is listed twice`,
        pointerPath(appPath, `/capabilities/${index}/id`),
        "Give each capability a unique ID.",
      );
    }
    capabilityIds.add(capability.id);
  }
  return capabilityIds;
}

/** Step 5c: review roles and required artifact types resolve (design doc 16). */
function checkPolicy(application: ApplicationView, appPath: string, registries: Registries, out: Findings): void {
  const roles = new Set(Object.keys(application.reviewer_roles));
  for (const [index, role] of application.required_review_roles.entries()) {
    if (roles.has(role)) continue;
    out.error(
      "CONFIG_REVIEW_ROLE_UNKNOWN",
      `required review role ${role} is not defined in reviewer_roles`,
      pointerPath(appPath, `/required_review_roles/${index}`),
      "Define the role in reviewer_roles, or remove the requirement.",
    );
  }
  for (const [index, type] of (application.required_artifact_types ?? []).entries()) {
    if (knownType(registries, type)) continue;
    out.error(
      "CONFIG_UNKNOWN_ARTIFACT_TYPE",
      `required artifact type ${type} is not registered`,
      pointerPath(appPath, `/required_artifact_types/${index}`),
      "Use a registered artifact type.",
    );
  }
}

/** Step 5d: the default workflow and every template selection resolve. */
function checkSelections(application: ApplicationView, appPath: string, registries: Registries, out: Findings): void {
  if (registries.workflows.get(caseFoldKey(application.default_workflow))?.view.id !== application.default_workflow) {
    out.error(
      "CONFIG_UNKNOWN_WORKFLOW",
      `default workflow ${application.default_workflow} is not registered`,
      pointerPath(appPath, "/default_workflow"),
      "Use a core workflow or one an extension registers.",
    );
  }
  for (const [type, templateId] of Object.entries(application.template_selections)) {
    const where = pointerPath(appPath, `/template_selections/${pointerToken(type)}`);
    const template = registries.templateTypes.get(caseFoldKey(templateId));
    if (!knownType(registries, type)) {
      out.error(
        "CONFIG_UNKNOWN_ARTIFACT_TYPE",
        `template selection for unknown artifact type ${type}`,
        where,
        "Select templates for registered artifact types only.",
      );
    } else if (template?.id !== templateId) {
      out.error(
        "CONFIG_UNKNOWN_TEMPLATE",
        `selected template ${templateId} is not registered`,
        where,
        "Select a core template or one an extension registers.",
      );
    } else if (template.artifactType !== type) {
      out.error(
        "CONFIG_TEMPLATE_TYPE_MISMATCH",
        `template ${templateId} is for ${template.artifactType}, not ${type}`,
        where,
        "Select a template for the same artifact type.",
      );
    } else {
      checkRequiredSections(templateId, type, where, registries, out);
    }
  }
}

/**
 * A selected template descriptor keeps every section the core template requires (design doc 06).
 * Markdown templates without a descriptor are checked by the rule engine (B07), which parses headings.
 */
function checkRequiredSections(
  templateId: string,
  type: string,
  where: string,
  registries: Registries,
  out: Findings,
): void {
  const selected = registries.templates.get(caseFoldKey(templateId))?.view;
  const core = registries.coreTemplateByType.get(type);
  if (!selected || !core || selected.id === core.id) return;
  const present = new Set(selected.sections.filter((section) => section.required).map((section) => section.heading));
  const missing = core.sections.filter((section) => section.required && !present.has(section.heading));
  if (missing.length === 0) return;
  out.error(
    "CONFIG_TEMPLATE_MISSING_SECTIONS",
    `template ${templateId} drops sections the core ${type} template requires`,
    where,
    "Keep every core-required section, marked required, in the extension's template.",
    missing.map((section) => section.heading),
  );
}

type WorkflowStep = WorkflowView["steps"][number];

interface StepContext {
  workflowId: string;
  steps: ReadonlyMap<string, WorkflowStep>;
  registries: Registries;
  capabilityIds: ReadonlySet<string>;
  roles: ReadonlySet<string>;
}

/** One step's references: predecessors, outputs, rules, capabilities and reviewer roles. */
function checkStep(step: WorkflowStep, where: (field: string) => string, context: StepContext, out: Findings): void {
  for (const predecessor of step.after.filter((id) => !context.steps.has(id))) {
    out.error(
      "CONFIG_WORKFLOW_INVALID",
      `step ${step.id} comes after unknown step ${predecessor}`,
      where("after"),
      "Name existing steps only.",
    );
  }
  for (const output of step.required_outputs) {
    if (BUILT_IN_OUTPUT_KINDS.includes(output) || knownType(context.registries, output)) continue;
    out.error(
      "CONFIG_UNKNOWN_ARTIFACT_TYPE",
      `step ${step.id} requires unknown output ${output}`,
      where("required_outputs"),
      "Use a registered artifact type, baseline or handoff.",
    );
  }
  for (const rule of step.blocking_rules.filter((id) => context.registries.ruleIds.get(caseFoldKey(id)) !== id)) {
    out.error(
      "CONFIG_UNKNOWN_RULE",
      `step ${step.id} names unknown rule ${rule}`,
      where("blocking_rules"),
      "Use a core rule or one an extension adds.",
    );
  }
  for (const capability of step.capabilities.filter((id) => !context.capabilityIds.has(id))) {
    out.error(
      "CONFIG_UNKNOWN_CAPABILITY",
      `step ${step.id} of workflow ${context.workflowId} uses capability ${capability}, which the application doesn't define`,
      where("capabilities"),
      "Define the capability in the application profile.",
    );
  }
  for (const role of step.reviewer_roles.filter((id) => !context.roles.has(id))) {
    out.error(
      "CONFIG_REVIEW_ROLE_UNKNOWN",
      `step ${step.id} names undefined reviewer role ${role}`,
      where("reviewer_roles"),
      "Define the role in reviewer_roles.",
    );
  }
}

/** True when `after` edges form a cycle. */
function hasStepCycle(steps: ReadonlyMap<string, WorkflowStep>): boolean {
  // Kahn's algorithm: repeatedly remove steps with no remaining predecessors. Iterative, so a long
  // chain of steps can't overflow the stack.
  const remaining = new Map<string, number>();
  const followers = new Map<string, string[]>();
  for (const [id, step] of steps) {
    const known = [...new Set(step.after)].filter((predecessor) => steps.has(predecessor));
    remaining.set(id, known.length);
    for (const predecessor of known) followers.set(predecessor, [...(followers.get(predecessor) ?? []), id]);
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  let removed = 0;
  while (ready.length > 0) {
    const id = ready.pop() as string;
    removed++;
    for (const follower of followers.get(id) ?? []) {
      const count = (remaining.get(follower) as number) - 1;
      remaining.set(follower, count);
      if (count === 0) ready.push(follower);
    }
  }
  return removed < steps.size;
}

/** Step 6: workflow graphs (design doc 16): unique steps, known references, acyclic. */
function checkWorkflows(
  application: ApplicationView,
  registries: Registries,
  capabilityIds: ReadonlySet<string>,
  out: Findings,
): void {
  const roles = new Set(Object.keys(application.reviewer_roles));
  for (const { document, view } of registries.workflows.values()) {
    const steps = new Map<string, WorkflowStep>();
    for (const [index, step] of view.steps.entries()) {
      if (steps.has(step.id)) {
        out.error(
          "CONFIG_WORKFLOW_INVALID",
          `workflow ${view.id} has two steps named ${step.id}`,
          pointerPath(document.origin, `/steps/${index}`),
          "Give each step a unique ID.",
        );
      }
      steps.set(step.id, step);
    }
    const context: StepContext = { workflowId: view.id, steps, registries, capabilityIds, roles };
    for (const [index, step] of view.steps.entries()) {
      checkStep(step, (field) => pointerPath(document.origin, `/steps/${index}/${field}`), context, out);
    }
    if (hasStepCycle(steps)) {
      out.error(
        "CONFIG_WORKFLOW_INVALID",
        `workflow ${view.id} has a cycle in its steps`,
        document.origin,
        "Remove the circular after entries.",
      );
    }
  }
}

/** Step 7: the envelope. Registries are ordered by ID; application arrays keep their order. */
function buildEnvelope(
  input: ResolveInput,
  manifest: ReleaseManifest,
  registries: Registries,
  entries: readonly ExtensionEntry[],
): EffectiveConfigEnvelope {
  const byId = <T extends { id: string }>(a: T, b: T): number => compareCodePoints(a.id, b.id);
  const provenance: ProvenanceEntry[] = [];
  const trace = (pointer: string, document: SourceDocument): void => {
    provenance.push({ pointer, origin: document.origin, sha256: document.sha256 });
  };

  const typeList = [...registries.artifactTypes.values()].sort(byId);
  const ruleList = manifest.core_rule_ids.slice().sort(compareCodePoints);
  const workflowList = [...registries.workflows.values()].sort((a, b) => byId(a.view, b.view));
  const templateList = [...registries.templates.values()].sort((a, b) => byId(a.view, b.view));
  const extensionList = entries.slice().sort((a, b) => byId(a.view, b.view));

  trace("/application", input.application);
  trace("/framework_lock", input.lock);
  for (const [index, type] of typeList.entries()) trace(`/artifact_types/${index}`, type.origin);
  for (const index of ruleList.keys()) trace(`/core_rule_ids/${index}`, input.release.manifest);
  for (const [index, workflow] of workflowList.entries()) trace(`/workflows/${index}`, workflow.document);
  for (const [index, template] of templateList.entries()) trace(`/templates/${index}`, template.document);
  if (extensionList.length === 0) trace("/extensions", input.application);
  for (const [index, extension] of extensionList.entries()) trace(`/extensions/${index}`, extension.input.manifest);

  const configuration: EffectiveConfiguration = structuredClone({
    application: input.application.value as JsonObject,
    framework_lock: input.lock.value as JsonObject,
    artifact_types: typeList.map((type) => type.id),
    core_rule_ids: ruleList,
    workflows: workflowList.map((workflow) => workflow.document.value as JsonObject),
    templates: templateList.map((template) => template.document.value as JsonObject),
    extensions: extensionList.map((extension) => extension.input.manifest.value as JsonObject),
  });
  return { schema_version: EFFECTIVE_CONFIG_SCHEMA_VERSION, configuration, provenance };
}

/** Resolves the effective configuration. Never throws for bad input; problems become diagnostics. */
export function resolveEffectiveConfig(input: ResolveInput): ResolveResult {
  const out = new Findings();
  const fail = (lock: LockReport | null): ResolveResult => ({
    envelope: null,
    digest: null,
    lock,
    diagnostics: out.all(),
  });

  const { manifest, applicationValid, lockValid } = checkInputs(input, out);
  if (applicationValid) checkExtensionPaths(input, out);
  const lock = lockValid && manifest ? compareLock(input, manifest.framework_version, out) : null;
  if (out.failed || !manifest || !applicationValid || !lockValid) return fail(lock);

  const application = input.application.value as ApplicationView;
  const appPath = input.application.origin;
  const entries = input.extensions.map((extension) => ({
    input: extension,
    view: extension.manifest.value as ExtensionView,
  }));
  const ordered = orderExtensions(entries, manifest.framework_version, appPath, out);
  if (!ordered) return fail(lock);

  const registries = buildRegistries(input, manifest, ordered, out);
  checkRegisteredTypes(entries, registries, out);
  const capabilityIds = checkRepositoriesAndCapabilities(application, appPath, out);
  checkPolicy(application, appPath, registries, out);
  checkSelections(application, appPath, registries, out);
  checkWorkflows(application, registries, capabilityIds, out);
  if (out.failed) return fail(lock);

  const envelope = buildEnvelope(input, manifest, registries, entries);
  const check = validateAgainstSchema("effective-config", envelope);
  if (!check.valid) {
    for (const issue of check.issues) {
      out.error(
        "CONFIG_INTERNAL",
        `resolved configuration is invalid: ${issue.message}`,
        issue.instancePath,
        "Report this as a defect.",
      );
    }
    return fail(lock);
  }
  let digest: string;
  try {
    digest = effectiveConfigDigest(envelope);
  } catch (error) {
    if (!(error instanceof CanonicalJsonError)) throw error;
    out.error(
      "CONFIG_NOT_CANONICAL",
      `the configuration can't be hashed with canonical-json-v1: ${error.message}`,
      input.application.origin,
      "Use integers, strings, booleans, null, arrays and objects only; write fractions as strings.",
    );
    return fail(lock);
  }
  return { envelope: deepFreeze(envelope), digest, lock, diagnostics: out.all() };
}
