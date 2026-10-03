# ADR 0009: Private player portraits and durable media cleanup

Status: accepted for implementation, 4 October 2026.

## Input and visibility

The owner screen accepts JPEG, PNG and WebP source photographs up to 8 MiB and
16 megapixels and crops them locally to a 512px square. The API receives the
cropped bitmap, not the original source: at most 2 MiB decoded in a 3 MiB JSON
request. This explicitly respects Lambda's synchronous request envelope limit.
Server validation applies to that received bitmap; it does not claim to inspect
the original file. The encoder checks magic, format, square dimensions and a
single frame, then independently re-encodes a 512px PNG without source metadata.
Only the processed PNG enters storage. Sharp is loaded only when encoding.

`PUT/DELETE /v1/owner-player-portrait?playerId=…` checks the verified canonical
claim, expected presentation revision, idempotency key and existing origin/session
protection. League roles never grant editing rights. The upload body contains
`expectedRevision`, `contentType` and canonical `base64`; deletion contains only
`expectedRevision`. Results contain safe presentation fields, never email or keys.
Name and photo operations share a semantic revision, preserving each other's fields.

`GET /v1/player-portrait?leagueId=…&playerId=…&viewerPlayerId=…` uses the profile's
league visibility boundary and fences both authority and portrait pointer after
reading the object. No pointer yields404; missing/corrupt referenced media yields503.
Responses are authenticated PNG bytes with no-store/no-referrer/nosniff. No object
URL, presigned link, bucket key or account field is returned. Profiles may read
portraits while owner editing is disabled. Safe profile responses expose only
`hasPortrait`; private settings keep email separate. Shared card images deliberately
include the selected portrait, explained before the owner saves it.

## Object and state ownership

A stage/account-specific S3 bucket has all public-access blocks, bucket-owner
ownership, encryption and a TLS-only policy. It has no public/CDN policy or CORS.
The API can Get/Put processed objects; the worker can Delete them. Neither needs
ListBucket. Local development uses a private ignored filesystem directory, never
a static asset path. Object keys are immutable generated hash/UUID paths. Repeated
puts must match existing bytes. S3 requests and response streams have bounded IO.

An immutable request reservation and `MEDIA#<uuid>` work marker commit before any
object put. The original 120-second lease is not extended; new object IO cannot
start with fewer than30 seconds left. API runtime and IO limits fit inside this
margin. Publication checks current ownership again and atomically records the
portrait pointer, active upload state, immutable response receipt and cleanup of
the predecessor. A changed name, claim, canonical root or pointer prevents a stale
save. Lost acknowledgements replay receipts after current ownership checks; they
never trigger speculative deletion of a possibly published object.

The worker waits until an abandoned upload's lease expires, then claims `deleting`
with a transaction-fenced pointer/identity snapshot before touching S3. Publication
requires `uploading`, so a claimed cleanup cannot be revived. Deletes are idempotent;
failures preserve the checkpoint and retry through the existing queue/DLQ. Cleanup
retains the original upload lease even after publication: a concurrent identical
retry can still be finishing its immutable put. Deletion waits until that window
closes, preventing a late retry from recreating an already deleted object. Replaced
or removed portraits are immediately absent from authorised reads; physical cleanup
follows asynchronously. Active referenced objects cannot be deleted.

Consolidation commits one retirement job alongside the identity change. It walks
retired identities one at a time, marks their formerly active objects for cleanup,
and preserves the retained canonical player's portrait. The worker never writes
`PLAYER#` records or changes historical identities. Queue messages contain only
partition hashes and strict NAME/MEDIA/RETIRE keys. Terminal/active stream images
are ignored; delayed upload continuations use bounded SQS delays.

## Deployment and recovery

Terraform owns bucket protections and scoped API/worker permissions. Serverless
owns routes, environment and compatible stream filters. The API uses Node22/arm64;
packaging explicitly includes Sharp and its Linux/arm64 native dependencies.
Worker code imports the storage adapter independently of the encoder. Deploy and
verify the worker/filter before the API producer. Feature flags and processing
readiness remain separate. A guarded operator can inspect or resume bounded name,
media and retirement work without a table scan.

Disable owner editing to stop new photo saves; retain existing objects, pointers,
reservations and receipts. Pausing processing preserves required cleanup for later
recovery, and exact committed requests remain replayable. Do not delete the bucket
or revert to a producer/consumer version that cannot understand portrait work while
such work is pending. Production infrastructure changes remain AJ's release decision.
