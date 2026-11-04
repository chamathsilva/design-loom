#!/usr/bin/env node
/**
 * Process entry point: `node packages/cli/src/main.ts <command> --root <path> [--json]`.
 * The release build (B11) bundles this into the plugin's scripts/design-loom.cjs.
 */

import { join } from "node:path";
import { runCli } from "./run.ts";

// From source, the core resources sit in the config package. The bundled build (B11) ships them
// next to the script and sets the engine digest to the bundle's own SHA-256.
const releaseRoot = join(import.meta.dirname, "..", "..", "config", "resources", "core");

process.exitCode = await runCli(
  process.argv.slice(2),
  { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  { releaseRoot, engineSha256: null, nodeVersion: process.version, now: () => new Date() },
);
