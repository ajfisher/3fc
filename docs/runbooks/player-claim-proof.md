# Player claim proof: deployment and recovery

This runbook covers PR1 of the reusable-player stack (#138), not directory
backfill or profile consolidation. No production operation is authorised by this
document. AJ decides when to merge and release.

## Boundary and stored records

Only public self-registration (`POST /v1/join/{joinCode}`) can issue registration
proof. Supplying `claimProof` requires a valid `Idempotency-Key`. Protected
organiser/scorer player creation rejects that field. Existing owner retries stay
valid; every first claim requires proof plus the confirmation from an
authenticated preview for the same server-resolved account and session.

The browser generates a 256-bit secret and separate random proof ID. DynamoDB
stores only the secret's SHA-256 verifier under `PLAYER_PROOF#id / METADATA`.
Unused proofs have a persisted seven-day `expiresAt` and TTL. A claim transaction
updates the profile, account-player index and consumed receipt together. The
consumed receipt loses its TTL and contains the original outcome: later profile,
permission, game or expiry changes cannot turn a committed same-owner request
into a different write. Preview creates a five-minute session-bound confirmation;
expired confirmations require another preview, not automatic acceptance.

Directed invitations additionally use `PLAYER#id / CLAIM_INVITATION` as their
active-predecessor pointer. Replacement requires the exact current proof ID;
revocation never removes ownership. First acceptance checks the issuer's exact
admin ACL, player revision, active invitation and registration transactionally.
Each individual legacy profile remains distinct until the later canonical-identity
PR. No nickname matching or historical rewriting occurs here.

## Deployment sequence

1. Preserve the current hardened API artifact and exact source SHA as a recovery
   baseline. Do not designate a proofless pre-PR1 API as rollback-safe.
2. Deploy the API through the existing API workflow/Serverless path, then the
   site. `PLAYER_CLAIM_MODE` defaults to `proof`; unknown values fail startup.
3. Verify the new preview, invitation GET/create/revoke and existing claim routes
   reach the deployed API. Verify an authenticated proofless first claim returns
   403 using a disposable profile, not a real player's record.
4. Verify `/link-player` and `/link-player/` both return the recipient shell.
   `deploy-site.sh` uploads both exact S3 object aliases. The existing CloudFront
   router leaves these paths unchanged. No Terraform resource/update is needed.
5. Verify the versioned local `/ui/player-proof.js` asset loads on join, sign-in,
   callback and recipient pages, including after cache invalidation.
6. Use disposable QA accounts/profiles for directed invitation, anonymous join →
   sign-in → explicit link, wrong-account confirmation, retry and revoke checks.
   Record the deployed SHA, workflow run and sanitised results before another
   stack head replaces shared QA.

Dynamic recipient responses and proof API responses use no-store/no-referrer.
The static recipient document uses an early `<meta name="referrer"
content="no-referrer">`; the existing static HTTP referrer header is not changed.
The bearer secret travels in the fragment, then is removed before API requests.
Only the nonsecret proof ID may travel in authentication return destinations.

## Containment and rollback

- Set the GitHub Environment **variable** `PLAYER_CLAIM_MODE` to `disabled` in
  `qa` or `production`, then redeploy the approved hardened head through the
  corresponding workflow (QA: re-add QA-ready; production release remains AJ's
  decision). Both workflows explicitly export this variable to the core deploy
  step; an unset variable defaults to `proof`. For an authorised terminal deploy,
  export `PLAYER_CLAIM_MODE=disabled` before invoking make. The deploy script
  rejects unknown modes before deployment and verifies the exact deployed mode
  alongside the code/revision fingerprint in the manifest; mismatch fails before
  site publication. Change the variable back to `proof` and redeploy to re-enable.
  This suspends new proofs/invitations and first claims. It remains
  possible to join as an unclaimed player and recover confirmed same-owner
  receipts. This switch does not revoke existing sessions or player ownership.
  Proof-bearing web joins keep the same request and succeed without claim proof;
  an immutable `GAME#gameId / JOIN_RECEIPT#playerId` hash records that decision.
  Retries after re-enabling linking return the original unclaimed registration,
  never a newly minted proof. Roster assignment does not overwrite this receipt.
- Local Docker configuration accepts the same environment setting. Local and
  Lambda adapters share proof validation and repository behaviour.
- UI rollback can keep the hardened API, but an older UI cannot perform a new
  proofless claim; direct users to the private-link recovery screen. Never restore
  an API that authorises claims from a player ID alone.
- API recovery is forward-only from the hardened baseline. Preserve proof records,
  consumed receipts, indexes and invitation pointers. Do not delete them to retry
  a failed release. No bulk migration or Terraform apply is part of this PR.
- Later consolidation changes rollback requirements: alias-aware readers must
  remain deployed once canonical groups exist. This PR does not enable that work.

## Privacy and acceptance evidence

Malformed proof records fail closed rather than being repaired during reads.
Inspect their provenance through an authorised, privacy-safe operator process;
do not delete a receipt or pointer blindly to make a claim succeed. Legitimate
consumed receipts retain recovery after expiry, but their stored player and owner
must be internally consistent. Routine membership backfill must not rewrite proof
records or their original issuer binding.

QA deployments use a single non-cancelling job-level concurrency group across
PRs; production preserves its global group without cancelling an active release.
Before rolling out this workflow change, verify older per-PR jobs and their
CloudFormation/Serverless operations have finished. Manual deployments and old
workflow versions do not honor the new lock. Do not run them concurrently.
GitHub may replace pending requests; the lock preserves the running deployment,
not every queued request. Deploy and accept one stack head at a time.

After site smoke checks, `scripts/deploy/verify-api-core.sh` rechecks the full
commit-bound manifest against live API code, revision, completion status and
claim mode. A mismatch fails acceptance; investigate competing deployments and
do not automatically overwrite them. This detects legacy/manual interference,
but cannot prevent it or guarantee that QA remains unchanged after acceptance.
The guard reads only provenance and the nonsecret claim-mode enum. No Terraform
apply or new permissions are required.

Treat invitation fragments, proof request bodies, session cookies and preview
confirmations as credentials. Do not capture them in logs, GitHub comments,
screenshots, traces, HAR files, analytics or test evidence. Browser traces record
JSON request bodies even after the address bar is scrubbed: turn tracing, video
and automatic screenshots off for credential-bearing acceptance. Capture only
separate sanitised views with private-link fields empty/hidden.

Session storage retains secrets for at most seven days. A same-origin,
nonce-correlated BroadcastChannel handoff supports sign-in opening another tab;
it is transport, not authentication. Sign-out clears local copies and requests
best-effort clearing in other open tabs. Account changes lock organiser controls,
purge the private panel and fence late responses. If the source tab/storage is
gone, reopen the original private link after sign-in or ask for a replacement.
Do not fall back to a proofless claim.

Use fixed `/v1/player-proofs/invitation` and `/invitation/revoke` routes with
exact `gameId` and `playerId` query fields, and `/v1/player-proofs/claim` with
the sole `playerId` query field. Percent-encode each opaque ID exactly once;
never place an opaque player ID in a path segment (API Gateway can reject an
encoded slash before Lambda). Malformed/duplicate/extra query fields fail400.
Legacy path routes remain compatible for representable IDs. Deploy the API
before the updated site, as the workflow enforces. Repository authority and
atomic proof checks are identical on both transports; no new IAM is required.

Confirmed containment joins retire their unissued browser proof drafts. Rejected
first attempts retire only their exact draft; uncertain requests keep their
request identity. If cleanup fails, retry storage cleanup before creating another
registration. Capacity must refuse new storage rather than discard a live link.

`scripts/local/test-player-proof.mjs` exercises actual local HTTP authentication,
origin checks, real DynamoDB transactions, competing accounts, lost-response
replays, invitation lifecycle and disabled-mode recovery. It creates its own
`amazon/dynamodb-local:2.5.2` container with no volume and a 512 MiB limit. Run it
after the API build under a host-process ceiling of at most 3.5 GiB, so combined
limits remain 4 GiB. It observes API exit, stops the container and verifies removal.
Never point this test at QA, production or the persistent local development DB.

Review packet evidence must distinguish this actual-HTTP test from unit tests
using an injected session/helper, and fake transaction tests from the real
DynamoDB concurrent-claim check. Physical-device acceptance is separate from
desktop browser emulation.
