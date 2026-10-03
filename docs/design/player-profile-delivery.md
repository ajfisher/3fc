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
   Streams/SQS delivery, worker and resumable backfill are reviewed in PR #208.
   Consumers remain disabled until the final QA activation.
4. Authorised profile/history routes and owner name/photo/media (#37, #202):
   reviewed in PRs #209, #210 and #211.
5. Profile and owner-settings UI (#37, #202): reviewed in PR #212.
   Card/export and achievement gallery (#203): next stacked slice in progress.
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


Cloud finding 4173244879 was accepted: worker IAM drops unused UpdateItem/DeleteItem,
requires explicit source partition families for reads/checks, and permits Put only
in player-history and league partitions. The residual shared league sort-key boundary
is documented. Seven policy/deployment tests and independent review pass. QA applied
one policy update, no additions/deletions (group 23095, exit 0, no children); AWS IAM
simulation confirmed all 54 allow/deny cases (group 23146, exit 0, no children).
Private raw staging/transaction metadata is explicitly distinguished from safe
performance projections in the ownership documentation. Fresh final-head gates follow.

Cloud finding 4173265572 was accepted: directory revisions now trigger durable
reconciliation, covering newly activated players with zero appearances after the
initial backfill. The worker coalesces current revisions into an atomic receipt
and ordinary work marker. Recovery discovers an unprocessed directory revision
without depending on stream retention; duplicate delivery and lost acknowledgements
reuse the committed work. The local operator can step the same directory reference.
Final validation and current-head checks follow this correction.

Directory correction validation passed: 13 focused cases, all 55 directly affected
cases, then 379 history/scoring/import/deployment regressions (group 24373, exit 0,
peak 130688 KiB, no remaining children). API test compilation and diff check pass.
Independent runtime/privacy review passed after strict receipt validation was shared
with recovery. Processing remains disabled pending the final feature rollout.

PR #208 final worker head `f12fdd4f4f1c9f53effa16e49a17bce23cd5d922`
passed CI 37125666023, QA 37125666039 and current-head review-gate check
111210365385. Independent reviews passed and all accepted review threads are
resolved. The read/API child `codex/player-profile-reads` started after these gates.
PR #208 remains unmerged for AJ; workers are deployed but not activated yet.

Late PR #208 operational finding 4173337529 was fixed separately: pending-work
inspection remains read-only before activation and during rollback; processing still
requires enabled readiness. Corrected parent head
`6ed733b051dfdf6989396b1b37d115eee2f7dedf` passed CI 37126803739, QA
37126803757 and current-head review-gate 111213674622. All accepted threads are
resolved. The child retains this correction in its ancestry.

Slice 6: `codex/player-profile-reads`, based on PR #208. Adds verified participant
and ACL read access, bounded private identity discovery, shared local/Lambda safe
profile/history/achievement routes, complete default-season derivation and retained
first-unlock metadata. Separate read/privacy, access, season/evaluator and deployment
reviews pass after legacy date and incomplete-summary fixes. Four focused completeness
cases and all31 read/store/route cases passed, followed by 525 affected regressions
(group30386, exit0, peak189872KiB, no children). Full build and backlog
validation/export passed (group31717, exit0, peak716400KiB, no children). OpenAPI YAML
parses successfully. Current-head remote gates follow before owner-editing work.


Slice 6 is [PR #209](https://github.com/ajfisher/3fc/pull/209), based on
`codex/player-history-worker`. Initial head `6502bca` passed CI37127444524 and
QA37127829482. Cloud review found duplicate canonical players across discovery
pages. The accepted fix deterministically selects one representative claim per
canonical root across bounded member/account lookups, with revision fences and
no growing cursor. Seven focused cases, all16 access cases and76 related profile,
identity, consolidation and returning-join tests pass (group33280 exit0,
peak81248KiB, no children). API test compilation passes. Fresh current-head CI,
QA and review-gate evidence is required before owner editing begins.


Corrected PR #209 head `8f11120dc15aa60af23dd431a66fe86d5b3de728` passed
CI37128427357, QA37128427395 and actual current-head review-gate111218443808.
Both independent delta reviews passed; cloud review found no major issues
(comment5969975941). The owner-name child began after these gates.

Slice7: `codex/player-owner-name`, based on PR #209. Adds verified-owner private
reads and canonical name changes with atomic durable directory work. Independent
owner/API, transport/privacy and worker reviews passed after a cursor-validation
fix. All46 focused tests and517 affected regression tests pass (group34766 exit0,
peak250048KiB, no children). Full build, backlog validation/export, OpenAPI parsing,
shell syntax, Terraform fmt/validate and diff check pass. QA Terraform applied one
scoped worker IAM policy change, zero additions/deletions (group36759 exit0,
peak731184KiB, no children). Portraits and owner UI remain separate next slices;
this does not close #202. Remote current-head gates are required before proceeding.


Slice7 is [PR #210](https://github.com/ajfisher/3fc/pull/210). Initial head9408e28
passed CI37129966862 and QA37129988516. Cloud review found two rollout/retry issues:
consumer/filter deployment must precede the API producer, and exact committed
requests must replay during processing pauses after current ownership checks.
Both fixes passed independent review, three focused tests, all16 affected-file
cases and518 related regressions (group37846 exit0, peak266288KiB, no children).
API compilation passes. Live QA IAM simulation passed70 expected boundary cases
(group37129 exit0, no children). Fresh current-head remote gates are required.


PR #210 corrected head `5e6d60dad9aa1edfd5c531500fdb3bf25075de60` passed
CI37130555866, QA37130555871 and actual current-head review-gate111224663869.
Cloud review completed without major findings (comment5970244326). Portrait child
`codex/player-portraits` began after those gates. It adds processed private media,
owner-fenced upload/removal, authenticated portrait reads and durable cleanup,
including retirement after consolidation. Owner/card/gallery screens follow.

Portrait slice validation: all559 affected tests pass (group44531 exit0,
peak188736KiB, no children), full build/backlog and Terraform validation pass
(group46222 exit0, peak725984KiB). QA plan/apply added seven private media resources,
changed/deleted none (group46564 exit0). Live QA media IAM32 cases and bucket
privacy/encryption/ownership checks pass (group46729 exit0). Actual native dependency
ZIP verification passes after correcting Sharp0.35.5 entry/addon filenames from
inspected package contents; all14 related deployment/operator tests pass
(group46930 exit0). Independent service, worker, route and media/infra reviews and
fix delta reviews pass. Native Lambda execution remains a QA acceptance check.


Portrait slice is [PR #211](https://github.com/ajfisher/3fc/pull/211). Initial
head46837de passed CI37132468087; QA37132469202 safely stopped before core deployment
because npm retained a foreign native addon. Packaging now prunes only foreign
Sharp packages inside the validated generated dependency tree, sequentially after
installation, with refusal/retention regressions. Cloud finding4173704477 was
accepted: concurrent identical uploads reuse the winning reservation and recover
lost acknowledgements; initial and later receipt races refresh current ownership.
Cleanup retains the original upload lease to avoid late duplicate puts recreating
deleted objects. Independent delta review passed. Seven focused race cases,
all26 changed-file cases and all566 affected regressions pass (group47963 exit0,
peak189296KiB, no children). API compilation, YAML and diff checks pass; fresh
current-head CI/QA/review follow before the UI child begins.


PR #211 final head `11c98bc0d519579ba33afac411b834eee8d9d829` passed
CI37134127263, QA37134127269 and actual current-head review-gate111235061868.
Cloud review completed without major findings (comment5970729075). The accepted
timeout finding is fixed with a verified28s core budget. QA also revealed that
Serverless cleans the ZIP after deploying it; its verified digest is now captured
before deployment, with an executable regression. All30 affected deployment/operator
cases pass (group50540 exit0, peak111968KiB, no children) and independent delta
review passes. UI child `codex/player-profile-ui` started after these gates.
Native authenticated photo acceptance remains part of final feature QA.

## Profile and owner screens

The next slice adds fixed `/player` and `/player-settings` routes with local/static
asset parity and safe authentication return links. Separate browser controllers
share a validated, cookie-authenticated client. The profile retains only safe
performance DTOs; the settings controller owns private email, drafts and temporary
photo bytes. Neither controller persists those values in browser storage.

The main view opens on the originating/default season, renders authoritative
Last game/Season/Career statistics and keeps the latest completed team totals
visible. Match history loads20 entries per explicit action and refuses mixed
projection revisions. Unavailable history remains unknown. League participation
is discovered through bounded authorised pages, without granting management rights.
Relevant directory, roster and result names link to the profile with season context.

Owner editing validates source type/8MiB/16MP before decoding, offers a keyboard
operable512px crop, and submits only the processed crop to the owner API. Ambiguous
saves retry the identical key/body; conflicts preserve drafts and require refresh.
Successful receipts are followed by fresh reads before displaying current state.
Signout, account uncertainty, proof invalidation and BFCache transitions clear or
hide private content and fence late responses. Read-only email stays on settings.

Validation:29 focused client/profile/settings/crop/shell tests pass (group54151,
exit0, peak203600KiB),538 affected navigation/auth/scoring/static/server regressions
pass (group54233, exit0, peak2706880KiB), and final9 profile/shell cases pass after
season-picker refinement (group54596, exit0, peak187344KiB). All10 serial browser
checks pass at320/390/430/1280px in light/dark, with keyboard cropping, focus return,
200% text and long names (group54604, exit0, peak1021232KiB). Every group left no
children and remained under4GiB. Browser fixtures are synthetic test data, never
application defaults. Independent navigation and full client/settings privacy
reviews pass after recorded lifecycle/unknown-state fixes. Card/gallery and final
QA activation remain subsequent slices; no release-complete claim is made here.

QA route infrastructure applied:0 additions,1 CloudFront function update,0 deletions
(group55009 exit0, peak723232KiB, no children). The initial plan exposed removal
of the bucket's existing SSE-C block; explicit configuration preserves it, leaving
only the router in the accepted plan. Independent review and5 deployment cases
pass (group54962 exit0). Production infrastructure was not applied.


PR #212 final head `689f7f7fcc7cac647afe41a86335caa99c04a50e` passed CI
37137103016, QA 37137103024 and current-head review-gate check 111243776630.
Cloud review reported no major issues (comment5971128921). Its accepted portrait
finding is fixed: owner settings requires league context before any private read,
loads the canonical portrait and preserves the originating season/viewer. Independent
review and18 focused,515 affected integration and11 real-browser checks pass.
PR remains unmerged. The card/gallery child began only after these gates.


Slice10: `codex/player-card-gallery`, based on PR #212, implements the approved
Club Card front/five-honour reverse and1200×1560PNG export, native file sharing,
and all23 achievement gallery entries with personal scopes, filters and bounded
unlock history. Two independent review passes resolved account/revocation,
visibility, uncertainty, date and SVG-sizing findings. Final local validation:
14 card lifecycle cases,35 model/gallery/profile cases,536 affected app cases,
22 integrated browser checks plus one real portrait export/pixel check, and57
review-gate tests pass. Every owned process exited0 without children; maximum
measured RSS2588896KiB. Exported fronts/reverses and light/dark mobile galleries
were visually inspected. Remote gates and final QA activation follow. Physical
mobile OS file sharing remains AJ's device acceptance; browser user-activation
and cancellation behavior are covered. Local AWS SSO expired before the new
CloudFront function could be applied; static HTML aliases support the route on
the existing distribution. No production operation was performed.
