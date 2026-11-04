# Archive catalog engineering design

## Context used

Read the catalog requirements snapshot, REQDOC-001 and CONTRACT-001 at the digests in this artifact context. QA design is optional and is not an input dependency.

## Summary

Add a single-item archive operation and exclude archived items from public listings.

## Scope

Cover authorized archive writes and public listing visibility. Bulk archive and restoration are excluded.

## Requirement mapping

REQ-001 and AC-001 through AC-003 govern archived response state, public visibility and authorization.

## Current behavior

The synthetic fixture begins with active catalog items. Archived status and its public listing semantics are introduced by this scoped change.

## Proposed design

Set an authorized item to archived and return its archived state. Treat repeated archive requests consistently. Filter archived items from public reads.

## Contracts and dependencies

Use CONTRACT-001 and its shared status vocabulary. Consumers interpret active and archived consistently. CHANGE-002 develops the public-read implementation details separately.

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
