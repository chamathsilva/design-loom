/**
 * The artifact/source store index (backlog B05; design doc 03 "Storage conventions", doc 07
 * `ArtifactStore.scan`, doc 16 semantic rules).
 *
 * Pure: the caller lists the record files, parses them, and hashes the content files they
 * reference. This module checks every record against its schema and its location, resolves the
 * references between records, verifies content bytes and computes artifact-semantic-v1 digests.
 * Problems become diagnostics; a record whose shape or identity can't be trusted is left out of
 * the index, while a record with broken references stays in so status can show it.
 */

import {
  caseFoldKey,
  compareCodePoints,
  type Diagnostic,
  diagnostic,
  normalizeRelativePath,
  pointerPath,
  sortDiagnostics,
} from "@design-loom/config";
import { type SchemaKind, validateAgainstSchema } from "@design-loom/validation";
import { type ArtifactSemanticInput, artifactSemanticDigest } from "./semantic-digest.ts";
import { classifyStorePath, ownedFolderFor, type StoreLocation, type StoreRecordKind } from "./store-layout.ts";

// ---------------------------------------------------------------------------------------------------
// Inputs

/** One file a scan listed. */
export interface StoreFile {
  /** Normalized path relative to the design repository root. */
  path: string;
  /** SHA-256 of the raw bytes. */
  sha256: string;
  /** Size in bytes. */
  size: number;
  /** Parsed JSON, when the file is at a record location and parsed. */
  value?: unknown;
  /** Why the file couldn't be read or parsed. */
  readError?: string;
}

export interface StoreLimits {
  maxArtifacts: number;
  maxMetadataBytes: number;
  maxDependencyDepth: number;
}

/** Design doc 03, "Limits and paths". Applications may lower or raise the first two in `limits`. */
export const DEFAULT_STORE_LIMITS: StoreLimits = {
  maxArtifacts: 5000,
  maxMetadataBytes: 1_048_576,
  maxDependencyDepth: 100,
};

export interface StoreInput {
  /** The application every record must belong to. */
  applicationId: string;
  /** Every file the scan listed outside content folders. */
  records: readonly StoreFile[];
  /** SHA-256 of each file the records reference (see `referencedFiles`), or null when it is missing. */
  referenced: ReadonlyMap<string, string | null>;
  limits?: Partial<StoreLimits>;
}

// ---------------------------------------------------------------------------------------------------
// Record shapes, used after schema validation

export interface ContextReference {
  kind: "artifact" | "source";
  id: string;
  state: "read" | "linked" | "unavailable";
  revision?: string;
  sha256?: string;
}

export interface ArtifactRecord extends ArtifactSemanticInput {
  title: string;
  state: "draft" | "ready" | "in_review" | "superseded";
  workflow_step?: string;
  owner_role: string;
  content: { path: string; sha256: string };
  context?: { references: ContextReference[]; gaps: unknown[] };
}

export interface ChangeRecord {
  id: string;
  application_id: string;
  title: string;
  workflow_id: string;
  source_ids: string[];
}

export interface TaskRecord {
  id: string;
  application_id: string;
  change_id: string;
  baseline_id?: string;
  artifact_ids: string[];
  dependency_tasks: string[];
}

export interface TraceabilityRecord {
  change_id: string;
  covered_change_ids?: string[];
  design_links: { requirement_id: string; artifact_ids: string[] }[];
}

export interface FindingsRecord {
  change_id: string;
  reviewed_artifacts: { id: string; sha256: string }[];
  omitted_artifact_ids: string[];
}

export interface SourceRecord {
  id: string;
  application_id: string;
  provider: string;
  revision: string;
  state: string;
  sha256?: string;
  snapshot_path?: string;
}

export interface BaselineRecord {
  id: string;
  application_id: string;
  change_id: string;
  artifact_ids: string[];
  source_ids: string[];
  task_ids: string[];
  supersedes?: string[];
}

// ---------------------------------------------------------------------------------------------------
// Output

