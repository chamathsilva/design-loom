/**
 * Framework JSON Schemas and structural validation (backlog B02; design docs 03 and 16).
 *
 * The 18 Draft 2020-12 schemas are bundled with the package and registered by their `$id`.
 * Nothing is fetched: a `$ref` to anything outside the bundled set fails to compile.
 * Results are sorted so the same input always yields the same diagnostics (DL-Q01).
 */

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import application from "../schemas/application.schema.json" with { type: "json" };
import approvalEvidence from "../schemas/approval-evidence.schema.json" with { type: "json" };
import artifact from "../schemas/artifact.schema.json" with { type: "json" };
import baseline from "../schemas/baseline.schema.json" with { type: "json" };
import change from "../schemas/change.schema.json" with { type: "json" };
import context from "../schemas/context.schema.json" with { type: "json" };
import effectiveConfig from "../schemas/effective-config.schema.json" with { type: "json" };
import extension from "../schemas/extension.schema.json" with { type: "json" };
import findings from "../schemas/findings.schema.json" with { type: "json" };
import frameworkLock from "../schemas/framework-lock.schema.json" with { type: "json" };
import handoff from "../schemas/handoff.schema.json" with { type: "json" };
import run from "../schemas/run.schema.json" with { type: "json" };
import source from "../schemas/source.schema.json" with { type: "json" };
import task from "../schemas/task.schema.json" with { type: "json" };
import template from "../schemas/template.schema.json" with { type: "json" };
import traceability from "../schemas/traceability.schema.json" with { type: "json" };
import workflow from "../schemas/workflow.schema.json" with { type: "json" };
import workspace from "../schemas/workspace.schema.json" with { type: "json" };

/** Namespace of the bundled schema IDs. Example identifiers, not live endpoints (design doc 16). */
export const SCHEMA_NAMESPACE = "https://design-loom.example/schemas/v1/";

/** Freezes a JSON value in place, so no caller can change a schema that Ajv has registered. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const SCHEMAS = deepFreeze({
  application,
  "approval-evidence": approvalEvidence,
  artifact,
  baseline,
  change,
  context,
  "effective-config": effectiveConfig,
  extension,
  findings,
  "framework-lock": frameworkLock,
  handoff,
  run,
  source,
  task,
  template,
  traceability,
  workflow,
  workspace,
} as const);

export type SchemaKind = keyof typeof SCHEMAS;

export const SCHEMA_KINDS: readonly SchemaKind[] = Object.keys(SCHEMAS).sort() as SchemaKind[];

export function schemaId(kind: SchemaKind): string {
  return `${SCHEMA_NAMESPACE}${kind}.schema.json`;
}

/** The bundled schema document for a kind. It is deeply frozen: changing it throws. */
export function schemaFor(kind: SchemaKind): Readonly<Record<string, unknown>> {
  return SCHEMAS[kind];
}

export interface SchemaIssue {
  /** JSON Pointer into the validated value, "" for the root. */
  instancePath: string;
  /**
   * Where the failing keyword lives: the $id of the schema that holds it, "#", then a JSON Pointer
   * into that schema. For example `https://design-loom.example/schemas/v1/change.schema.json#/properties/id/type`.
   * A failure inside a referenced schema names that schema's $id.
   */
  schemaPath: string;
  keyword: string;
  message: string;
  /**
   * Ajv's details for the keyword, with object keys sorted, for example
   * `{ additionalProperty: "extra" }` or `{ missingProperty: "id" }`.
   */
  params: Readonly<Record<string, unknown>>;
}

export interface SchemaValidationResult {
  valid: boolean;
  issues: SchemaIssue[];
}

// ajv-formats is CommonJS; depending on interop the function is the module or its default export.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (
  ajv: Ajv2020,
  formats: string[],
) => Ajv2020;

function createAjv(): Ajv2020 {
  // No loadSchema option: Ajv never fetches, so every $ref must resolve to a bundled schema.
  const ajv = new Ajv2020({
    // Strict checks that catch real schema mistakes: unknown keywords (typos), invalid numbers, tuples.
    strictSchema: true,
    strictNumbers: true,
    strictTuples: true,
    // Off: these Ajv-only lints reject valid JSON Schema used by the design's schemas, such as
    // `not: { anyOf: [{ required: [...] }] }` (artifact) and `contains` inside an `if` (context).
    strictRequired: false,
    strictTypes: false,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(ajv, ["date-time", "uri"]);
  for (const kind of SCHEMA_KINDS) {
    const schema = SCHEMAS[kind] as { $id?: string };
    if (schema.$id !== schemaId(kind)) {
      throw new Error(`bundled schema ${kind} has unexpected $id ${String(schema.$id)}`);
    }
    ajv.addSchema(SCHEMAS[kind]);
  }
  return ajv;
}

let ajvInstance: Ajv2020 | undefined;
const compiled = new Map<SchemaKind, ValidateFunction>();

function validatorFor(kind: SchemaKind): ValidateFunction {
  ajvInstance ??= createAjv();
  let validate = compiled.get(kind);
  if (validate === undefined) {
    validate = ajvInstance.getSchema(schemaId(kind));
    if (validate === undefined) throw new Error(`schema ${kind} failed to compile`);
    compiled.set(kind, validate);
  }
  return validate;
}

/** Compiles every bundled schema now, so a broken schema fails fast instead of on first use. */
export function compileAllSchemas(): void {
  for (const kind of SCHEMA_KINDS) validatorFor(kind);
}

const BUNDLED_IDS: readonly string[] = SCHEMA_KINDS.map(schemaId);

/**
 * Ajv reports "#/..." for the validated schema and "<$id>/..." for a referenced one. Both become
 * "<$id>#/...".
 */
function absoluteSchemaPath(kind: SchemaKind, path: string): string {
  if (path.startsWith("#")) return `${schemaId(kind)}${path}`;
  const id = BUNDLED_IDS.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
  if (id !== undefined) return `${id}#${path.slice(id.length)}`;
  return path;
}

/** A JSON copy of a value with object keys sorted, so equal values serialize identically. */
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedJson((value as Record<string, unknown>)[key]);
  return out;
}

function toIssue(kind: SchemaKind, error: ErrorObject): SchemaIssue {
  return {
    instancePath: error.instancePath,
    schemaPath: absoluteSchemaPath(kind, error.schemaPath),
    keyword: error.keyword,
    message: error.message ?? error.keyword,
    params: sortedJson(error.params) as Record<string, unknown>,
  };
}

function compareIssues(a: SchemaIssue, b: SchemaIssue): number {
  for (const key of ["instancePath", "keyword", "schemaPath", "message"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const [pa, pb] = [JSON.stringify(a.params), JSON.stringify(b.params)];
  return pa === pb ? 0 : pa < pb ? -1 : 1;
}

/**
 * Validates a value against a framework schema. Issues are de-duplicated and sorted; two issues
 * that differ only in their params (two unknown properties, say) are both kept.
 */
export function validateAgainstSchema(kind: SchemaKind, value: unknown): SchemaValidationResult {
  const validate = validatorFor(kind);
  const valid = validate(value) === true;
  const seen = new Set<string>();
  const issues = (validate.errors ?? [])
    .map((error) => toIssue(kind, error))
    .filter((issue) => {
      const key = JSON.stringify(issue);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareIssues);
  return { valid, issues };
}
