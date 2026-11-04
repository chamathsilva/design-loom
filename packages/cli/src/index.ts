/**
 * @design-loom/cli: Command surface, JSON result envelopes and exit codes for skills and CI.
 * Wires the other packages together. Backlogs B04 (config resolve, doctor) and B06.
 */

import { PACKAGE_NAME as artifacts } from "@design-loom/artifacts";
import { PACKAGE_NAME as baseline } from "@design-loom/baseline";
import { PACKAGE_NAME as config } from "@design-loom/config";
import { PACKAGE_NAME as handoff } from "@design-loom/handoff";
import { PACKAGE_NAME as integrations } from "@design-loom/integrations";
import { PACKAGE_NAME as validation } from "@design-loom/validation";
import { PACKAGE_NAME as workflow } from "@design-loom/workflow";

export { type CapabilityReport, type CapabilityState, doctor, WORKSPACE_PATH } from "./commands/doctor.ts";
export type { CliContext } from "./context.ts";
export { buildEnvelope, EXIT, type ExitCode, type ResultEnvelope, type RunStatus, worstExit } from "./envelope.ts";
export { type CliIo, runCli } from "./run.ts";

export const PACKAGE_NAME = "@design-loom/cli";

/** Workspace packages the CLI is assembled from, in design doc 02 order. */
export const COMPONENT_PACKAGES: readonly string[] = [
  config,
  artifacts,
  workflow,
  validation,
  baseline,
  handoff,
  integrations,
];
