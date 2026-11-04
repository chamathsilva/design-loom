// The design package's example records, laid out as a design repository (design doc 03,
// "Storage conventions"). The examples keep artifact content in flat folders; here each content
// file moves to its scope's canonical folder. The semantic digest ignores content paths, so the
// design's recorded digests still apply.
//
// Known layout gap in the examples: QA-001, REVIEW-001 and QA-BATCH-001 attach traceability.json,
// findings.json and late-qa/traceability.json by root-level paths. Moving them would change the
// digests, so they stay, and the index warns that they are outside the artifact's folder.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyStorePath,
  isContentFolder,
  referencedFiles,
  type StoreFile,
  type StoreInput,
} from "@design-loom/artifacts";
import { parseJson } from "@design-loom/config";

const EXAMPLES = join(import.meta.dirname, "..", "fixtures", "design", "examples");

export const SAMPLE_APPLICATION_ID = "sample-catalog";

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(join(EXAMPLES, ...path.split("/"))));
const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(EXAMPLES, ...path.split("/")), "utf8"));
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/** Repository path → bytes. Mutate the returned map freely; each call builds a fresh one. */
export function sampleRepository(): Map<string, Uint8Array> {
  const repo = new Map<string, Uint8Array>();
  const artifact = (from: string, to: string, contentFolder: string): void => {
    const value = json(from) as { content: { path: string }; attachments: { path: string }[] };
    const name = value.content.path.split("/").at(-1) as string;
    repo.set(`${contentFolder}${name}`, read(value.content.path));
    value.content.path = `${contentFolder}${name}`;
    // Attachments stay where the example puts them, because their paths are part of the semantic
    // digest the design records. They name copies of the change's own records at the repository
    // root, which the index reports as outside the artifact's folder.
    for (const attachment of value.attachments) repo.set(attachment.path, read(attachment.path));
    repo.set(to, encode(value));
  };

  repo.set("changes/CHANGE-001/change.json", read("change.json"));
  for (const id of ["REQDOC-001", "CONTRACT-001", "DESIGN-001", "QA-001", "REVIEW-001"]) {
    artifact(`artifacts/${id}.json`, `changes/CHANGE-001/artifacts/${id}.json`, "changes/CHANGE-001/content/");
  }
  repo.set("changes/CHANGE-001/traceability.json", read("traceability.json"));
  repo.set("changes/CHANGE-001/findings.json", read("findings.json"));
  repo.set("changes/CHANGE-001/tasks/TASK-001.json", read("task.json"));
  repo.set("changes/CHANGE-001/tasks/TASK-EARLY-001.json", read("task-unreviewed.json"));

  repo.set("changes/CHANGE-002/change.json", read("late-qa/change-engineering.json"));
  artifact("late-qa/DESIGN-002.json", "changes/CHANGE-002/artifacts/DESIGN-002.json", "changes/CHANGE-002/content/");

  repo.set("changes/QA-CAMPAIGN-001/change.json", read("late-qa/change-qa.json"));
  artifact(
    "late-qa/QA-BATCH-001.json",
    "changes/QA-CAMPAIGN-001/artifacts/QA-BATCH-001.json",
    "changes/QA-CAMPAIGN-001/content/",
  );
  repo.set("changes/QA-CAMPAIGN-001/traceability.json", read("late-qa/traceability.json"));

  repo.set("shared/artifacts/SHARED-STATUS-001.json", read("shared/artifacts/SHARED-STATUS-001.json"));
  repo.set("shared/content/item-status.md", read("shared/content/item-status.md"));

  repo.set("sources/src-catalog-requirement.json", read("source.json"));
  repo.set("sources/snapshots/catalog-requirement.md", read("sources/snapshots/catalog-requirement.md"));
  repo.set("sources/src-optional-notes.json", read("source-unavailable.json"));

  repo.set("baselines/BASELINE-001.json", read("baseline.json"));
  return repo;
}

/** Reads a JSON file from the repository map. */
export function readRecord(repo: Map<string, Uint8Array>, path: string): Record<string, unknown> {
  const bytes = repo.get(path);
  if (!bytes) throw new Error(`no ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Replaces a JSON file in the repository map after editing it. */
export function editRecord(
  repo: Map<string, Uint8Array>,
  path: string,
  edit: (value: Record<string, unknown>) => void,
): void {
  const value = readRecord(repo, path);
  edit(value);
  repo.set(path, encode(value));
}

export function writeRecord(repo: Map<string, Uint8Array>, path: string, value: unknown): void {
  repo.set(path, encode(value));
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** What a scan of the repository map would produce, without touching the disk. */
export function storeInput(repo: Map<string, Uint8Array>, applicationId = SAMPLE_APPLICATION_ID): StoreInput {
  const roots = ["baselines/", "changes/", "shared/artifacts/", "sources/"];
  const records: StoreFile[] = [];
  for (const [path, bytes] of repo) {
    if (!roots.some((root) => path.startsWith(root))) continue;
    const folders = path.split("/").slice(0, -1);
    if (folders.some((_, index) => isContentFolder(folders.slice(0, index + 1).join("/")))) continue;
    const file: StoreFile = { path, sha256: sha256(bytes), size: bytes.byteLength };
    if (classifyStorePath(path)) {
      try {
        file.value = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        file.readError = (error as Error).message;
      }
    }
    records.push(file);
  }
  const referenced = new Map<string, string | null>();
  for (const path of referencedFiles(records)) {
    const bytes = repo.get(path);
    referenced.set(path, bytes ? sha256(bytes) : null);
  }
  return { applicationId, records, referenced };
}
