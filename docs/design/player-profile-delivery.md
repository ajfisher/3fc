# Player profiles and achievements delivery

Approved 3 October 2026. This is implementation work in progress, not a deployment
or readiness claim. The [approved brief](player-profile-brief.md) supersedes the
design study's unresolved decisions and 19-class launch scope.

## Work items

| Backlog | GitHub | Responsibility |
| --- | --- | --- |
| M3-14 | [#199](https://github.com/ajfisher/3fc/issues/199) | Approved scope, shared catalogue and contracts |
| M3-08 | [#139](https://github.com/ajfisher/3fc/issues/139) | Existing complete linked-history foundation and participant home |
| M3-06 | [#37](https://github.com/ajfisher/3fc/issues/37) | Existing profile statistics and paginated match log |
| M3-10 | [#200](https://github.com/ajfisher/3fc/issues/200) | History projections, work pipeline and backfill |
| M3-11 | [#201](https://github.com/ajfisher/3fc/issues/201) | All 23 achievement rules and correction-safe unlock history |
| M3-13 | [#202](https://github.com/ajfisher/3fc/issues/202) | Verified-owner name/photo editing and private media |
| M3-12 | [#203](https://github.com/ajfisher/3fc/issues/203) | Club Card export and in-app achievement gallery |

M3-08 remains a dependency, not presumed complete. Its history foundation is
reactivated by this build; its participant-home scope remains tracked separately.
No projection-only PR will claim to close all of #139. Likewise #37 is closed only
when its full profile/history responsibilities are delivered. Current-main review
at fa7e775 found no newer profile/history implementation to duplicate.

## Stack and gates

1. Scope, catalogue, milestone arithmetic and safe presentation contracts (#199):
   ready for AJ's final review in PR #204. Excludes all runtime endpoints/UI.
2. Pure evaluator for all 23 classes (#201): ready for AJ's final review in PR #205;
   excludes persistence, source adapters and workers.
3. Complete canonical history and generation persistence (#139 foundation, #200,
   remainder of #201): ready for AJ's final review in PR #206.
   Durable source markers are ready for AJ in PR #207.
   Streams/SQS delivery, worker and resumable backfill follow before any runtime
   reader is enabled.
4. Authorised profile/history routes and owner name/photo/media (#37, #202): pending.
5. Profile UI, card/export and achievement gallery (#37, #203): pending.
6. Serialised QA coverage verification and feature activation: pending.

Each child PR bases on the preceding reviewed PR. Before starting the next slice:
complete independent sub-agent reviews, address findings, run focused validation,
then obtain a completed passing review gate for that slice's current head. Review
agents remain read-only and do not launch tests; the primary agent serialises local
validation under the 4 GiB process-tree ceiling. QA deployments are serialised.
Record each PR and evidence here as created.

Slice 1: [PR #204](https://github.com/ajfisher/3fc/pull/204), base `main`, branch
`codex/player-profiles`. Two read-only sub-agent reviews passed after scope/privacy
fixes. The first automated review identified scope-ID type combinations and missing
backlog issue IDs; both were accepted, fixed and re-reviewed. Eight focused tests,
API test compilation and backlog validation/export pass after those fixes (owned
group 99481, exit 0, peak 497040 KiB, no remaining children). Corrected head `f38c9a3c2358c8e718f731c23df8962428fbe996` passed
CI 37112836386, QA 37112836382 and current-head review-gate check 111173947603.
Cloud review completed with no major issues for that head on 3 October 2026.
The evaluator child started only after these checks and both sub-agent passes.
PR #204 remains unmerged; AJ retains final merge authority.

Slice 2: [PR #205](https://github.com/ajfisher/3fc/pull/205), base
`codex/player-profiles`, branch `codex/achievement-evaluator`. Two independent
sub-agent reviews passed after rule, uncertainty and replay fixes. All 34 focused
evaluator/contract tests and API test compilation passed (owned group 1900, exit 0,
peak 515440 KiB, no remaining children). Head
`38e2689455a25d97409c20a86fe5e25e984fe199` passed CI 37114047673, QA 37114049956
and review-gate check 111177243508. Cloud review completed with no major issues
on 3 October 2026. The history child started after these gates. PR #205 remains
unmerged for AJ.

Slice 3: [PR #206](https://github.com/ajfisher/3fc/pull/206),
`codex/player-history-foundation`, based on PR #205. Implements raw
paginated source reads, canonical fact assembly and immutable history generations.
Independent source/store reviews resolved uncertain legacy timing, exact-completion
provenance and mismatched source-revision findings. Cloud review then identified
unusable legacy audit timestamps rejecting valid aggregates; the fix preserves
credit while excluding the audit from timing proof and passed independent review.
The same boundary now handles missing goal creation time, unusable audit snapshots
and damaged duplicate creation evidence without inventing timestamps or certainty.
All 59 focused contracts,
evaluator, source and store tests pass after fixes, including concurrent evaluation,
lost acknowledgements and interrupted milestone staging (owned group 8221, exit 0,
peak 515360 KiB, no remaining children). API test compilation and backlog
validation/export pass. Corrected head `f2f64784847bd507ab895ed2a9b4a176cc4daddb`
passed CI 37118843772, QA 37118843773 and current-head review-gate check
111190835269. Cloud review completed with no major issues at that head (comment
5968621134); both accepted review threads are resolved. PR remains unmerged for AJ.
The writer child resumed after these gates. No runtime reader or worker is enabled
by this foundation.

AJ retains merge and production-release authority. All new capabilities remain
behind separate profiles, owner-editing and achievements flags until coverage and
QA gates pass. No mock portrait, demo account or fixture statistics ship as defaults.

## Architecture

The canonical scoring record remains authoritative. Profiles use revision-fenced
read projections; no browser league-history fan-out. Source mutations atomically
record durable work. A Streams dispatcher delivers SQS work to a bounded worker.
Season/career history and achievements share canonical identity and contribution
facts. Every milestone has durable evidence and correction history.

Owner writes are separate from league management. Private account fields never
enter performance projections or exports. Portraits are validated, re-encoded
and held in private storage. See [ADR 0002](../decisions/0002-player-profile-authority-and-achievements.md).

Slice 4: `codex/player-history-writers`, based on PR #206. Adds atomic source
revisions and work markers to completion, goal/roster/kickoff corrections, identity
consolidation and scope deletion. Two independent reviews resolved omitted legacy
normalization/repair paths, then passed the final diff. Five focused repair cases,
the complete writer file and the broader helper/writer/consolidation/repository
suites passed in sequence: 230 tests, group 11012 exit 0, peak 187936 KiB, no
remaining children. Contracts build, API compilation, backlog validation/export
and diff check pass. Final current-head evidence follows below. Streams/SQS delivery,
backfill and runtime feature exposure remain separate subsequent slices.


PR #207 cloud review identified transient cross-game transaction contention on
shared league revisions. The accepted fix adds three bounded jittered retries for
explicit no-commit conflicts only; conditional and ambiguous failures retain their
existing recovery. Two independent reviews pass. Five focused cases, both affected
files and all 235 helper/writer/consolidation/repository tests pass (group 12900,
exit 0, no remaining children). Corrected head `5661e8c4b19e594f22a7230b0154abd551622fd7` passed CI
37120894205, QA 37120894153 and current-head review-gate check 111196642239.
Cloud review reported no major issues (comment 5968908908). Worker implementation
resumed after those gates. PR #207 remains unmerged for AJ.


Slice 5: `codex/player-history-worker`, based on PR #207. Implements resumable
source collection, durable directory fanout/verification, bounded Streams/SQS
processing, readiness activation, isolated career-summary comparison and recovery.
Two independent collector/transport reviews and a full privacy/infra review pass.
All 349 affected tests pass after batching refinements (group 15929, exit 0, peak
179120 KiB, no remaining children). API test compilation and the 47 focused cases
pass (group 15823, exit 0, peak 555888 KiB). Backlog validation/export and diff check
pass. QA Terraform init/validation and reviewed plan/apply succeeded: 15 additions,
3 updates, zero deletions (apply group 16007, exit 0, peak 744464 KiB). Consumers
remain disabled. Local Serverless packaging could not authenticate; the existing
credentialed QA workflow must verify actual packaging, deployment and fingerprints.
Full `make build` passed (group 16586, exit 0, peak 622096 KiB, no children).
Remote current-head checks are pending. Readers, owner media and app UI follow;
this slice does not claim user-visible feature completion.


Initial slice-5 CI found an outdated assertion expecting a single manifest path;
the workflow now preserves both API and worker evidence. The corrected single case
and full 13-test deployment file pass. QA packaging succeeded but AWS rejected
reserved concurrency because this account has 10 total/unreserved slots and must
retain 10 unreserved. The fix uses shared capacity, retains SQS maximum concurrency
2 and stream parallelism 1 per shard, and uses Node 22 for the new functions.
Seven operator/deployment tests pass (group 19559, exit 0, no children). Processing
remains disabled; capacity/throttling checks precede activation. Revised-head
remote checks and independent delta review must pass before the read slice starts.


At `6a5a39b`, CI passed and QA CloudFormation deployed both Node 22 functions.
The post-deploy verifier exposed AWS CLI's successful empty concurrency response.
A narrow parser fix accepts that empty response only for get-function-concurrency;
all other malformed/empty responses still fail. Six deployment tests and a read-only
live QA configuration check pass (groups 20031/20041, exit 0, no children). The
live check validates disabled mappings, roles and transport; package provenance
still requires the corrected-head workflow manifest. Independent delta review
precedes the final push and gates.


Cloud finding 4173226563 was accepted: final comparison persistence now fences the
exact observed publication (including absence), so a same-source publication cannot
race its final read. Two real concurrent-publication cases pass, then all 18
coordinator cases and 366 affected regression/deployment tests pass (group 20628,
exit 0, peak 182272 KiB, no children). Independent source/evidence review passes.
Fresh current-head CI, QA and review gates are required after this fix.
