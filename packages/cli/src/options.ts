/** Command-line options shared by every command (design doc 07, "Command surface"). */

import { parseArgs } from "node:util";

export interface Options {
  root?: string;
  workflow?: string;
  json?: boolean;
  id?: string;
  title?: string;
  summary?: string;
  type?: string;
  content?: string;
  change?: string;
  scope?: string;
  step?: string;
  /** Options that can repeat are always arrays. */
  ownerRole: string[];
  requirement: string[];
  source: string[];
  repository: string[];
  exclude: string[];
  dependsOn: string[];
  coveredChange: string[];
  attachment: string[];
}

const SPEC = {
  root: { type: "string" },
  workflow: { type: "string" },
  json: { type: "boolean" },
  id: { type: "string" },
  title: { type: "string" },
  summary: { type: "string" },
  type: { type: "string" },
  content: { type: "string" },
  change: { type: "string" },
  scope: { type: "string" },
  step: { type: "string" },
  "owner-role": { type: "string", multiple: true },
  requirement: { type: "string", multiple: true },
  source: { type: "string", multiple: true },
  repository: { type: "string", multiple: true },
  exclude: { type: "string", multiple: true },
  "depends-on": { type: "string", multiple: true },
  "covered-change": { type: "string", multiple: true },
  attachment: { type: "string", multiple: true },
} as const;

const SINGLE = ["root", "workflow", "id", "title", "summary", "type", "content", "change", "scope", "step"] as const;

export interface Parsed {
  options: Options;
  positionals: string[];
}

/** Throws the parser's error for unknown options, missing values and the like. */
export function parseOptions(argv: readonly string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: SPEC,
    allowPositionals: true,
    strict: true,
  });
  const options: Options = {
    ownerRole: values["owner-role"] ?? [],
    requirement: values.requirement ?? [],
    source: values.source ?? [],
    repository: values.repository ?? [],
    exclude: values.exclude ?? [],
    dependsOn: values["depends-on"] ?? [],
    coveredChange: values["covered-change"] ?? [],
    attachment: values.attachment ?? [],
  };
  if (values.json !== undefined) options.json = values.json;
  for (const name of SINGLE) {
    const value = values[name];
    if (value !== undefined) options[name] = value;
  }
  return { options, positionals };
}

/** The options a run report records: everything except the root (reported separately) and --json. */
export function recordedOptions(options: Options): Record<string, string | boolean | null | string[]> {
  const recorded: Record<string, string | boolean | null | string[]> = { workflow: options.workflow ?? null };
  for (const name of SINGLE) {
    if (name !== "root" && name !== "workflow" && options[name] !== undefined) recorded[name] = options[name];
  }
  const lists = {
    owner_role: options.ownerRole,
    requirement: options.requirement,
    source: options.source,
    repository: options.repository,
    exclude: options.exclude,
    depends_on: options.dependsOn,
    covered_change: options.coveredChange,
    attachment: options.attachment,
  };
  for (const [name, values] of Object.entries(lists)) {
    if (values.length > 0) recorded[name] = values;
  }
  return recorded;
}
