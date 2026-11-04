# Test design

## Scope
Verify REQ-001 from acceptance criteria independently of implementation choices.

## Scenarios
TEST-001 archives an active item; TEST-002 checks public listing; TEST-003 checks unauthorized mutation.

## Technical risks
Add retry/idempotency and concurrent update scenarios after reviewing CONTRACT-001.

## Test data
Active item, editor identity, unauthorized identity, public listing query.

## Execution status
All cases are planned and not run.
