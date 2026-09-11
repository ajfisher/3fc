# Player directory cutover

This runbook describes an operator-controlled migration, not an instruction to
run it against production. AJ must separately authorise production migration and
release. PR acceptance uses disposable data. Never set a shared QA control record
to verified merely to make a test pass.

## Preconditions and authority

- Identify the exact AWS account, region, table ARN and environment. Inventory all
  application, administrative and migration writers to that table.
- Review the migration plan, current-head tests, audit/rollback boundaries and
  accepted deployment artifact. Record the approved issue/PR in the manifest.
- Deploy the compatible, proof-enforcing, alias-aware writer before migration.
  Do not roll back to a proofless or alias-unaware API.
- Freeze competing deployments and administrative writes for cutover. Confirm
  no old local process, Lambda alias/version, scheduled job or other service can
  bypass the control record. The CLI verifies the main Lambda fingerprint; it
  does **not** discover or disable every possible writer.
- For a shared QA or production cutover, disable its deployment workflow and
  drain queued, running and approval-waiting runs. The CLI checks this exclusion
  before writes, and checks the live fingerprint before each scan page and
  activation. Keep the freeze in place until the final operational checks pass.
  Re-enable the workflow only after the authorised window ends. The CLI does not
  disable workflows, cancel runs or grant itself that authority.
- Drain old invocations for at least Lambda's maximum 900-second timeout plus five
  seconds after deployment. Record the actual completed drain time. The CLI
  rejects earlier or future timestamps and a changed live deployment.
- Confirm a recent recoverable table backup and enough operational time to
  investigate discrepancies while identity/membership writes remain paused.

The migration preserves raw profiles, registrations, rosters and events. It
adds canonical sidecars, league/season directory associations and reverse
membership references. It never guesses duplicates from nicknames. A legacy
deleted game without sufficient scope provenance is a blocking discrepancy,
not permission to invent a league or omit the reference.

## Manifest and commands

Build the API first. Prepare a reviewed JSON manifest containing:

```json
{
  "migrationId": "reviewed-unique-run-id",
  "accountId": "123456789012",
  "region": "ap-southeast-2",
  "tableName": "the-verified-table",
  "tableArn": "arn:aws:dynamodb:ap-southeast-2:123456789012:table/the-verified-table",
  "writerSha": "the exact 40-character accepted commit SHA",
  "reviewedPlan": "https://github.com/ajfisher/3fc/pull/163",
  "drainedAt": "the actual ISO timestamp after old writers drained",
  "writerVersion": 1
}
```

The example is intentionally not runnable. Substitute independently verified
values, the current implementation's review reference and its API deployment
manifest. Do not edit an old deployment manifest to match a new desired head.

Every invocation requires an explicit profile and both manifests:

```sh
node scripts/player-identity-migrate.mjs status \
  --manifest /absolute/path/migration.json \
  --deployment-manifest /absolute/path/api-core-deploy-manifest.json \
  --profile 3fc-agent
```

Run from a clean checkout at the exact manifest SHA. The CLI performs a forced
API/contracts build before importing migration code, rather than trusting stale
local `dist` files. Include that build in the owned process-group resource guard.

Isolated QA acceptance may use a separately reviewed, exact-artifact Lambda named
`3fc-qa-player-directory-<unique-id>` and matching table `<function-name>-app`.
The deployment manifest pins that function's exact code and revision. It has no
public endpoint and is invoked directly with API Gateway-shaped fixture requests.
Shared QA is never repointed at this table. The isolated operator must exclusively
own this function throughout acceptance; it is not managed by the shared QA
workflow. Record and clean up its exact resource IDs after acceptance.

After operator approval of the controlled pause, use the same arguments with
`begin --apply reviewed-write-pause`. This atomically records the audit and
pauses identity/membership and structure writes. A second run cannot steal the
pause. Ordinary sign-in and existing read-only views remain available.

Run `step --apply reviewed-write-pause --pages 1` initially; a step processes one
bounded scan page. Up to 100 pages may be requested after inspecting progress.
Run through the repository's owned process-group resource guard and verify exit
and cleanup before starting another process. Do not overlap runners.

