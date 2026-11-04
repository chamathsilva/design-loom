/**
 * Where each record lives in a design repository (design doc 03, "Storage conventions").
 *
 * | Path | Record |
 * |---|---|
 * | `changes/<change-id>/change.json` | Change |
 * | `changes/<change-id>/artifacts/<artifact-id>.json` | Change-scoped artifact sidecar |
 * | `changes/<change-id>/tasks/<task-id>.json` | Coding task |
 * | `changes/<change-id>/traceability.json` | Traceability for the change |
 * | `changes/<change-id>/findings.json` | Review findings for the change |
 * | `shared/artifacts/<artifact-id>.json` | Project-scoped artifact sidecar |
 * | `sources/<source-id>.json` | Source record |
 * | `baselines/<baseline-id>.json` | Baseline proposal |
 *
 * Content folders (`changes/<id>/content/`, `shared/content/`, `sources/snapshots/`) hold bytes,
 * not records; they are read only when a record references a file in them.
 */

const ID = /^[A-Za-z][A-Za-z0-9._-]{1,79}$/;

export type StoreRecordKind = "change" | "artifact" | "task" | "traceability" | "findings" | "source" | "baseline";

export interface StoreLocation {
  kind: StoreRecordKind;
  /** The record ID the path implies; for traceability and findings, the owning change ID. */
  id: string;
  /** Owning change, or null for project artifacts, sources and baselines. */
  changeId: string | null;
  /** For artifacts: the scope the folder implies. */
  scope: "change" | "project" | null;
}

/** Folders a scan lists, relative to the design repository root. */
export const STORE_SCAN_ROOTS: readonly string[] = ["baselines", "changes", "shared/artifacts", "sources"];

/** True for content folders a scan should not descend into. */
export function isContentFolder(path: string): boolean {
  const parts = path.split("/");
  return (
    (parts.length === 3 && parts[0] === "changes" && parts[2] === "content") ||
    path === "shared/content" ||
    path === "sources/snapshots"
  );
}

const idFromJson = (name: string | undefined): string | null => {
  if (name === undefined || !name.endsWith(".json")) return null;
  const id = name.slice(0, -".json".length);
  return ID.test(id) ? id : null;
};

/** What record a normalized repository-relative path holds, or null when it isn't a record location. */
export function classifyStorePath(path: string): StoreLocation | null {
  const parts = path.split("/");
  const [top, second, third, fourth] = parts;
  if (top === "changes" && second !== undefined && ID.test(second)) {
    if (parts.length === 3 && third === "change.json")
      return { kind: "change", id: second, changeId: second, scope: null };
    if (parts.length === 3 && third === "traceability.json") {
      return { kind: "traceability", id: second, changeId: second, scope: null };
    }
    if (parts.length === 3 && third === "findings.json")
      return { kind: "findings", id: second, changeId: second, scope: null };
    const id = idFromJson(fourth);
    if (parts.length === 4 && id && third === "artifacts")
      return { kind: "artifact", id, changeId: second, scope: "change" };
    if (parts.length === 4 && id && third === "tasks") return { kind: "task", id, changeId: second, scope: null };
    return null;
  }
  if (top === "shared" && second === "artifacts" && parts.length === 3) {
    const id = idFromJson(third);
    return id ? { kind: "artifact", id, changeId: null, scope: "project" } : null;
  }
  if ((top === "sources" || top === "baselines") && parts.length === 2) {
    const id = idFromJson(second);
    if (!id) return null;
    return { kind: top === "sources" ? "source" : "baseline", id, changeId: null, scope: null };
  }
  return null;
}

/**
 * Folder an artifact's content and attachments belong in (design doc 03): its change's folder, or
 * `shared/` for project artifacts. New content goes in the `content/` folder inside it; attachments
 * may also name the change's own records, such as its traceability.json.
 */
export function ownedFolderFor(scope: "change" | "project", changeId: string | null): string {
  return scope === "project" ? "shared/" : `changes/${changeId}/`;
}
