# Player stack: controlled production rollout

This is a release-preparation checklist, not permission to merge, deploy, migrate
or enable production features. AJ approves the exact final main SHA and each
production execution window. The existing identity-directory, claim-proof,
consolidation and returning-player runbooks remain authoritative.

## Prepared before merge

The Deploy Production workflow has been deliberately disabled in GitHub for this
stack's merge window. This is reversible and does not stop the currently deployed
site/API. CI and QA remain enabled. Do not re-enable it merely to merge a PR.

As-of read-only preflight on2026-09-12:

- No active production deployment runs were found; latest successful release
  was main60e3f8f3356f7fecf0f1a65b44bc504199831ea1.
- `3fc-prod-app` was ACTIVE. A consistent COUNT scan returned0 items and no
  continuation; this is an observed inventory, not a guarantee of future emptiness.
- Point-in-time recovery was enabled for35days. No restore or backup write was
  performed; recheck a recent recoverable point before cutover.
- `3fc-prod-api-core` was Active/Successful, with no function aliases and no new
  player feature variables. No identity CONTROL record was present.
- Existing runtime-role simulation allowed GetItem, BatchGetItem, Query, Scan,
  PutItem, UpdateItem and DeleteItem on the production table. This is a policy
  simulation, not live transaction or organisation-policy proof. The production
  operator profile can read table, backup and function configuration. No IAM or
  Terraform change was made.
- GitHub's production environment had no required reviewers. Workflow disabling
  is the temporary deployment hold, not a new approval policy. Future deployment
  variables are explicitly `PLAYER_CLAIM_MODE=proof`,
  `PLAYER_CONSOLIDATION_ENABLED=false`, `PLAYER_RETURNING_JOIN_ENABLED=false`.
  Setting these variables does not change the running Lambda.

The production migration initialises production's own records. It does not copy
QA games, profiles, consolidations or test fixtures. Any QA-to-production import
would be a separate explicitly reviewed and authorised operation.

## After AJ merges the complete stack

1. Keep the production workflow disabled. Fetch final main and verify all stack
   changes are present; record the full40-character SHA. Recheck workflow state
   and all queued, running, requested, pending and approval-waiting runs. Disabling
   a workflow does not cancel existing runs. Never rerun an intermediate stack
   deployment. Stop for unexpected work; do not cancel an active release blindly.
2. Obtain AJ's explicit authorisation for that final SHA's first deployment and
   the planned migration window. Inventory old/manual/local writers, aliases,
   scheduled jobs and API versions. No operator may start another deployment or
   make administrative table changes during cutover. Recheck backup protection.
3. Re-enable Deploy Production only for the authorised release. Re-enabling does
   not replay pushes missed while disabled. Dispatch `deploy-prod.yml` on ref
   `main`, with `expected_sha` equal to the approved SHA. The new manual path
   requires current remote main, event SHA and checkout SHA to agree, validates
   lint/tests/contracts before AWS credentials, then rechecks before deployment.
   An advancing main or stale queued run fails closed. The existing non-cancelling
   production concurrency lock remains. Freeze main changes for the release.
4. The workflow deploys API before site. Keep both opt-in flags false. Download
   `prod-api-core-deployment-<SHA>-<runId>-<attempt>` from this exact run and retain
   it in the private operational evidence folder. This artifact is uploaded
   immediately after successful core deployment, before later smoke/site work.
   Only `prod-release-<SHA>-<runId>-<attempt>` after all smoke/fingerprint checks
   indicates completed workflow acceptance. Compare its manifest to the live
   Lambda code hash, revision, table and feature settings; a green old run is not
   evidence for a different current function. Artifacts retain for90days; archive
   the approved manifests/audit for longer operational retention if required.
5. Disable the production workflow again and verify all deployment runs have
   drained. Wait at least905seconds after the new revision-aware API replaced the
   last old writer. Record actual drain completion, not a future timestamp. The
   migration CLI checks this even when the production table is empty.
6. From a clean checkout at the exact deployed SHA, prepare a production-specific
   migration manifest with independently verified account/tableARN, approved plan,
   writer SHA/version and completed drain time. Use the downloaded, unmodified
   API deployment manifest and an explicit production-authorised AWS profile.
   Follow [the directory cutover](player-identity-directory.md): `status`, then
   separately authorised `begin`, bounded `step` inventory/verification, inspect
   zero discrepancies and matching coverage, then `activate`. Apply the existing
   owned-process4GiB guard and never overlap runners. Do not reuse QA manifests.
7. During the write pause, identity/membership and relevant structure writes are
   unavailable; existing sign-in and read-only views remain. Before activation,
   the new player directory is unavailable. Plan this as a maintenance window,
   not a zero-interruption rollout. Any discrepancy leaves writes paused for
   investigation; do not delete, fabricate or force-verify records.
8. Verify production fenced/verified control and audited activation. Record
   read-only directory/assignment checks without creating real-player test data.
   Only with AJ's feature-activation authorisation set both opt-in environment
   variables true, re-enable and dispatch the same approved main SHA again.
   Verify live flags and accepted manifests, and complete authorised acceptance.
   Re-enable ordinary automatic releases only when the cutover window is closed.

## Failure and rollback

- No production deployment is exercised by this preparation PR. Local guard tests,
  CI and QA are not proof that a production release/migration has run.
- If core succeeds but site fails, the early API artifact remains useful, but the
  release is incomplete. Freeze deployments and inspect the actual API/site pair;
  do not rerun an unrelated/older release or relabel the run successful.
- If core fails before it produces a verified manifest (or artifact upload fails),
  stop. Inspect private runner/package evidence and live selected fingerprints;
  do not construct an accepted manifest from whichever Lambda happens to exist.
  A separately authorised exact-head redeployment may establish fresh evidence,
  and restarts the905-second drain. No migration begins without valid provenance.
- Do not log full Lambda environments, bearer links, cookies, request bodies,
  Serverless bundles/state or private source data. Publish only selected nonsecret
  fingerprints, audit counts and acceptance outcomes.
- After consolidation, retain alias-aware readers/writers. Disable new operations
  via the opt-in flags if necessary; reverting to pre-stack code is not a safe
  identity rollback. The separate parent#171 account-discovery scalability finding
  remains open; a currently empty production table is not a growth guarantee.

## Remaining gates, not actions already performed

Final-main SHA, final writer manifest, live writer inventory, completed drain,
production migration and feature activation cannot be certified before merge and
deployment. No manifest with guessed SHA/time has been created. Production
execution and release authorisation remain AJ's decisions.