The first complete scan builds conditional projections. The second complete scan
verifies both raw-source coverage and reverse records, comparing source counts
and order-independent digests. Empty pages with continuation are not completion.
Checkpoints follow confirmed writes. A lost response or interrupted page can be
retried with the **same** manifest and migration ID.

`ready` is not activation. Inspect the completed audit, zero discrepancies,
matching inventories and current deployment evidence. Then explicitly run
`activate --apply reviewed-write-pause`. Activation atomically marks the audit
active and the control fenced/verified. Run deployed directory/assignment checks
and attach redacted evidence. No bearer material belongs in evidence.

## Failure and recovery

- Network, capacity or conditional failures do not advance the checkpoint. Check
  the actual process exit and control ownership before resuming the same run.
- Validation discrepancies produce `blocked`, retain bounded key/code findings
  in the table audit, and leave writes paused. Do not certify partial coverage.
- Investigate and authorise each source repair separately. The migration never
  deletes a dangling record or changes an identity just to pass verification.
- After repair, explicitly run `restart-blocked --apply reviewed-write-pause`.
  It archives the failed audit, advances pause ownership and restarts both scans.
  It retains profiles, alias groups, identity revisions and partial projections.
- If the control epoch has changed, stop: an older runner may not overwrite the
  current owner. There is no blind force/takeover or automatic unpause command.

Once the directory has been activated, deleting a game retains its historical
player associations and makes consolidation coverage unknown. Directory reuse
continues; consolidation requires another reviewed reconciliation. The UI shows
verified season names, not potentially stale game counts or kickoff statistics.
Changing a game's kickoff also invalidates coverage atomically with the game
update. Paused reconciliation repairs reverse-membership kickoff values from
their guarded game snapshots; both verification paths compare the authoritative
date before coverage can be certified again. Ordinary metadata-only edits do not
invalidate coverage.

After any consolidation exists, disabling further consolidations is safe;
deploying alias-unaware readers/writers is not. A mistaken consolidation needs a
checked compensating operation, never deletion of an alias pointer.

### Interrupted league removal

League removal creates an initiator-bound `LEAGUE#id / DELETION` receipt in the
same transaction as metadata removal and the identity tombstone. Invitation and
ACL cleanup then advances in bounded, strongly read pages; each page's deletions
and cursor are one transaction. A retryable `league_cleanup_pending` response
means removal is not yet confirmed, not that the league can be recreated.
The initiating account may retry the same DELETE after its ACL has disappeared;
this receipt grants no other access. A completed receipt retains safe response-loss
recovery. Invitation and access writers check live metadata in their transactions
so they cannot recreate authority behind the cleanup cursor.

Malformed invitation records stop cleanup without advancing that page. Inspect
and separately authorise repair of the exact conflicting record, then retry as
the initiating account. Never delete or fabricate a receipt/cursor to claim
completion. The ordinary identity write pause also fences cleanup transactions.
Retain receipt-aware deletion code during rollback while removals are pending.
Version 2 cleanup completes its profile-invitation pointer scan before deleting
unconsumed proofs, preserving scope provenance for older pointers lacking a
league field. Consumed proof records remain immutable ownership/retry receipts.
Older cleanup receipts, including completed ones, restart this expanded scan once
when their initiating account retries; they do not grant ordinary league access.
If a legacy pointer has no league field and its proof is already TTL-deleted,
cleanup leaves that unscoped record untouched rather than guessing its owner.
It cannot authorize a claim or bind replacement to the deleted league: the
existing invitation UI returns its expired proof ID, which a permitted organiser
can explicitly replace. Other malformed or contradictory provenance still fails
closed and requires checked repair.

## Acceptance evidence still required before PR2 publication

- Real disposable DynamoDB table: pause fences, complete scans, response loss,
  restart, malformed references, foreign aliases, activation and rollback bounds.
- Local HTTP/Lambda contract parity and a dedicated deployed QA strategy that
  does not mutate AJ's real profiles or pretend fixture coverage is table-wide.
- Current-head architecture/security and QA review of operator provenance and
  the writer inventory, plus exact-head CI/Codex review and the review gate.

This list is an implementation checkpoint, not a claim of completed acceptance.
