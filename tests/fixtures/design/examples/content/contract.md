# Archive interface

## Contract
PATCH /items/{id}/status accepts {"status":"archived"}. The response carries the updated status.

## Failure behavior
Authorization failure leaves state unchanged. Unknown identifiers produce a not-found response. Repeated archive requests are idempotent.

## Ownership
The catalog API owns this contract; public listing consumes the item status.
