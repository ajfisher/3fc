# Player profiles: QA activation and acceptance

This is the final operational slice of the profile/card/achievement stack. QA is
`https://qa.3fc.football`, API `https://qa-api.3fc.football`, account
`301691475109`, region `ap-southeast-2`, table `3fc-qa-app`, profile `3fc-agent`.
These instructions grant no production or merge authority. AJ retains both.

## Evidence and prerequisites

Use a clean tracked checkout at the accepted stack head. Preserve the successful
QA run ID and both manifests from its `qa-api-core-deployment` artifact. Require
terminal passing CI and the actual `review-gate` check at that head; a successful
gate-evaluator workflow alone is insufficient. Keep the existing consolidation
and returning-join flags unchanged.

The QA-only provenance helper verifies the current head, gates, successful QA
run, caller/account/table, API package/revision/configuration and worker/transport
fingerprints. It builds the API freshly before loading its operator classes.
It rejects stale deployments and disabled features during acceptance. It never
activates flags or repairs readiness. Use one owned process-tree memory guard
around each complete invocation, including that build, with a 4 GiB ceiling.
Do not run another build/test/browser concurrently. Keep returned process IDs
until actual termination and verify children have exited.

Never print cookies, magic-link secrets, proof material, private account data,
full Lambda environments or raw SDK errors. Private recovery journals remain
local with mode0600 and must not enter Git, CI artifacts or screenshots.

## Backfill before exposure

1. Deploy the accepted head with profiles, achievements, owner editing and
   history processing disabled. Apply only the reviewed QA Terraform plan; the
   gallery route also has deployed static aliases. Inspect current identity
   coverage: fenced and verified are required. Do not edit control rows to
   simulate a completed migration.
2. Freeze `deploy-qa.yml`, drain queued/running/waiting/pending/requested runs,
   and record a drain time at least905seconds after the live core deployment.
   This freeze is part of the user-authorised QA activation. Preserve its prior
   workflow state. Existing scoring remains available.
3. Inventory all live QA league IDs with the read-only operator below, following
   every continuation, including an empty filtered page. It uses an explicitly
   administrative offline Scan of at most100keys per call; it adds no Scan to
   the application, browser or worker IAM. Save the completed identifier list from the private inventory journal; do not
   assemble completion from a subset of page outputs.
4. Follow [the history operator procedure](../player-history-operations.md) to
   activate once with the exact reviewed writer/worker manifests and drain
   evidence. Keep this activation manifest unchanged during the operation.
   Request each league rebuild and step the returned durable work reference
   until `done:true`. A page limit or successful delivery is not completion.
5. Exhaust both work and player recovery enumerations for each league. Process
   every returned directory/work/player reference; follow cursors even when
   no references are returned. Investigate failed sources before explicit
   recovery. Keep checkpoints and invalidated award history intact.
6. Run the bounded projection audit for each league. Require a current completed
   sweep, stable source/readiness/directory/identity fences, every active
   canonical player's complete publication, a career summary even for zero
   appearances, and agreement of per-match, season and career totals. Retain
   every continuation until the final `complete` result.
7. Run the existing non-publishing dry-run comparison for reviewed players,
   including zero/one/many appearances and historical timing uncertainty.
   Resume comparison IDs to completion. This compares career aggregates and
   achievement state; it is not proof of every season or historical unlock.
   The synthetic acceptance fixture supplies a separate known-source oracle.
8. Repeat the complete league inventory using a new private state file and compare
   the final `allLeagueIds` lists. A DynamoDB Scan is
   not a global snapshot. Changed inventories or source fences require the
   affected coverage to be checked again, not a claim of atomic completeness.

Run from the repository root under the process guard; substitute the accepted
head/run and exact returned continuation:

```sh
node scripts/qa/player-history-audit.mjs inventory \
  --head "$PROFILE_QA_HEAD" --run-id "$PROFILE_QA_RUN" --profile 3fc-agent \
  --state /absolute/private/inventory-before.json
# Repeat the same command until complete; use a new file for the after-pass.
node scripts/qa/player-history-audit.mjs audit \
  --head "$PROFILE_QA_HEAD" --run-id "$PROFILE_QA_RUN" --profile 3fc-agent \
  --league '<reviewed league ID>'
# Repeat audit with its --cursor until status is complete.
```