export interface IndexedRecord<T> {
  id: string;
  /** Path of the record file. */
  path: string;
  /** SHA-256 of the record file's raw bytes. */
  sha256: string;
  record: T;
}

export interface IndexedArtifact extends IndexedRecord<ArtifactRecord> {
  scope: "change" | "project";
  /** Owning change, or null for project artifacts. */
  changeId: string | null;
  /** True when the content and every attachment exist with the recorded hashes. */
  bytesVerified: boolean;
  /** artifact-semantic-v1, or null when the bytes couldn't be verified. */
  semanticDigest: string | null;
}

export interface IndexedChange extends IndexedRecord<ChangeRecord> {
  artifactIds: string[];
  taskIds: string[];
  traceability: IndexedRecord<TraceabilityRecord> | null;
  findings: IndexedRecord<FindingsRecord> | null;
}

export interface IndexedTask extends IndexedRecord<TaskRecord> {
  changeId: string;
}

export interface StoreIndex {
  applicationId: string;
  /** Maps are keyed by ID and iterate in ID order. */
  changes: ReadonlyMap<string, IndexedChange>;
  artifacts: ReadonlyMap<string, IndexedArtifact>;
  sources: ReadonlyMap<string, IndexedRecord<SourceRecord>>;
  tasks: ReadonlyMap<string, IndexedTask>;
  baselines: ReadonlyMap<string, IndexedRecord<BaselineRecord>>;
  /** Direct dependents of each artifact (artifacts whose depends_on names it), in ID order. */
  dependents: ReadonlyMap<string, readonly string[]>;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------------------------------

const SCHEMA_OF: Record<StoreRecordKind, SchemaKind> = {
  change: "change",
  artifact: "artifact",
  task: "task",
  traceability: "traceability",
  findings: "findings",
  source: "source",
  baseline: "baseline",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const safePath = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return normalizeRelativePath(value);
  } catch {
    return null;
  }
};

/**
 * Files the records reference and the scan must hash: artifact content and attachments, and
 * source snapshots. Paths that fail the path policy are left out; the index reports them.
 */
export function referencedFiles(records: readonly StoreFile[]): string[] {
  const paths = new Set<string>();
  const add = (value: unknown): void => {
    const path = safePath(value);
    if (path) paths.add(path);
  };
  for (const file of records) {
    const location = classifyStorePath(file.path);
    if (!location || !isObject(file.value)) continue;
    if (location.kind === "artifact") {
      add(isObject(file.value.content) ? file.value.content.path : undefined);
      if (Array.isArray(file.value.attachments)) {
        for (const attachment of file.value.attachments) add(isObject(attachment) ? attachment.path : undefined);
      }
    } else if (location.kind === "source") {
      add(file.value.snapshot_path);
    }
  }
  return [...paths].sort(compareCodePoints);
}

const byId = <T>(map: Map<string, T & { id: string }>): Map<string, T & { id: string }> =>
  new Map([...map.values()].sort((a, b) => compareCodePoints(a.id, b.id)).map((entry) => [entry.id, entry]));

