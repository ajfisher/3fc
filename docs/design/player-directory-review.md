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
| Existing-player registration, atomic optional team, uncertainty and locks | Repository transactions, frozen-request picker tests, 492 interaction cases | PASS locally |
| League-only private invitation lifecycle | Shared local/Lambda adapter and repository tests, shared invitation UI tests | PASS locally |
| Accessible drafts, suggestions and focus | Nested disclosure regressions, possible-name suggestions, contextual accessible picker actions | PASS locally |
| Historical IDs and canonical compatibility | Root/alias planner cases; getPlayerView preserves original IDs and raw proof records; long ASCII/Unicode read-envelope cases | PASS locally |
| Migration completeness, pause, retry and cutover | Fake-client migration cases; CLI provenance tests; runbook | PASS locally; real backend pending |
| HTTP parsing and privacy headers | Real loopback socket test of local directory/invitation adapters | PASS locally |
| Full repository validation | Serial lint, tests, contracts, build, review-policy/gate tests under 4 GiB guard | PASS locally before final HTTP test addition; focused HTTP test also PASS |
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
- QA: real DynamoDB/operator and deployed acceptance remain required. No evidence
  substitution or gate bypass is accepted.

## Delivery checkpoint

Local implementation is ready for isolated backend acceptance, not final human
review. Publish only after the remaining evidence is recorded, request exact-head
Codex review and require `review:ready` before implementing PR3.
