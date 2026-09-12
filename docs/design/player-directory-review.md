<!-- review-packet-version:1 -->

## Behavioural claim

League organisers and scorers can find reusable claimed or unclaimed players in
their league, filter by season and add an existing identity to a game exactly
once. Organisers can create a league-only player and privately invite that player
to link an account. Existing profile, registration and scoring IDs remain intact.

Implements #159, stacked on #164; #25 remains subject to its full acceptance audit.
Consolidation #160 and returning-player joining #161 are not implemented here.

## Specification and acceptance evidence

| Criterion | Evidence | State |
| --- | --- | --- |
| Scoped directory, cursor continuity, claimed/unclaimed and duplicate names | Repository directory tests, route schemas, league/picker interaction cases | PASS locally |
| Existing-player registration, atomic optional team, uncertainty and locks | Repository transactions, frozen-request picker tests, complete interaction suite | PASS locally |
| League-only private invitation lifecycle | Shared local/Lambda adapter and repository tests, shared invitation UI tests | PASS locally |
| Accessible drafts, suggestions and focus | Nested disclosure regressions, possible-name suggestions, contextual accessible picker actions | PASS locally |
| Historical IDs and canonical compatibility | Root/alias planner cases; getPlayerView preserves original IDs and raw proof records; long ASCII/Unicode read-envelope cases | PASS locally |
| Migration completeness, pause, retry and cutover | Fake-client cases, CLI provenance tests, actual isolated AWS CLI audit/restart/recovery/activation on `74830fe` | PASS; current-head refresh pending |
| HTTP parsing and privacy headers | Real loopback socket test of local directory/invitation adapters | PASS locally |
| Full repository validation | Serial lint/typecheck, 415 API / 601 app / 3 operator / 57 gate tests, contracts, build; group 12573, peak 2,859,472 KiB, exit 0, remaining []; final legacy-expiry regression and all 184 affected-file tests also pass | PASS locally including review fixes |
| Interrupted league deletion and account-bound retry | Repository lost-response/pagination/race/corruption tests; Lambda owner/malformed/account-switch cases; reload/Home UI cases; real local HTTP group 8261 | PASS locally |
| Exact-head CI, Codex, isolated backend and browser acceptance | To be recorded in PR evidence | PENDING |

## Change classification

- Declared risk: `high`
- [x] `application-behaviour`
- [x] `public-contract`
- [x] `permission-trust-boundary`
- [x] `durable-state-ownership`
- [x] `privacy-regulated-data`
- [x] `infrastructure-production-configuration`

## Architecture and invariants

- [x] `architecture:documented`

INV-001/002: league ACLs are checked again in the committing transaction; directory
DTOs contain no account IDs or email. Claims still require explicit private proof.
INV-003/004: original records and event IDs remain unchanged. Root revisions,
directory/reverse-membership projections and deletion tombstones share bounded
transactions. Migration does not certify coverage while old writers can bypass it.
INV-005: no scoring, assist, winner or undo computation is changed.
INV-009: existing sessions and proof transport remain; new endpoints are private,
no-store and no-referrer. No new runtime dependencies or production IAM changes.

`getPlayerView` is a presentation-only compatibility interface. Raw `getPlayer`
remains authoritative for proof/ownership operations. Before PR3 can create
aliases, its roster/join/admin readers must consume the canonical presentation
while retaining each game's original registered IDs; that integration is a
blocking PR3 acceptance item, not claimed enabled here.

## Failure and rollback

Unconfirmed writes preserve their original request and identity. Pending picker
reads cannot replace the retry target. Incomplete/corrupt membership fails closed.
Migration owns a reviewed write pause, pinned executable/deployment fingerprint,
complete inventory and verification scans. Failed pages do not advance coverage;
blocked restart archives the failed attempt. See
`docs/runbooks/player-identity-directory.md` for operator commands and recovery.

No production migration, merge or release is authorised. Shared QA is not
repointed or marked verified for fixture acceptance. Once aliases are introduced
by the child feature, rollback must retain alias-aware readers and writers.

## Independent findings and disposition

