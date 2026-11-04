/**
 * @design-loom/validation: Rule engine (DL001-DL016), template descriptors and diagnostics.
 * Pure logic. Backlog B07.
 */

export {
  compileAllSchemas,
  SCHEMA_KINDS,
  SCHEMA_NAMESPACE,
  type SchemaIssue,
  type SchemaKind,
  type SchemaValidationResult,
  schemaFor,
  schemaId,
  validateAgainstSchema,
} from "./schemas.ts";

export const PACKAGE_NAME = "@design-loom/validation";
