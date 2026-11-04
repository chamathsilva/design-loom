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
import { canonicalDigest, compareCodePoints, type JsonValue } from "./canonical-json.ts";
import { type Diagnostic, diagnostic, hasErrors, pointerPath, pointerToken, sortDiagnostics } from "./diagnostics.ts";
import { caseFoldKey, normalizeRelativePath } from "./paths.ts";
import { parseRange, parseVersion, satisfiesRange } from "./version-range.ts";

export const EFFECTIVE_CONFIG_SCHEMA_VERSION = "1.0";

/** Output kinds that name framework objects, not artifact types (design doc 16). */
export const BUILT_IN_OUTPUT_KINDS: readonly string[] = ["baseline", "handoff"];

const ID = /^[A-Za-z][A-Za-z0-9._-]{1,79}$/;
const RULE_ID = /^DL[0-9]{3}$/;
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
  const files = new Map<string, string>();
  const add = (raw: unknown, where: string): void => {
    if (typeof raw !== "string") {
      problems.push(`${where} must be a string`);
      return;
    }
    try {
      const path = normalizeRelativePath(raw);
      if (path === "extension.json") problems.push(`${where} must not name the manifest itself`);
      files.set(caseFoldKey(path), path);
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
  return { files: [...files.values()].sort(compareCodePoints), problems };
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
// The resolver

/** Resolves the effective configuration. Never throws for bad input; problems become diagnostics. */
export function resolveEffectiveConfig(input: ResolveInput): ResolveResult {
  // Problems that stop resolution, and lock comparisons, which are reported but don't stop it.
  const diagnostics: Diagnostic[] = [];
  const lockDiagnostics: Diagnostic[] = [];
  const error = (code: string, message: string, path: string, remediation: string, evidence: string[] = []): void => {
    diagnostics.push(diagnostic(code, "error", message, { path, evidence, remediation }));
  };
  const lockError = (
    code: string,
    message: string,
    path: string,
    remediation: string,
    evidence: string[] = [],
  ): void => {
    lockDiagnostics.push(diagnostic(code, "error", message, { path, evidence, remediation }));
  };
  const fail = (lock: LockReport | null = null): ResolveResult => ({
    envelope: null,
    digest: null,
    lock,
    diagnostics: sortDiagnostics([...diagnostics, ...lockDiagnostics]),
  });

  const checkSchema = (kind: SchemaKind, document: SourceDocument): boolean => {
    const result = validateAgainstSchema(kind, document.value);
    for (const issue of result.issues) {
      error(
        "CONFIG_SCHEMA_INVALID",
        `${kind}: ${issue.message}`,
        pointerPath(document.origin, issue.instancePath),
        `Fix the file so it matches ${kind}.schema.json.`,
        [issue.schemaPath],
      );
    }
    return result.valid;
  };
  const checkDigest = (document: SourceDocument): void => {
    if (!SHA256.test(document.sha256)) {
      error(
        "CONFIG_INPUT_INVALID",
        "input digest is not a lower-case SHA-256",
        document.origin,
        "Report this as a defect.",
      );
    }
  };

  // 1. Structure: every input matches its contract.
  const { release } = input;
  const releaseCheck = checkReleaseManifest(release.manifest.value);
  for (const problem of releaseCheck.problems) {
    error(
      "CONFIG_RELEASE_INVALID",
      problem,
      release.manifest.origin,
      "Reinstall the plugin; its core resources are damaged.",
    );
  }
  const allDocuments = [
    release.manifest,
    ...release.workflows,
    ...release.templates,
    input.application,
    input.lock,
    ...input.extensions.flatMap((extension) => [extension.manifest, ...extension.descriptors.values()]),
  ];
  for (const document of allDocuments) checkDigest(document);
  for (const digest of [release.resourcesSha256, ...input.extensions.map((extension) => extension.resourcesSha256)]) {
    if (!SHA256.test(digest))
      error("CONFIG_INPUT_INVALID", "resource digest is not a lower-case SHA-256", "", "Report this as a defect.");
  }
  if (release.engineSha256 !== null && !SHA256.test(release.engineSha256)) {
    error("CONFIG_INPUT_INVALID", "engine digest is not a lower-case SHA-256", "", "Report this as a defect.");
  }

  const applicationValid = checkSchema("application", input.application);
  const lockValid = checkSchema("framework-lock", input.lock);
  for (const document of release.workflows) checkSchema("workflow", document);
  for (const document of release.templates) checkSchema("template", document);
  for (const extension of input.extensions) {
    if (!checkSchema("extension", extension.manifest)) continue;
    const view = extension.manifest.value as ExtensionView;
    for (const resource of view.resources) {
      const needsDescriptor =
        resource.kind === "workflow" || (resource.kind === "template" && isTemplateDescriptorPath(resource.path));
      const descriptor = extension.descriptors.get(resource.id);
      if (needsDescriptor && !descriptor) {
        error(
          "CONFIG_EXTENSION_RESOURCE_MISSING",
          `resource ${resource.id} was not loaded`,
          extension.manifest.origin,
          "Report this as a defect: the loader must parse every workflow and template descriptor.",
        );
      } else if (descriptor) {
        checkSchema(resource.kind === "workflow" ? "workflow" : "template", descriptor);
      }
    }
  }

  // 2. Lock: compare what the application pinned with what is actually running (design doc 03, "Lockfile").
  let lock: LockReport | null = null;
  const manifest = releaseCheck.manifest;
  if (lockValid && manifest) {
    const pinned = input.lock.value as LockView;
    const lockPath = input.lock.origin;
    const compare = (expected: string, actual: string | null): LockState =>
      actual === null ? "unknown" : expected === actual ? "match" : "mismatch";
    const frameworkState = compare(pinned.framework_version, manifest.framework_version);
    const engineState = compare(pinned.engine_sha256, release.engineSha256);
    const resourcesState = compare(pinned.resources_sha256, release.resourcesSha256);
    if (frameworkState === "mismatch") {
      lockError(
        "CONFIG_LOCK_FRAMEWORK_MISMATCH",
        `the lock pins framework ${pinned.framework_version} but ${manifest.framework_version} is running`,
        pointerPath(lockPath, "/framework_version"),
        "Install the pinned plugin version, or review and commit a lock update for the new one.",
        [`locked: ${pinned.framework_version}`, `running: ${manifest.framework_version}`],
      );
    }
    if (engineState === "mismatch") {
      lockError(
        "CONFIG_LOCK_ENGINE_MISMATCH",
        "the running engine differs from the locked engine",
        pointerPath(lockPath, "/engine_sha256"),
        "Install the pinned plugin build, or review and commit a lock update for this one.",
        [`locked: ${pinned.engine_sha256}`, `running: ${release.engineSha256}`],
      );
    } else if (engineState === "unknown") {
      lockDiagnostics.push(
        diagnostic(
          "CONFIG_LOCK_ENGINE_UNKNOWN",
          "warning",
          "the running engine has no digest to compare with the lock",
          {
            path: pointerPath(lockPath, "/engine_sha256"),
            evidence: ["running from source, not from a built plugin"],
            remediation: "Run a built plugin to verify the engine. Certified commands refuse to run until it matches.",
          },
        ),
      );
    }
    if (resourcesState === "mismatch") {
      lockError(
        "CONFIG_LOCK_RESOURCES_MISMATCH",
        "the running core resources differ from the locked resources",
        pointerPath(lockPath, "/resources_sha256"),
        "Install the pinned plugin build, or review and commit a lock update for this one.",
        [`locked: ${pinned.resources_sha256}`, `running: ${release.resourcesSha256}`],
      );
    }

    let extensionsState: LockState = "match";
    const locked = new Map<string, { id: string; version: string; sha256: string }>();
    pinned.extensions_locked.forEach((tuple, index) => {
      if (locked.has(caseFoldKey(tuple.id))) {
        extensionsState = "mismatch";
        lockError(
          "CONFIG_LOCK_DUPLICATE_EXTENSION",
          `the lock lists extension ${tuple.id} twice`,
          pointerPath(lockPath, `/extensions_locked/${index}`),
          "Keep one entry per extension.",
        );
      }
      locked.set(caseFoldKey(tuple.id), tuple);
    });
    const loaded = new Set<string>();
    for (const extension of input.extensions) {
      const view = extension.manifest.value as Partial<ExtensionView>;
      if (typeof view.id !== "string") continue;
      loaded.add(caseFoldKey(view.id));
      const tuple = locked.get(caseFoldKey(view.id));
      const where = extension.manifest.origin;
      if (!tuple) {
        extensionsState = "mismatch";
        lockError(
          "CONFIG_EXTENSION_NOT_LOCKED",
          `extension ${view.id} is not in the lock`,
          where,
          "Review the extension, then add its ID, version and digest to the lock.",
          [`digest: ${extension.resourcesSha256}`],
        );
        continue;
      }
      if (tuple.id !== view.id || tuple.version !== view.version || tuple.sha256 !== extension.resourcesSha256) {
        extensionsState = "mismatch";
        lockError(
          "CONFIG_EXTENSION_LOCK_MISMATCH",
          `extension ${view.id} differs from its lock entry`,
          where,
          "Restore the reviewed extension files, or review the change and update the lock entry.",
          [
            `locked: ${tuple.id} ${tuple.version} ${tuple.sha256}`,
            `found: ${view.id} ${String(view.version)} ${extension.resourcesSha256}`,
          ],
        );
      }
    }
    for (const [key, tuple] of locked) {
      if (!loaded.has(key)) {
        extensionsState = "mismatch";
        lockError(
          "CONFIG_EXTENSION_LOCK_UNUSED",
          `the lock pins extension ${tuple.id}, but the application doesn't load it`,
          lockPath,
          "Add the extension's folder to extension_paths, or remove it from the lock in a reviewed change.",
        );
      }
    }
    lock = {
      ok: [frameworkState, engineState, resourcesState, extensionsState].every((state) => state === "match"),
      framework_version: frameworkState,
      engine: engineState,
      resources: resourcesState,
      extensions: extensionsState,
    };
  }

  if (hasErrors(diagnostics) || !manifest || !applicationValid || !lockValid) return fail(lock);

  const application = input.application.value as ApplicationView;
  const appPath = input.application.origin;

  // 3. Extensions: unique IDs, compatible framework range, dependencies present and acyclic.
  const extensionViews = input.extensions.map((extension) => ({
    input: extension,
    view: extension.manifest.value as ExtensionView,
  }));
  const extensionById = new Map<string, (typeof extensionViews)[number]>();
  for (const entry of extensionViews) {
    const key = caseFoldKey(entry.view.id);
    const existing = extensionById.get(key);
    if (existing) {
      error(
        "CONFIG_DUPLICATE_ID",
        `extension ID ${entry.view.id} is used by two extensions`,
        entry.input.manifest.origin,
        "Give each extension a unique ID.",
        [existing.input.manifest.origin],
      );
    }
    extensionById.set(key, entry);
    const range = entry.view.framework_range;
    if (!parseRange(range)) {
      error(
        "CONFIG_EXTENSION_RANGE_INVALID",
        `framework_range ${JSON.stringify(range)} is not supported`,
        pointerPath(entry.input.manifest.origin, "/framework_range"),
        'Use comparators such as ">=0.1.0 <0.2.0".',
      );
    } else if (!satisfiesRange(manifest.framework_version, range)) {
      error(
        "CONFIG_EXTENSION_INCOMPATIBLE",
        `extension ${entry.view.id} supports framework ${range}, not ${manifest.framework_version}`,
        pointerPath(entry.input.manifest.origin, "/framework_range"),
        "Use an extension version built for this framework version.",
      );
    }
  }
  for (const entry of extensionViews) {
    for (const required of entry.view.requires) {
      if (!extensionById.has(caseFoldKey(required))) {
        error(
          "CONFIG_EXTENSION_DEPENDENCY_MISSING",
          `extension ${entry.view.id} requires ${required}, which is not loaded`,
          pointerPath(entry.input.manifest.origin, "/requires"),
          "Add the required extension to extension_paths and the lock.",
        );
      }
    }
  }
  if (hasErrors(diagnostics)) return fail(lock);
  const order = topologicalOrder(extensionViews.map((entry) => entry.view));
  if (!order) {
    error(
      "CONFIG_EXTENSION_CYCLE",
      "extensions require each other in a cycle",
      appPath,
      "Remove the circular requires entries.",
      extensionViews.map((entry) => `${entry.view.id} requires ${entry.view.requires.join(", ") || "nothing"}`),
    );
    return fail(lock);
  }

  // 4. Registries. IDs are unique ignoring case; there is no override (design doc 06).
  const artifactTypes = new Map<string, { id: string; origin: SourceDocument }>();
  const ruleIds = new Map<string, string>();
  const workflows = new Map<string, { document: SourceDocument; view: WorkflowView }>();
  const templates = new Map<string, { document: SourceDocument; view: TemplateView }>();
  /** Every selectable template, including extension Markdown templates that have no descriptor. */
  const templateTypes = new Map<string, { id: string; artifactType: string; path: string }>();
  const resourceIds = new Map<string, string>();

  const register = <T>(registry: Map<string, T>, id: string, value: T, label: string, path: string): boolean => {
    if (registry.has(caseFoldKey(id))) {
      error(
        "CONFIG_DUPLICATE_ID",
        `${label} ${id} is defined twice`,
        path,
        `Rename one of the ${label}s; nothing can override another.`,
      );
      return false;
    }
    registry.set(caseFoldKey(id), value);
    return true;
  };

  for (const type of manifest.artifact_types)
    register(artifactTypes, type, { id: type, origin: release.manifest }, "artifact type", release.manifest.origin);
  for (const rule of manifest.core_rule_ids) register(ruleIds, rule, rule, "rule", release.manifest.origin);
  for (const document of release.workflows) {
    const view = document.value as WorkflowView;
    register(workflows, view.id, { document, view }, "workflow", document.origin);
  }
  for (const document of release.templates) {
    const view = document.value as TemplateView;
    if (register(templates, view.id, { document, view }, "template", document.origin)) {
      templateTypes.set(caseFoldKey(view.id), { id: view.id, artifactType: view.artifact_type, path: document.origin });
    }
  }

  for (const id of order) {
    const entry = extensionById.get(caseFoldKey(id));
    if (!entry) continue;
    const { input: extension, view } = entry;
    const origin = extension.manifest.origin;
    view.resources.forEach((resource, index) => {
      const where = pointerPath(origin, `/resources/${index}`);
      register(resourceIds, resource.id, resource.id, "extension resource", where);
      const descriptor = extension.descriptors.get(resource.id);
      if (resource.kind === "artifact_type") {
        register(artifactTypes, resource.id, { id: resource.id, origin: extension.manifest }, "artifact type", where);
      } else if (resource.kind === "workflow" && descriptor) {
        const workflow = descriptor.value as WorkflowView;
        if (workflow.id !== resource.id) {
          error(
            "CONFIG_EXTENSION_RESOURCE_ID",
            `workflow descriptor ID ${workflow.id} differs from resource ID ${resource.id}`,
            where,
            "Use the same ID in both places.",
          );
        }
        register(workflows, workflow.id, { document: descriptor, view: workflow }, "workflow", where);
      } else if (resource.kind === "template") {
        if (descriptor) {
          // A template descriptor joins the `templates` registry.
          const template = descriptor.value as TemplateView;
          if (template.id !== resource.id) {
            error(
              "CONFIG_EXTENSION_RESOURCE_ID",
              `template descriptor ID ${template.id} differs from resource ID ${resource.id}`,
              where,
              "Use the same ID in both places.",
            );
          }
          if (resource.artifact_type !== undefined && resource.artifact_type !== template.artifact_type) {
            error(
              "CONFIG_EXTENSION_RESOURCE_ID",
              `template ${resource.id} names two different artifact types`,
              where,
              "Use the same artifact type in the manifest and the descriptor.",
            );
          }
          if (register(templates, template.id, { document: descriptor, view: template }, "template", where)) {
            templateTypes.set(caseFoldKey(template.id), {
              id: template.id,
              artifactType: template.artifact_type,
              path: where,
            });
          }
        } else if (resource.artifact_type === undefined) {
          error(
            "CONFIG_EXTENSION_TEMPLATE_TYPE",
            `template ${resource.id} doesn't name an artifact type`,
            where,
            "Add artifact_type to the template resource.",
          );
        } else {
          // A Markdown template has no descriptor; it is selectable, and stays in its extension's manifest.
          // Its headings are checked by the rule engine (B07), which parses Markdown.
          register(
            templateTypes,
            resource.id,
            { id: resource.id, artifactType: resource.artifact_type, path: where },
            "template",
            where,
          );
        }
      }
    });
    view.rules.forEach((rule, index) => {
      register(ruleIds, rule.id, rule.id, "rule", pointerPath(origin, `/rules/${index}`));
    });
  }

  // 5. References between registries and from the application.
  const knownType = (type: string): boolean => artifactTypes.get(caseFoldKey(type))?.id === type;
  for (const [, template] of templateTypes) {
    if (!knownType(template.artifactType)) {
      error(
        "CONFIG_UNKNOWN_ARTIFACT_TYPE",
        `template ${template.id} is for unknown artifact type ${template.artifactType}`,
        template.path,
        "Register the artifact type, or fix the template.",
      );
    }
  }
  for (const entry of extensionViews) {
    entry.view.rules.forEach((rule, index) => {
      if (!knownType(rule.artifact_type)) {
        error(
          "CONFIG_UNKNOWN_ARTIFACT_TYPE",
          `rule ${rule.id} is for unknown artifact type ${rule.artifact_type}`,
          pointerPath(entry.input.manifest.origin, `/rules/${index}/artifact_type`),
          "Register the artifact type, or fix the rule.",
        );
      }
    });
  }

  const repositoryIds = new Map<string, number>();
  application.repositories.forEach((repository, index) => {
    const key = caseFoldKey(repository.id);
    if (repositoryIds.has(key)) {
      error(
        "CONFIG_DUPLICATE_ID",
        `repository ${repository.id} is listed twice`,
        pointerPath(appPath, `/repositories/${index}/id`),
        "Give each repository a unique ID.",
      );
    }
    repositoryIds.set(key, (repositoryIds.get(key) ?? 0) + 1);
  });
  if (!application.repositories.some((repository) => repository.id === application.design_repository_id)) {
    error(
      "CONFIG_DESIGN_REPOSITORY",
      `design_repository_id ${application.design_repository_id} doesn't match a configured repository`,
      pointerPath(appPath, "/design_repository_id"),
      "Use the ID of the repository that holds the design artifacts.",
    );
  }
  const capabilityIds = new Set<string>();
  application.capabilities.forEach((capability, index) => {
    if (capabilityIds.has(capability.id)) {
      error(
        "CONFIG_DUPLICATE_ID",
        `capability ${capability.id} is listed twice`,
        pointerPath(appPath, `/capabilities/${index}/id`),
        "Give each capability a unique ID.",
      );
    }
    capabilityIds.add(capability.id);
  });
  const roles = new Set(Object.keys(application.reviewer_roles));
  application.required_review_roles.forEach((role, index) => {
    if (!roles.has(role)) {
      error(
        "CONFIG_REVIEW_ROLE_UNKNOWN",
        `required review role ${role} is not defined in reviewer_roles`,
        pointerPath(appPath, `/required_review_roles/${index}`),
        "Define the role in reviewer_roles, or remove the requirement.",
      );
    }
  });
  (application.required_artifact_types ?? []).forEach((type, index) => {
    if (!knownType(type)) {
      error(
        "CONFIG_UNKNOWN_ARTIFACT_TYPE",
        `required artifact type ${type} is not registered`,
        pointerPath(appPath, `/required_artifact_types/${index}`),
        "Use a registered artifact type.",
      );
    }
  });
  if (workflows.get(caseFoldKey(application.default_workflow))?.view.id !== application.default_workflow) {
    error(
      "CONFIG_UNKNOWN_WORKFLOW",
      `default workflow ${application.default_workflow} is not registered`,
      pointerPath(appPath, "/default_workflow"),
      "Use a core workflow or one an extension registers.",
    );
  }
  for (const [type, templateId] of Object.entries(application.template_selections)) {
    const where = pointerPath(appPath, `/template_selections/${pointerToken(type)}`);
    const template = templateTypes.get(caseFoldKey(templateId));
    if (!knownType(type)) {
      error(
        "CONFIG_UNKNOWN_ARTIFACT_TYPE",
        `template selection for unknown artifact type ${type}`,
        where,
        "Select templates for registered artifact types only.",
      );
    } else if (!template || template.id !== templateId) {
      error(
        "CONFIG_UNKNOWN_TEMPLATE",
        `selected template ${templateId} is not registered`,
        where,
        "Select a core template or one an extension registers.",
      );
    } else if (template.artifactType !== type) {
      error(
        "CONFIG_TEMPLATE_TYPE_MISMATCH",
        `template ${templateId} is for ${template.artifactType}, not ${type}`,
        where,
        "Select a template for the same artifact type.",
      );
    }
  }

  // 6. Workflow graphs (design doc 16): unique steps, known predecessors, acyclic, resolvable references.
  for (const [, { document, view }] of workflows) {
    const steps = new Map<string, (typeof view.steps)[number]>();
    view.steps.forEach((step, index) => {
      const where = pointerPath(document.origin, `/steps/${index}`);
      if (steps.has(step.id))
        error(
          "CONFIG_WORKFLOW_INVALID",
          `workflow ${view.id} has two steps named ${step.id}`,
          where,
          "Give each step a unique ID.",
        );
      steps.set(step.id, step);
    });
    view.steps.forEach((step, index) => {
      const where = (field: string): string => pointerPath(document.origin, `/steps/${index}/${field}`);
      for (const predecessor of step.after) {
        if (!steps.has(predecessor)) {
          error(
            "CONFIG_WORKFLOW_INVALID",
            `step ${step.id} comes after unknown step ${predecessor}`,
            where("after"),
            "Name existing steps only.",
          );
        }
      }
      for (const output of step.required_outputs) {
        if (!BUILT_IN_OUTPUT_KINDS.includes(output) && !knownType(output)) {
          error(
            "CONFIG_UNKNOWN_ARTIFACT_TYPE",
            `step ${step.id} requires unknown output ${output}`,
            where("required_outputs"),
            "Use a registered artifact type, baseline or handoff.",
          );
        }
      }
      for (const rule of step.blocking_rules) {
        if (ruleIds.get(caseFoldKey(rule)) !== rule) {
          error(
            "CONFIG_UNKNOWN_RULE",
            `step ${step.id} names unknown rule ${rule}`,
            where("blocking_rules"),
            "Use a core rule or one an extension adds.",
          );
        }
      }
      for (const capability of step.capabilities) {
        if (!capabilityIds.has(capability)) {
          error(
            "CONFIG_UNKNOWN_CAPABILITY",
            `step ${step.id} of workflow ${view.id} uses capability ${capability}, which the application doesn't define`,
            where("capabilities"),
            "Define the capability in the application profile.",
          );
        }
      }
      for (const role of step.reviewer_roles) {
        if (!roles.has(role)) {
          error(
            "CONFIG_REVIEW_ROLE_UNKNOWN",
            `step ${step.id} names undefined reviewer role ${role}`,
            where("reviewer_roles"),
            "Define the role in reviewer_roles.",
          );
        }
      }
    });
    // Depth-first search for a cycle through `after` edges.
    const state = new Map<string, "visiting" | "done">();
    const visit = (id: string): boolean => {
      if (state.get(id) === "done") return false;
      if (state.get(id) === "visiting") return true;
      state.set(id, "visiting");
      const cyclic = (steps.get(id)?.after ?? []).some((next) => steps.has(next) && visit(next));
      state.set(id, "done");
      return cyclic;
    };
    if ([...steps.keys()].some((id) => visit(id))) {
      error(
        "CONFIG_WORKFLOW_INVALID",
        `workflow ${view.id} has a cycle in its steps`,
        document.origin,
        "Remove the circular after entries.",
      );
    }
  }

  if (hasErrors(diagnostics)) return fail(lock);

  // 7. Build the envelope. Registries are ordered by ID; application arrays keep their order.
  const byId = <T extends { id: string }>(a: T, b: T): number => compareCodePoints(a.id, b.id);
  const provenance: ProvenanceEntry[] = [];
  const trace = (pointer: string, document: SourceDocument): void => {
    provenance.push({ pointer, origin: document.origin, sha256: document.sha256 });
  };

  const typeList = [...artifactTypes.values()].sort(byId);
  const ruleList = manifest.core_rule_ids.slice().sort(compareCodePoints);
  const workflowList = [...workflows.values()].sort((a, b) => byId(a.view, b.view));
  const templateList = [...templates.values()].sort((a, b) => byId(a.view, b.view));
  const extensionList = extensionViews.slice().sort((a, b) => byId(a.view, b.view));

  trace("/application", input.application);
  trace("/framework_lock", input.lock);
  for (const [index, type] of typeList.entries()) trace(`/artifact_types/${index}`, type.origin);
  for (const index of ruleList.keys()) trace(`/core_rule_ids/${index}`, release.manifest);
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
  const envelope: EffectiveConfigEnvelope = {
    schema_version: EFFECTIVE_CONFIG_SCHEMA_VERSION,
    configuration,
    provenance,
  };

  const check = validateAgainstSchema("effective-config", envelope);
  if (!check.valid) {
    for (const issue of check.issues) {
      error(
        "CONFIG_INTERNAL",
        `resolved configuration is invalid: ${issue.message}`,
        issue.instancePath,
        "Report this as a defect.",
      );
    }
    return fail(lock);
  }

  return {
    envelope: deepFreeze(envelope),
    digest: effectiveConfigDigest(envelope),
    lock,
    diagnostics: sortDiagnostics([...diagnostics, ...lockDiagnostics]),
  };
}