- Codex review 5174641765 on `e255574`: accepted stale kickoff coverage and
  residual league profile-invitation findings. Rescheduling now invalidates
  coverage in the same transaction as metadata; reconciliation repairs the date
  with original membership CAS and both verification paths compare it. Deletion
  sweeps profile pointers before unconsumed proofs, preserves consumed ownership
  receipts and upgrades older deletion receipts. Independent QA identified an
  unordered-scan legacy-pointer trap; the two complete passes and adversarial
  proof-first/later-pointer regression address it. All 183 affected-file tests
  passed, including cross-league replacement after migrated historical sharing,
  consumed replay, expired proof, failed reschedule atomicity and changed-date
  verification rejection. Full validation passed (415 API/601 app/3 operator/57
  gate); final expired-unscoped policy then passed alone and in all 184 affected
  tests (group 15622, peak 602,976 KiB, exit 0, remaining []). Real local HTTP and
  capped DynamoDB acceptance passed again (group 15695, peak 224,112 KiB plus
  512 MiB container, exit 0; container/API removed). Deployed evidence refreshes
  after publication.
- QA legacy-expiry disposition: leave a pointer with neither league provenance
  nor surviving proof untouched. It cannot authorize ownership and the existing
  expired-proof replacement flow remains usable from a permitted league; the
  regression proves this without inferring scope or deleting another league's
  record. Scoped or contradictory records keep strict cleanup validation.

- Codex review 5174466598 on `a34f3a1`: accepted interrupted league-cleanup
  finding. Metadata removal now atomically records its initiating account and
  resumable cleanup receipt. Bounded cleanup pages commit with their cursor;
  lost responses and retries after ACL removal remain recoverable. Concurrent
  invitation/access writes are fenced by live league metadata. Corrupt reserved
  invitation keys fail closed rather than being deleted or skipped. Focused
  repository, adapter and UI regressions pass. Real local HTTP/DynamoDB acceptance
  confirms pending 503, account binding, owner-only recovery after ACL loss and
  repeated 204; group 8261, peak 222,944 KiB plus capped 512 MiB container, exit 0,
  no remaining workers/container. Refreshed deployed head evidence remains pending.
- Independent security follow-up: deletion recovery now retains a tab-local
  target under the stable account subject (email fallback for legacy sessions),
  not merely the displayed email. Home and missing-league pages expose recovery
  without a league name; DELETE validates the expected account on the actual
  authenticated request to close the preflight/cookie-switch race. No general
  league permission is granted by a deletion receipt.
- QA follow-up removed the original global Deleting message so only the recovery
  panel owns pending and failure feedback. Final focused assertion passed after
  full validation (group 8209, exit 0, remaining []).

- Architecture: league creation could overwrite metadata/grant authority, and
  season creation could retarget a legacy route. Fixed with conditional atomic
  creation and verified exact retries; tests include revoked-ACL recovery denial.
- Architecture: a shared 1,000-byte ID cap rejected valid historical records.
  Removed; full-key transaction budgets remain and ASCII/Unicode regression tests
  pass. Conditional canonical-view conflicts become controlled retryable errors.
- QA: an older picker read could erase an unconfirmed registration retry. Fixed
  with generation ownership and disabled stale-result actions; focused race test
  passes. Alias-closure concern was retracted after verifying existing checks.
- UX: duplicate-name suggestions and accessible distinguishing context were
  missing. Added bounded advisory suggestions and described-by context; no
  automatic identity matching or prohibition on genuinely different people.
- UX: reopening the parent disclosure closed its nested creation journey. Fixed
  without clearing drafts; complete interaction suite passes.
- Codex review 5174249638 on `74830fe` identified a remaining 1,024-character
  historical-ID restriction and stale season options after deletion. Both are
  accepted. IDs now use actual UTF-8 key budgets; migration tests cover 1,025-byte
  IDs and exact/multibyte partition boundaries. Season options update immediately
  on commit even when refresh fails, and stale directory responses are discarded.
- Architecture follow-up found oversized claim-index and game-invitation lookup
  keys. A disjoint bounded claim index preserves linking; impossible game keys
  return controlled errors before SDK reads/writes. Existing ordinary claim keys
  remain unchanged. Both index namespaces are mandatory PR3/PR4 reader coverage.
- UX follow-up: possible-name search now visibly selects All league players,
  preserving draft and keyboard focus rather than leaving a blank selection.
- Real local HTTP/DynamoDB acceptance and isolated deployed Lambda/DynamoDB
  acceptance passed on `74830fe`. The actual operator CLI exercised blocked
  discrepancy, explicit archived restart, committed-response-loss recovery,
  matching inventories and fenced activation. No shared QA data was migrated.
  Current-head deployment/browser evidence must be refreshed after these fixes;
  earlier evidence is not current-head evidence.

## Delivery checkpoint

Local implementation is ready for isolated backend acceptance, not final human
review. Publish only after the remaining evidence is recorded, request exact-head
Codex review and require `review:ready` before implementing PR3.
