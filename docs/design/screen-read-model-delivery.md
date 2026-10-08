# Screen read model delivery plan

Approved direction: retain the single DynamoDB table, introduce direct lookup records
where queries currently traverse unrelated data, and assemble bounded responses around
each screen's initial task. Deliver small stacked PRs and measure each released slice.
AJ retains authority to merge and trigger production release automation.

## Production baseline

Measurements on 7 October 2026, authenticated desktop browser, no network or CPU
throttling; static assets were cached. CloudWatch endpoint aggregates cover
30 September–7 October. Endpoint aggregates are not complete page-load measurements.

| Read | Browser elapsed | Matching Lambda duration |
| --- | ---: | ---: |
| Home leagues, first visit | 10,961 ms | 10,919 ms |
| Home leagues, second visit | 13,026 ms | 12,983 ms |
| Match roster | 2,084 ms | 2,046 ms |
| Match private players | 2,555 ms | 2,515 ms |

The finished-match shell painted in 152 ms; largest content painted at 5,299 ms.
No initialization task exceeded 50 ms. Its sequential roster and private-player
requests consumed 4,639 ms. This does not establish live-scoring page timings.

| Successful production endpoint | Samples | Mean | p95 |
| --- | ---: | ---: | ---: |
| League context | 250 | 72 ms | 158 ms |
| League seasons | 15 | 71 ms | 142 ms |
| Season games | 19 | 957 ms | 1,590 ms |
| League player directory | 61 | 804 ms | 1,656 ms |
| Player profile | 79 | 428 ms | 703 ms |
| Player history | 30 | 308 ms | 516 ms |
| Player achievements | 43 | 423 ms | 636 ms |
| Owner profile | 4 | 90 ms | 120 ms |

DynamoDB service-side GetItem/Query means were 1.24/1.77 ms. These exclude SDK
and transport work. Home scanned the entire approximately 27.4 MB/24,920-item table,
possibly once for each verified account identifier. League listing changed from
850 ms mean (17 requests before the 5 October API deployment) to 10,602 ms
(29 after). The cause of the step change is not yet isolated.

## Screen access contracts

Every implemented contract specifies initial content, authority, work/response limits,
freshness, optional-section failure, pagination and cancellation. Current durable
records remain authoritative. A navigation index only discovers candidates; it
cannot grant permissions. All API bodies retain explicit schema validation.

| Screen | Initial content | Access model | Deferred work |
| --- | --- | --- | --- |
| Home | Accessible league page and management capability | Query direct account-to-league records; batch league metadata; verify ACL/deletion state | Bounded owned-profile discovery and continuation |
| League overview | League label/capabilities and season page | Existing metadata, ACL and scoped season keys | Directory and invitations |
| League Players | Scope and first logical matching page with truthful continuation | Existing directory indexes, batching and bounded physical search | Season filter labels and later pages |
| Season | Labels/capabilities, upcoming and recent game pages | Direct league-and-season-to-game records with batched current metadata | Older pages |
| Match setup | Context, team configuration and complete assignment state | Shared source-read service; batch identities once per request | Broader directory search and private admin details |
| Live scoring | Clock, scoreboard, recent timeline, authority and complete scorer/assister roster | Shared source-read service with reviewed coherence checks | Optional player enrichment |
| Finished match | Authoritative result, teams/thirds and timeline page | Shared source-read service without mandatory private-player enrichment | Roster editing and admin details |
| Player profile/Club Card | Identity, selected season, latest match, totals and capabilities | Existing published history generation; shared authorization/publication reads | History pages and portrait bytes |
| Achievements | Catalogue and progress for one player/scope/generation | Existing achievement publications | Unlock pages and optional media |
| Owner settings | Owner-only fields, revision and portrait availability | Dedicated owner-authorized read | Portrait bytes |
| Join/link/invite/consolidation | Minimal current-step context and actions | Existing proof and operation boundaries | Optimise only after page-level measurement |

BatchGet is not a multi-item snapshot. Match coherence needs transactional reads or
bounded revision fences; permission and canonical-identity checks remain mandatory.
Profile sections must agree on published generation and preserve updating/unavailable
states. Do not remove account revalidation until equivalent race safety is demonstrated.

## Independent PR stack

1. **Baseline and contracts:** this plan plus request-owned duration, SDK elapsed,
   call, retry and failure counters. No read-model changes. Compare overhead in QA.
2. **Home lookup preparation:** split into two independently deployable PRs to keep
   review and rollback small: first atomically maintain candidate-only account-to-league
   pointers with ACL writers (including exact retries) and deletion cleanup; then add
   resumable bounded backfill, reconciliation, explicit coverage and cutover controls.
   Continue old reads throughout both preparation PRs.
