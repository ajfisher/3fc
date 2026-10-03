# Winter selective import rehearsal evidence

Rehearsed on 2026-10-03 using the existing repository API read paths and a newly
owned disposable AWS DynamoDB table. No source business record or production
record was written. This is rehearsal evidence, not production migration or
release approval.

## Selection and observed results

- Melbourne 3FC / Winter 2026; IDs preserved.
- The incomplete 21 June game was excluded.
- A newly scheduled 4 October game appeared after the initial inventory and was
  included: 10 finished games plus 1 unstarted scheduled game, across 11 sessions.
- 141 goal events; 128 historical profile IDs resolve to 49 canonical players.
- Exactly 2 source admin grants retained, identified by the requested email and
  the uniquely claimed Xavier profile. Other source admin grants were omitted.
- 2 claimed accounts retained their existing ownership. Admin access selection
  does not change player ownership. AJ's optional requested-account choice must
  be settled separately before any production ownership change.
- 1,611 rows imported: 1,107 copied exactly and 504 generated/transformed records
  (membership/directory/claim projections, rotated join lookup codes and game
  metadata, fresh control and reconstructed legacy session addresses).

The private plan digest was
`ca9226515f41bce2457d8d15b0a0885412cb85557d148d2045275edf8dc32b5d`;
its stable source inventory digest was
`275076b663bf85924a03c226320b1838084a677a37794870ab570f0c65a01673`.
The source changed earlier in planning, so these identify only this rehearsal
snapshot; a future cutover must export again under its approved freeze.

## Acceptance evidence

| Criterion | Evidence | Result |
| --- | --- | --- |
| Exact selection and identity preservation | Full imported inventory matched the reviewed plan hash; every original profile resolved through the built repository | PASS |
| Excluded game and extra admins absent | Planner scope assertions, imported inventory equality, repository league ACL read returned exactly 2 grants | PASS |
| Historical scores and player links intact | Offline roster/registration, scorer/assister, own-goal, goal marker, saved tally and winner checks; repository reads of every retained game | PASS |
| Directory and account reuse | All 49 canonical players enumerated through real directory pagination; returning-player discovery traversed both claim-key namespaces for both claimed roots | PASS |
| No accidental shared-table write path | CLI has no production apply/target option; absence-conditioned writes use a new disposable name; unit tests reject shared targets and repository mutation attempts | PASS |
| Cleanup and production unchanged | Successful table deletion followed by confirmed ResourceNotFound; production full inventory hashes matched before/after | PASS |
| Host resource safety | One owned process group; 4 GiB limit; successful rehearsal peak 169,856 KiB; actual exit 0 and no remaining children | PASS |
| Failure cleanup | Two early acceptance-harness failures both deleted their owned tables and verified production unchanged before further work | PASS |
| Focused regressions | `node --test --test-concurrency=1 scripts/tests/season-import.test.mjs`: 15 passed | PASS |
| Related tooling suite | `node --test --test-concurrency=1 scripts/tests/*.test.mjs`: 29 passed | PASS |
| Review tooling | `npm run test:review-gate`: 57 passed; policy validation passed | PASS |
| API acceptance build | `node node_modules/typescript/bin/tsc --build api/tsconfig.json --force`: exit 0; peak 450,592 KiB; no remaining children | PASS |

The final post-review rehearsal reproduced the same plan digest and passed all
repository checks with the stricter reverse-membership guard. Its temporary resource was
`3fc-import-rehearsal-a1db353f-fedf-45b4-b630-6e01daf3b5cf`; it is deleted.
Private mode 0600 files retain the plan, output report and ownership evidence
outside the repository. Source records, emails, account subjects and bearer
codes are not committed.

## Findings and disposition

- Raw authentication sessions share the `session` entity type with match days.
  The read filter now excludes all `AUTH_` partitions before decoding business
  records. A focused regression verifies the boundary.
- Older games predate league-scoped session rows. An unrelated test season also
  owns QA's global 2 August session mirror. The planner reconstructs Winter's
  missing destination addresses from its proven season-owned records; the
  unrelated QA row remains untouched. Cross-owner/unknown-type conflicts remain
  blocking. The compatibility test proves both reconstruction and rejection.
- Acceptance initially blocked cached BatchGet reads, then exceeded returning
  discovery's 20-row limit. Both were harness defects, investigated after actual
  process exit and confirmed table cleanup. Targeted tests then the complete
  focused file passed before each new disposable rehearsal. The final run passed
  all checks, including both claim namespaces.
- Advisory review found that the initial cross-scope guard checked only game
  memberships. It now checks league and season reverse memberships and league
  creation provenance as well, including aliases and roots. A focused regression
  demonstrates foreign references blocking even without a foreign game index.
- Advisory review also corrected the architecture declaration: INV-009 concerns
  cookies, secure flags, CSP and headers and is unaffected by this operator tool.
  Authentication-record exclusion is documented as a separate scope/privacy
  safeguard rather than evidence for that invariant.
- No findings were rejected. The existing runtime API was not changed to make
  the rehearsal pass.

## Limits and next execution boundary

This exercises repository/database paths, not browser rendering, email delivery,
real production sign-in or the exact deployed Lambda package. The API source
baseline was `9995dba2a67840db5822441b8a4b6fcead41c878`; runtime source is unchanged
in this PR. Production's own identity control and migration receipts remain
untouched. The rehearsal tool intentionally cannot perform the final import.

See the [runbook](../runbooks/season-import-rehearsal.md) for selection rules,
privacy, cleanup, failure handling and the separately required production
execution plan. Before that later step, settle player-account ownership,
re-inventory new games, freeze writers, obtain a stable export and backup
evidence, and review production checkpoint/rollback and certification behaviour.
