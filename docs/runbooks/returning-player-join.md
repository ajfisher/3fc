# Returning-player join rollout and containment

`PLAYER_RETURNING_JOIN_ENABLED` accepts only the strings `true` and `false`.
Serverless, local Compose and QA/production workflows default to `false`.
The switch is independent of `PLAYER_CONSOLIDATION_ENABLED` and `PLAYER_CLAIM_MODE`.
Disabling returning joins must not disable account-claim revision writes.

## Two-phase activation

1. Keep the GitHub Environment variable `PLAYER_RETURNING_JOIN_ENABLED=false`.
   Deploy the new API first, with every claim/consolidation index writer updating
   the private account revision atomically. Existing alias readers remain active.
   Record the exact SHA, Lambda code hash, revision, LastModified and the live
   `returningJoinEnabled: "false"` fingerprint. Shell exports alone do not set
   GitHub Environment variables used by deployment workflows.
2. Verify the audited player-identity membership cutover for that environment:
   control must be fenced, migration provenance reviewed, and required directory
   projections available. Do not invent verified coverage or run a shared-table
   migration merely to unblock acceptance. Use isolated synthetic QA resources
   where the shared environment has not received authorised cutover.
3. Wait until at least **905 seconds after the new revision-aware API replaces
   the last writer that could omit the account revision**, measured from that
   new deployment's Lambda LastModified. This covers Lambda's maximum 900-second
   execution lifetime plus margin, regardless of the new function timeout.
   Record actual wall-clock evidence and recheck the exact deployed revision.
   No old workflow, function version, local service or maintenance writer may
   continue making revision-free claim-index writes. If one does, disable the
   feature, replace that writer, and restart the drain.
4. Only after these checks, explicitly enable `true` for the authorised QA
   environment and redeploy through the normal API-first workflow. Verify the
   requested and actual Lambda fingerprints match, then perform signed-in
   acceptance. Isolated QA follows the same false-first and actual-drain sequence.
   Production activation requires AJ's separate release authorisation.

No new Terraform resource is required. The deployment manifest and final live
guard capture only the narrowly selected nonsecret switches; missing, malformed
or mismatched `returningJoinEnabled` fails deployment verification.

## Disablement and rollback

Set the environment variable to `false` and redeploy the current hardened API.
Returning discovery and self-join then return an explicit unavailable response;
the UI must offer retry rather than silently create a duplicate player.
Pending requests and their idempotency keys remain retained for later recovery.
Already committed registrations, original roster IDs and durable join receipts
are not removed. Disablement performs no data migration or automatic undo.

Keep canonical alias readers, proof enforcement, and all account revision
writers deployed even while returning joins are disabled. Never roll back to a
binary that writes claim indexes without revision fences while discovery is
enabled. Re-enabling after such a rollback requires another false-first writer
deployment and completed drain. Consolidation remains independently controlled;
disabling this feature is not authority to change its setting or rewrite history.