/** Builds the store index. Never throws for bad repository content. */
export function buildStoreIndex(input: StoreInput): StoreIndex {
  const limits: StoreLimits = { ...DEFAULT_STORE_LIMITS, ...input.limits };
  const diagnostics: Diagnostic[] = [];
  const report = (
    code: string,
    severity: "error" | "warning" | "info",
    message: string,
    path: string,
    remediation: string,
    evidence: string[] = [],
  ): void => {
    diagnostics.push(diagnostic(code, severity, message, { path, evidence, remediation }));
  };

  // 1. Each record file: location, size, parse, schema, identity and ownership.
  type Accepted = { file: StoreFile; location: StoreLocation; value: Record<string, unknown> };
  const accepted: Accepted[] = [];
  const files = [...input.records].sort((a, b) => compareCodePoints(a.path, b.path));
  for (const file of files) {
    const location = classifyStorePath(file.path);
    if (!location) {
      report(
        "STORE_UNEXPECTED_FILE",
        "warning",
        "file is not at a record location and is ignored",
        file.path,
        "Move it into a content folder, or remove it.",
      );
      continue;
    }
    if (file.size > limits.maxMetadataBytes) {
      report(
        "STORE_RECORD_TOO_LARGE",
        "error",
        `record is ${file.size} bytes; the limit is ${limits.maxMetadataBytes}`,
        file.path,
        "Move large data into content or attachments.",
      );
      continue;
    }
    if (file.readError !== undefined || !isObject(file.value)) {
      report(
        "STORE_RECORD_UNREADABLE",
        "error",
        `record can't be read: ${file.readError ?? "not a JSON object"}`,
        file.path,
        "Fix the file so it is one valid JSON object without duplicate keys.",
      );
      continue;
    }
    const value = file.value;
    const schema = validateAgainstSchema(SCHEMA_OF[location.kind], value);
    if (!schema.valid) {
      for (const issue of schema.issues) {
        report(
          "STORE_SCHEMA_INVALID",
          "error",
          `${location.kind}: ${issue.message}`,
          pointerPath(file.path, issue.instancePath),
          `Fix the record so it matches ${SCHEMA_OF[location.kind]}.schema.json.`,
          [issue.schemaPath],
        );
      }
      continue;
    }
    const usesId = location.kind !== "traceability" && location.kind !== "findings";
    if (usesId && value.id !== location.id) {
      report(
        "STORE_ID_MISMATCH",
        "error",
        `record ID ${String(value.id)} differs from its file name`,
        pointerPath(file.path, "/id"),
        "Name the file after the record ID; IDs are immutable.",
      );
      continue;
    }
    if ("application_id" in value && value.application_id !== input.applicationId) {
      report(
        "STORE_APPLICATION_MISMATCH",
        "error",
        `record belongs to application ${String(value.application_id)}, not ${input.applicationId}`,
        pointerPath(file.path, "/application_id"),
        "Cross-application records aren't supported; import the other application's contract as a source.",
      );
      continue;
    }
    if (location.kind === "artifact") {
      const scope = value.scope === "project" ? "project" : "change";
      if (scope !== location.scope) {
        report(
          "STORE_SCOPE_MISMATCH",
          "error",
          `a ${scope}-scoped artifact is stored in the ${location.scope} folder`,
          file.path,
          location.scope === "project"
            ? "Project artifacts set scope to project and live in shared/artifacts/."
            : "Change artifacts live in changes/<change-id>/artifacts/; project artifacts in shared/artifacts/.",
        );
        continue;
      }
    }
    if (location.changeId !== null && location.kind !== "change" && value.change_id !== location.changeId) {
      report(
        "STORE_CHANGE_MISMATCH",
        "error",
        `record belongs to change ${String(value.change_id)} but is stored under ${location.changeId}`,
        pointerPath(file.path, "/change_id"),
        "Store change records under their own change folder.",
      );
      continue;
    }
    accepted.push({ file, location, value });
  }

  // 2. Register IDs. Artifact, task, source, baseline and change IDs are unique ignoring case.
  const changes = new Map<string, IndexedChange>();
  const artifacts = new Map<string, IndexedArtifact>();
  const sources = new Map<string, IndexedRecord<SourceRecord>>();
  const tasks = new Map<string, IndexedTask>();
  const baselines = new Map<string, IndexedRecord<BaselineRecord>>();
  const folded = new Map<string, Map<string, string>>();
  const claim = (label: string, id: string, path: string): boolean => {
    const registry = folded.get(label) ?? new Map<string, string>();
    folded.set(label, registry);
    const existing = registry.get(caseFoldKey(id));
    if (existing !== undefined) {
      report(
        "STORE_DUPLICATE_ID",
        "error",
        `${label} ID ${id} is already used (ignoring case)`,
        path,
        `Give each ${label} a unique ID across the repository.`,
        [existing],
      );
      return false;
    }
    registry.set(caseFoldKey(id), path);
    return true;
  };
  const traceability = new Map<string, IndexedRecord<TraceabilityRecord>>();
  const findings = new Map<string, IndexedRecord<FindingsRecord>>();
  for (const { file, location, value } of accepted) {
    const base = { id: location.id, path: file.path, sha256: file.sha256 };
    switch (location.kind) {
      case "change":
        if (claim("change", location.id, file.path)) {
          changes.set(location.id, {
            ...base,
            record: value as unknown as ChangeRecord,
            artifactIds: [],
            taskIds: [],
            traceability: null,
            findings: null,
          });
        }
        break;
      case "artifact":
        if (claim("artifact", location.id, file.path)) {
          artifacts.set(location.id, {
            ...base,
            record: value as unknown as ArtifactRecord,
            scope: location.scope === "project" ? "project" : "change",
            changeId: location.changeId,
            bytesVerified: false,
            semanticDigest: null,
          });
        }
        break;
      case "task":
        if (claim("task", location.id, file.path)) {
          tasks.set(location.id, {
            ...base,
            record: value as unknown as TaskRecord,
            changeId: location.changeId ?? "",
          });
        }
        break;
      case "source":
        if (claim("source", location.id, file.path))
          sources.set(location.id, { ...base, record: value as unknown as SourceRecord });
        break;
      case "baseline":
        if (claim("baseline", location.id, file.path)) {
          baselines.set(location.id, { ...base, record: value as unknown as BaselineRecord });
        }
        break;
      case "traceability":
        traceability.set(location.id, { ...base, record: value as unknown as TraceabilityRecord });
        break;
      case "findings":
        findings.set(location.id, { ...base, record: value as unknown as FindingsRecord });
        break;
    }
  }

  if (artifacts.size > limits.maxArtifacts) {
    report(
      "STORE_LIMIT_EXCEEDED",
      "error",
      `${artifacts.size} artifacts exceed the limit of ${limits.maxArtifacts}`,
      "",
      "Split the application, or raise limits.max_artifacts in a reviewed change.",
    );
  }

  // 3. Attach change-owned records to their change.
  const ownedBy = (changeId: string | null, path: string, what: string): IndexedChange | null => {
    const change = changeId === null ? undefined : changes.get(changeId);
    if (!change) {
      report(
        "STORE_CHANGE_MISSING",
        "error",
        `${what} is stored under change ${changeId}, which has no change.json`,
        path,
        `Create changes/${changeId}/change.json, or move the record.`,
      );
      return null;
    }
    return change;
  };
  for (const artifact of artifacts.values()) {
    if (artifact.scope === "change")
      ownedBy(artifact.changeId, artifact.path, "artifact")?.artifactIds.push(artifact.id);
  }
  for (const task of tasks.values()) ownedBy(task.changeId, task.path, "task")?.taskIds.push(task.id);
  for (const [changeId, entry] of traceability) {
    const change = ownedBy(changeId, entry.path, "traceability");
    if (change) change.traceability = entry;
  }
  for (const [changeId, entry] of findings) {
    const change = ownedBy(changeId, entry.path, "findings");
    if (change) change.findings = entry;
  }

  // 4. Bytes: content, attachments and snapshots exist with their recorded hashes.
  const checkBytes = (
    path: string,
    expected: string,
    where: string,
    missingCode: string,
    mismatchCode: string,
  ): boolean => {
    const actual = input.referenced.get(path);
    if (actual === undefined || actual === null) {
      report(
        missingCode,
        "error",
        `${path} is missing`,
        where,
        "Restore the file, or update the record in a reviewed change.",
      );
      return false;
    }
    if (actual !== expected) {
      report(
        mismatchCode,
        "error",
        `${path} doesn't match its recorded SHA-256`,
        where,
        "Re-register the artifact so its digest matches the file, or restore the reviewed bytes.",
        [`recorded: ${expected}`, `actual: ${actual}`],
      );
      return false;
    }
    return true;
  };
  for (const artifact of artifacts.values()) {
    const { record } = artifact;
    const folder = ownedFolderFor(artifact.scope, artifact.changeId);
    let verified = checkBytes(
      record.content.path,
      record.content.sha256,
      pointerPath(artifact.path, "/content"),
      "STORE_CONTENT_MISSING",
      "STORE_CONTENT_DIGEST_MISMATCH",
    );
    record.attachments.forEach((attachment, index) => {
      const ok = checkBytes(
        attachment.path,
        attachment.sha256,
        pointerPath(artifact.path, `/attachments/${index}`),
        "STORE_CONTENT_MISSING",
        "STORE_CONTENT_DIGEST_MISMATCH",
      );
      verified &&= ok;
    });
    for (const owned of [record.content.path, ...record.attachments.map((attachment) => attachment.path)]) {
      if (!owned.startsWith(folder)) {
        report(
          "STORE_CONTENT_OUTSIDE_SCOPE",
          "warning",
          `${owned} is outside the artifact's folder ${folder}`,
          artifact.path,
          `Keep ${artifact.scope} artifact files under ${folder}; new registrations require it.`,
        );
      }
    }
    artifact.bytesVerified = verified;
    artifact.semanticDigest = verified ? artifactSemanticDigest(record) : null;
  }
  for (const source of sources.values()) {
    const { record } = source;
    if (record.snapshot_path === undefined) {
      if (record.state === "captured") {
        report(
          "STORE_SNAPSHOT_ABSENT",
          "info",
          "captured source has no snapshot; its bytes can only be checked against the provider revision",
          source.path,
          "Capture a snapshot unless the provider revision is immutable and re-fetchable at review time.",
        );
      }
      continue;
    }
    if (!record.snapshot_path.startsWith("sources/snapshots/")) {
      report(
        "STORE_SNAPSHOT_OUTSIDE",
        "error",
        "snapshot_path must be inside sources/snapshots/",
        pointerPath(source.path, "/snapshot_path"),
        "Store captured bytes under sources/snapshots/.",
      );
      continue;
    }
    if (record.sha256 === undefined) {
      report(
        "STORE_SNAPSHOT_UNBOUND",
        "error",
        "source has a snapshot but no sha256 to bind it",
        source.path,
        "Record the snapshot's SHA-256.",
      );
      continue;
    }
    checkBytes(
      record.snapshot_path,
      record.sha256,
      pointerPath(source.path, "/snapshot_path"),
      "STORE_SNAPSHOT_MISSING",
      "STORE_SNAPSHOT_DIGEST_MISMATCH",
    );
  }

  // 5. References between records.
  const unknown = (code: string, what: string, id: string, where: string): void => {
    report(code, "error", `${what} ${id} doesn't exist`, where, `Create the ${what}, or remove the reference.`);
  };
  const needArtifact = (id: string, where: string): void => {
    if (!artifacts.has(id)) unknown("STORE_UNKNOWN_ARTIFACT", "artifact", id, where);
  };
  const needSource = (id: string, where: string): void => {
    if (!sources.has(id)) unknown("STORE_UNKNOWN_SOURCE", "source", id, where);
  };
  const needChange = (id: string, where: string): void => {
    if (!changes.has(id)) unknown("STORE_UNKNOWN_CHANGE", "change", id, where);
  };
  const needTask = (id: string, where: string): void => {
    if (!tasks.has(id)) unknown("STORE_UNKNOWN_TASK", "task", id, where);
  };

  for (const artifact of artifacts.values()) {
    const { record, path } = artifact;
    record.depends_on.forEach((id, index) => {
      const where = pointerPath(path, `/depends_on/${index}`);
      const target = artifacts.get(id);
      if (!target) unknown("STORE_UNKNOWN_ARTIFACT", "artifact", id, where);
      else if (artifact.scope === "project" && target.scope === "change") {
        report(
          "STORE_PROJECT_DEPENDS_ON_CHANGE",
          "error",
          `project artifact depends on change artifact ${id}`,
          where,
          "Project artifacts may depend only on project artifacts and sources; promote the dependency or drop it.",
        );
      }
    });
    record.source_ids.forEach((id, index) => {
      needSource(id, pointerPath(path, `/source_ids/${index}`));
    });
    if (record.covered_change_ids !== undefined) {
      if (artifact.scope === "project") {
        report(
          "STORE_PROJECT_COVERAGE",
          "error",
          "project artifacts can't cover changes",
          pointerPath(path, "/covered_change_ids"),
          "Record campaign coverage on a change-scoped QA artifact.",
        );
      }
      record.covered_change_ids.forEach((id, index) => {
        needChange(id, pointerPath(path, `/covered_change_ids/${index}`));
      });
    }
    record.context?.references.forEach((reference, index) => {
      if (reference.state !== "read") return;
      const where = pointerPath(path, `/context/references/${index}`);
      const declared = reference.kind === "artifact" ? record.depends_on : record.source_ids;
      if (!declared.includes(reference.id)) {
        report(
          "STORE_CONTEXT_UNDECLARED",
          "error",
          `read ${reference.kind} ${reference.id} is not declared in ${reference.kind === "artifact" ? "depends_on" : "source_ids"}`,
          where,
          "Declare every read input, or record it as linked.",
        );
      }
    });
  }
  for (const change of changes.values()) {
    change.record.source_ids.forEach((id, index) => {
      needSource(id, pointerPath(change.path, `/source_ids/${index}`));
    });
    change.artifactIds.sort(compareCodePoints);
    change.taskIds.sort(compareCodePoints);
  }
  for (const task of tasks.values()) {
    const { record, path } = task;
    record.artifact_ids.forEach((id, index) => {
      needArtifact(id, pointerPath(path, `/artifact_ids/${index}`));
    });
    record.dependency_tasks.forEach((id, index) => {
      needTask(id, pointerPath(path, `/dependency_tasks/${index}`));
    });
    if (record.baseline_id !== undefined && !baselines.has(record.baseline_id)) {
      unknown("STORE_UNKNOWN_BASELINE", "baseline", record.baseline_id, pointerPath(path, "/baseline_id"));
    }
  }
  for (const entry of traceability.values()) {
    entry.record.covered_change_ids?.forEach((id, index) => {
      needChange(id, pointerPath(entry.path, `/covered_change_ids/${index}`));
    });
    entry.record.design_links.forEach((link, linkIndex) => {
      link.artifact_ids.forEach((id, index) => {
        needArtifact(id, pointerPath(entry.path, `/design_links/${linkIndex}/artifact_ids/${index}`));
      });
    });
  }
  for (const entry of findings.values()) {
    entry.record.reviewed_artifacts.forEach((reviewed, index) => {
      needArtifact(reviewed.id, pointerPath(entry.path, `/reviewed_artifacts/${index}`));
    });
    entry.record.omitted_artifact_ids.forEach((id, index) => {
      needArtifact(id, pointerPath(entry.path, `/omitted_artifact_ids/${index}`));
    });
  }
  for (const baseline of baselines.values()) {
    const { record, path } = baseline;
    needChange(record.change_id, pointerPath(path, "/change_id"));
    record.artifact_ids.forEach((id, index) => {
      needArtifact(id, pointerPath(path, `/artifact_ids/${index}`));
    });
    record.source_ids.forEach((id, index) => {
      needSource(id, pointerPath(path, `/source_ids/${index}`));
    });
    record.task_ids.forEach((id, index) => {
      needTask(id, pointerPath(path, `/task_ids/${index}`));
    });
  }

  // 6. The dependency graph: reverse edges, cycles and depth.
  const dependents = new Map<string, string[]>();
  for (const id of artifacts.keys()) dependents.set(id, []);
  for (const artifact of artifacts.values()) {
    for (const target of new Set(artifact.record.depends_on)) dependents.get(target)?.push(artifact.id);
  }
  for (const list of dependents.values()) list.sort(compareCodePoints);
  reportCycles(artifacts, report);
  reportDepth(artifacts, limits.maxDependencyDepth, report);

  return {
    applicationId: input.applicationId,
    changes: byId(changes),
    artifacts: byId(artifacts),
    sources: byId(sources),
    tasks: byId(tasks),
    baselines: byId(baselines),
    dependents: new Map([...dependents].sort(([a], [b]) => compareCodePoints(a, b))),
    diagnostics: sortDiagnostics(diagnostics),
  };
}

