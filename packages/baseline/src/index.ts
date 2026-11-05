/**
 * @design-loom/baseline: Optional reviewed-baseline proposals, lineage and verification policy.
 * Pure logic; provider reads arrive through integrations. Lineage: backlog B05. Verification: B12–B13.
 */

export {
  analyzeLineage,
  type CurrentSelection,
  type LineageBaseline,
  type LineageReport,
  selectCurrentBaseline,
} from "./lineage.ts";

export const PACKAGE_NAME = "@design-loom/baseline";