Inventory scan continuations can contain unrelated record keys, including session
identifiers. They are stored only in an owned0600 state file and never printed,
even as base64. Do not attach or decode that file into logs. The final `allLeagueIds`
list is safe to retain as coverage evidence. Reusing a completed state file replays
that saved result without scanning. Unique IDs and file size have explicit caps;
exceeding them fails rather than truncating coverage.

Audit continuations bind deployment scope and the records being assessed. They
are operator evidence, not a client API or authorization token. Do not modify
their content. A changed record invalidates the audit; restart that scope.
The audit proves projection consistency and coverage, not independent correctness
of the evaluator or every source goal. Keep focused rule-test and dry-run evidence.

## Enable the same head and exercise real services

Set only the QA environment variables `HISTORY_PROCESSING_ENABLED`,
`PLAYER_PROFILES_ENABLED`, `PLAYER_ACHIEVEMENTS_ENABLED` and
`PLAYER_OWNER_EDITING_ENABLED` to `true` after coverage succeeds. Restore the QA
workflow and rerun the accepted exact-head deployment. It deploys compatible
consumers before the API writer. Re-download its manifests and verify live
fingerprints. Do not reactivate history merely because configuration deployment
changed a Lambda revision: changing the activation manifest invalidates existing
publications unnecessarily.

The QA acceptance runner is opt-in. It uses new synthetic actors with real
magic-link completion and verified player claims; no email is delivered and no
existing user's credentials are read. It creates a clearly labelled league,
season and match through the real APIs. Its private journal retains immutable
request identities across a response loss or restart. It does not enable flags.

```sh
node scripts/qa/player-profile-acceptance.mjs --qa-synthetic \
  --head "$PROFILE_QA_HEAD" --run "$PROFILE_QA_RUN"
# The first run prints only its private state path. Resume with that exact file:
node scripts/qa/player-profile-acceptance.mjs --qa-synthetic \
  --head "$PROFILE_QA_HEAD" --run "$PROFILE_QA_RUN" \
  --state /absolute/private/printed-directory/state.json
```

Use the same accepted head/run on resume. An already-complete journal only repeats
synthetic-auth cleanup and deployment verification; it does not replay source
mutations. Completion is persisted after auth cleanup succeeds. Physical media
cleanup and browser sharing are explicitly not verified by this HTTP runner.

Validate authenticated safe profile/history/achievements, zero contributions,
another participant's reads, unrelated-player denial, owner-only account/name/
portrait writes, native image re-encoding and correction reconciliation. A
post-completion goal may restore aggregate achievements but must not gain timed
credit. Record cases that passed rather than treating the runner's existence as
deployed evidence.

After removing the fixture portraits through the owner API, verify physical
object cleanup and its durable job against each original upload lease. The
120-second lease is a lower boundary for abandoned-upload cleanup, not a deletion
SLA. Poll only the exact synthetic jobs and object keys. Do not manually delete
objects or job rows to make the check pass. End synthetic sessions. Retain the
labelled fixture graph: structural deletion invalidates identity coverage and
would require another audited migration/backfill.

Use an authenticated synthetic browser to inspect the deployed profile/gallery,
both themes and small screens, actual PNG dimensions/portrait pixels, focus and
retry behaviour. Verify site asset revision on each surface. Keep private traces
off. Physical iOS/Android native file sharing remains AJ's device acceptance;
desktop mocks of the Web Share API are not that evidence.

## Monitoring, stop rules and rollback

Inspect before, during and after processing: account concurrency, API latency,
Lambda errors/throttles, stream iterator age, queue age/depth, both failure queues,
durable failed jobs, generation coverage and source-to-publication lag. QA uses
shared unreserved Lambda capacity and at most two SQS workers; an empty queue
does not prove complete history or successful name/media work.

The six provisioned alarms currently have no recipient in Terraform. Do not invent
or notify a destination. For this attended QA acceptance window, record alarm and
metric inspections explicitly and report that automatic alert delivery has not
been verified. Unattended operational readiness and production release require
the team's approved destination and an alert-delivery check. This exception
does not waive checks or claim production readiness.

On growing lag, failed jobs, unexplained totals, media failure or resource
contention, stop activation and investigate. Disable the new exposure flags and
processing mappings if necessary through the reviewed serial QA deployment;
preserve source data, durable work, generations, receipts and unlock audit history.
Never purge data as rollback. Record the final QA head, feature state, coverage,
metrics and any remaining limitations before handing the stack to AJ.
