# Public catalog listing design

## Context used

Read the catalog requirement, REQDOC-001 and SHARED-STATUS-001 at the artifact-semantic/source digests recorded in context.

## Summary

Exclude archived items from public catalog listings.

## Scope

Cover AC-002 public-read visibility and pagination. Archive-write behavior belongs to CHANGE-001.

## Requirement mapping

REQ-001 and AC-001 through AC-003 govern archived response state, public visibility and authorization.

## Current behavior

The synthetic fixture begins with active catalog items. Archived status and its public listing semantics are introduced by this scoped change.

## Proposed design

Filter archived items from public results before pagination is computed, preserving the existing authorization and ordering contract.

## Contracts and dependencies

Use SHARED-STATUS-001 and REQDOC-001. CHANGE-001 produces archived status; the two workstreams are reviewed independently when review is requested.

## Data changes

Persist archived status using the application item representation. Actual storage migration details require target-repository inspection before implementation.

## Failure handling

Reject unauthorized mutation without changing state. Handle missing items consistently with the existing API contract.

## Operational considerations

Observe archive errors and listing regressions through existing application diagnostics. The fixture introduces no application-specific monitoring endpoint.

## UI references

No UI is included in this API-only scope. Record any future UI consumer as a separate dependency.

## Rollout and recovery

Deploy compatible readers and writers for the shared status vocabulary. Verify public exclusion and authorization checks during rollout. Record actual recovery operations against the target repository.

## Assumptions and open questions

This synthetic design declares API behavior. Target-repository data migration and execution evidence remain implementation inputs. QA can develop scenarios later without gating this design scope.