type Report = (
  code: string,
  severity: "error" | "warning" | "info",
  message: string,
  path: string,
  remediation: string,
  evidence?: string[],
) => void;

/** Reports each strongly connected group of artifacts once (Tarjan's algorithm, iterative). */
function reportCycles(artifacts: ReadonlyMap<string, IndexedArtifact>, report: Report): void {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const edges = (id: string): string[] =>
    (artifacts.get(id)?.record.depends_on ?? []).filter((next) => artifacts.has(next));

  for (const start of [...artifacts.keys()].sort(compareCodePoints)) {
    if (index.has(start)) continue;
    const work: { id: string; next: number }[] = [{ id: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; next: number };
      const targets = edges(frame.id);
      if (frame.next < targets.length) {
        const target = targets[frame.next++] as string;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter++;
          stack.push(target);
          onStack.add(target);
          work.push({ id: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(target) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      if (low.get(frame.id) === index.get(frame.id)) {
        const group: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          group.push(member);
        } while (member !== frame.id);
        const selfLoop = group.length === 1 && edges(frame.id).includes(frame.id);
        if (group.length > 1 || selfLoop) {
          group.sort(compareCodePoints);
          const first = artifacts.get(group[0] as string);
          report(
            "STORE_DEPENDENCY_CYCLE",
            "error",
            `artifacts depend on each other in a cycle: ${group.join(", ")}`,
            first ? pointerPath(first.path, "/depends_on") : "",
            "depends_on means derived from; remove the edge that points back.",
            group,
          );
        }
      }
    }
  }
}

/** Reports artifacts whose dependency chain is deeper than the limit. Cycles are reported separately. */
function reportDepth(artifacts: ReadonlyMap<string, IndexedArtifact>, limit: number, report: Report): void {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  // Iterative post-order: depth(id) = 1 + max depth of its dependencies, ignoring back edges.
  for (const start of [...artifacts.keys()].sort(compareCodePoints)) {
    if (depth.has(start)) continue;
    const work: { id: string; expanded: boolean }[] = [{ id: start, expanded: false }];
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; expanded: boolean };
      const targets = (artifacts.get(frame.id)?.record.depends_on ?? []).filter((next) => artifacts.has(next));
      if (!frame.expanded) {
        frame.expanded = true;
        visiting.add(frame.id);
        for (const target of targets) {
          if (!depth.has(target) && !visiting.has(target)) work.push({ id: target, expanded: false });
        }
        continue;
      }
      work.pop();
      visiting.delete(frame.id);
      if (depth.has(frame.id)) continue;
      const deepest = Math.max(0, ...targets.map((target) => depth.get(target) ?? 0));
      depth.set(frame.id, deepest + 1);
    }
  }
  // Report only where a chain first goes over the limit, not every artifact above it.
  for (const [id, value] of [...depth].sort(([a], [b]) => compareCodePoints(a, b))) {
    if (value !== limit + 1) continue;
    const artifact = artifacts.get(id);
    report(
      "STORE_DEPENDENCY_TOO_DEEP",
      "error",
      `artifact ${id} has a dependency chain ${value} deep; the limit is ${limit}, so everything that depends on it is too deep as well`,
      artifact ? pointerPath(artifact.path, "/depends_on") : "",
      "Flatten the chain: depend on the artifacts actually used.",
    );
  }
}