3. **Home cutover:** query pointers and batch metadata; verify authority, deletion,
   both account identifiers, pagination and participant discovery. Roll back the reader
   without removing records or reverting compatible writers.
4. **Finished match:** shared source-read service and bounded results response.
   Preserve finished corrections and scorer/assist semantics. Keep editor data optional.
5. **Setup/live match:** use the shared service for initial reads and owned refresh.
   Preserve full roster authority, clock/score coherence and uncertain-write barriers.
6. **Season lookup preparation:** direct scoped ordering keys with transactional
   create/change/delete maintenance; bounded backfill and coverage before cutover.
7. **Season cutover:** bounded upcoming/recent pages without full session traversal
   or duplicate game reads. Compatibility remains provenance-checked.
8. **Profiles/achievements:** compose existing published reads with shared request
   context and independently loadable optional sections. Owner-only fields stay separate.

Use codex feature branches and Conventional Commits. Each child targets its reviewed
parent; rebasing or updating a head requires new validation/review for that head.
Do not begin the next slice until the current slice's local reviews, CI, deployed QA,
review gate and external Codex review have passed. Preparation/cutover pairs can be
reviewed as a stack, but each preparation release remains independently deployable.
After a cutover is deployed to production, pause for measured impact before extending
that pattern. AJ's merge/release decision is a required checkpoint, not agent authority.

New record namespaces require an audit of prefix queries, type filters, deletion,
rollback and transaction limits. Maintenance precedes backfill; reconciliation must
establish completeness before readers switch. Missing/incomplete coverage must never
silently become an empty list. Rebuilds/backfills are administrative operations, not
request-path scans. Define reversal for coverage controls and partial migrations.

## Review and release protocol

- Primary agent owns implementation and validation. Run one intensive local command
  at a time, monitor its complete process group under a 4 GiB RSS ceiling, preserve
  session identifiers and observe exit/child cleanup. Use focused tests before suites.
- Before push, request independent QA, architecture, security and engineering reviews.
  Review agents are read-only: no edits, tests, browser runs, pushes or deployments.
  Schedule reviewers in waves within available concurrency. They report concrete
  failure scenarios, source citations, invariant impact and suggested changes.
- Fix findings centrally, validate affected scope and obtain follow-up review. Record
  rejected findings with evidence. Preserve the repository review-packet interface.
- Push only after local review disposition. Then run CI and the shared QA deployment
  using QA-ready; do not interrupt another deployment or change production.
- Require a completed passing review-gate and external Codex review for the current
  head. Pending, cancelled, skipped, stale or label-only evidence is insufficient.
  Resolve findings and rerun all invalidated gates after every head change.
- Hand the PR to AJ for final review. Never merge, enable auto-merge, enqueue a merge
  or dispatch production release without specific authorization.

## Measurement and acceptance

Proposed controlled warm-QA budgets: useful home/league/season/directory/results/profile
content within 1 second; setup/live controls actionable within 1.5 seconds. Backend
p95 target: navigation below 500 ms, match composition below 800 ms. These are budgets,
not promises; report cold starts, uncached assets and mobile separately.

Measure time to useful content and actionable controls, API median/p95, SDK commands,
elapsed time and retries, bytes read/returned when supported, write overhead and errors.
Counters must not log bodies, database keys, credentials, proof secrets or account IDs.
Existing request-log privacy is a separate concern from newly added numeric counters.
Use safe route templates for newly introduced screen analytics.

First-slice request_complete.performance fields are durationMs, dbCalls, dbElapsedMs,
dbRetries and dbFailures. SDK elapsed includes transport, deserialization and retries,
not just DynamoDB service latency; parallel calls can make its sum exceed durationMs.
Application-level retries increase dbCalls. SDK attempts after the first increase
dbRetries. Counters are scoped to the handler's async execution and omit background
work started outside a request. They do not measure browser readiness, network transfer,
Lambda initialization, response transmission or SDK calls settling after handler return.
Only the primary DynamoDB client shared by API dependencies is instrumented; health
Lambda and history workers retain their existing logs. No additional AWS resources,
permissions, settings, dependencies or request retries are introduced by slice 1.

Scale acceptance must demonstrate that unrelated history growth does not increase
home read work, and older games do not increase fixed-size season page work. Race tests
cover account changes, revoked access, consolidation, corrections, stale cursors,
partial backfill, retries and uncertain writes. Preserve INV-001/002/003/004/005/006/008/009.
Existing public results/standings/leaderboards backlog scope remains separate.

Compression and Lambda sizing are later independent experiments so their benefit can
be measured without confounding the read-model releases.

## Home writer preparation (phase 2a)

The dedicated `HOME_ACCOUNT#<SHA-256 of exact account identifier>` partition and
`LEAGUE#<SHA-256 of league identifier>` sort key keep keys bounded and avoid copying
account identifiers into the pointer. The payload contains only leagueId and version 1;
roles and league metadata remain authoritative in their existing records. Create,
grant and invitation transactions maintain pointers atomically, including fenced
no-op repairs. League deletion removes each pointer with its ACL and page checkpoint
(25 ACLs plus 25 pointers stay below the 100-action transaction limit).

This preparation does not enable a new reader, certify coverage, backfill existing
ACLs or change permissions. Existing scan readers ignore the new entity type. A revert
leaves harmless candidate records; coverage is still unavailable. Before any future
reader cutover, phase 2b must verify deployed writer continuity and existing ACL
coverage. After cutover, reverting these writers requires disabling indexed reads
and invalidating coverage first. Pointer records alone never grant access.

## Home coverage preparation (phase 2b)

The operator-only `scripts/home-league-coverage.mjs` uses a clean checkout at the
reviewed deployed writer SHA, explicit AWS profile, deployment manifest, account,
region and table provenance. It reuses existing fingerprint/drain validation:
record drainedAt after the deployment plus Lambda's maximum invocation window
(905 seconds), rather than assuming the current timeout bounds old invocations.
Freeze and drain the target deployment workflow during reconciliation; all active
application writers must be compatible. This procedure does not pause identity
writes or invalidate player-history projections. Production operations require
AJ's release/cutover decision. No production migration is executed by this PR.

Create a manifest with migrationId, accountId, region, tableArn, tableName,
writerSha (40-character reviewed commit), writerVersion:1, reviewedPlan (PR URL),
and drainedAt (ISO timestamp). Pass the deployment manifest produced by the
existing deployment workflow. From the repository root, under the normal resource
guard, use:

```sh
node scripts/home-league-coverage.mjs status --manifest <coverage.json> --deployment-manifest <api-core-deploy-manifest.json> --profile <profile>
node scripts/home-league-coverage.mjs begin --manifest <coverage.json> --deployment-manifest <api-core-deploy-manifest.json> --profile <profile> --apply reviewed-home-lookups
node scripts/home-league-coverage.mjs step --manifest <coverage.json> --deployment-manifest <api-core-deploy-manifest.json> --profile <profile> --apply reviewed-home-lookups
```

Each page scans at most 25 physical records with strong consistency. Step defaults
to one page; --pages accepts 1–100 to amortise the fresh build, rechecking provenance
and the frozen/drained deployment workflow before every page. Batches stop on ready
or on the first error; checkpoints remain page-sized. Valid live
ACLs get candidate pointers with source/league fences, then a separate bounded
verification pass checks pointers against live ACLs. Missing league metadata
excludes orphan ACLs under an absence fence. Malformed reserved ACLs, missing
verification pointers, stale manifests and transaction races prevent readiness
and preserve the checkpoint. A lost response may have committed; consult status
before repeating. Counts report work, not a table-wide snapshot equality proof.
Compatible atomic writers preserve coverage during concurrent changes. The control
and a full page commit together in at most 76 actions before identical checks
are deduplicated. Empty pages with a continuation never count as completion.

`HOME_LOOKUP / CONTROL` (`homeLeagueCoverage`) owns phase, manifest, epoch,
physical cursor and aggregate counters. It has no TTL and grants no authority.
Phases are backfill, verification, ready and disabled. Ready coverage alone does
not enable indexed reads. `disable` uses the same explicit arguments/apply token,
invalidates coverage and clears its cursor; a new begin uses a new epoch. Never
change the manifest of an active run. Reconcile changed source records or disable
and restart rather than bypassing a failed page. Before a writer rollback, disable
indexed reads and coverage using the still-pinned deployed writer, then release
the rollback. Retain pointers for recovery. Reader cutover remains phase 3.

Administrative writers are part of continuity: forbid direct ACL imports/repairs
throughout reconciliation and active indexed reads unless they also maintain
pointers or first disable coverage/readers. The existing season import executor
requires a destination containing only identity-system/disabled-history records
and checks its exact checkpoint inventory before writes; it rejects HOME_LOOKUP
control and candidate records. Imports into a fresh destination therefore precede
home backfill and coverage verification. Existing administrative import guards
are retained and tested; no import may run concurrently with reconciliation.
